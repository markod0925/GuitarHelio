#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  evaluateCaseTelemetry,
  evaluateRowsForConfig,
  type AlgorithmName,
  type ValidatorAggregate,
  type ValidatorCaseTelemetry,
  type ValidatorDecisionConfig
} from './gameplay_validator_core';
import {
  evaluatePolyphonicTelemetryForConfig,
  evaluateNoteSetWindow,
  MONO_ACTIVATION_GATE_POLICY,
  MONO_NOTE_SET_POLICY,
  type ActivationGatePolicy,
  type NoteSetAggregationPolicy,
  type NoteSetMetrics,
  type PolyphonicWindowTelemetry
} from './gameplay_validator_polyphonic';
import { formatPct, roundNumber } from './shared';

type PolyResultsDoc = {
  generatedAtIso: string;
  selectedPairCount: number;
  totalPairCount: number;
  decisionConfig: ValidatorDecisionConfig;
  noteDecisionConfigId: string;
  noteSetPolicy: NoteSetAggregationPolicy;
  aggregationPolicyId: string;
  activationGatePolicy: ActivationGatePolicy;
  activationGatePolicyId: string;
  windowCardinalitySummary: {
    monoWindows: number;
    polyWindows: number;
  };
  windowConfig: {
    maxWindowsPerFile: number | null;
    maxFramesPerWindow: number;
  };
  aggregates: Record<AlgorithmName, Record<'solo' | 'comp' | 'combined', NoteSetMetrics>>;
};

type PolyDiagnosticsDoc = {
  windowTelemetry: PolyphonicWindowTelemetry[];
};

type MonoResultsDoc = {
  generatedAtIso: string;
  decisionConfig: ValidatorDecisionConfig;
  noteDecisionConfigId: string;
  aggregationPolicyId: string;
  activationGatePolicyId: string;
  aggregates: Record<AlgorithmName, ValidatorAggregate>;
};

type MonoDiagnosticsDoc = {
  caseTelemetry: ValidatorCaseTelemetry[];
};

type RuntimeStats = {
  count: number;
  avg: number;
  p95: number;
  max: number;
};

type DecisionSummary = {
  tar: number;
  strictFar: number;
  noteMismatchFar: number;
  positionOnlyFar: number;
  lowStringTar: number;
  lowStringFar: number;
  positives: number;
  negatives: number;
  trueAccept: number;
  falseAccept: number;
};

const POLY_RESULTS_PATH = 'analysis/gameplay_validator_benchmark_poly/results.json';
const POLY_DIAGNOSTICS_PATH = 'analysis/gameplay_validator_benchmark_poly/diagnostics.json';
const POLY_SWEEP_PATH = 'analysis/gameplay_validator_benchmark_poly/sweep/leaderboard.json';
const MONO_RESULTS_PATH = 'analysis/gameplay_validator_benchmark/results.json';
const MONO_DIAGNOSTICS_PATH = 'analysis/gameplay_validator_benchmark/diagnostics.json';
const MONO_SWEEP_PATH = 'analysis/gameplay_validator_benchmark/sweep/leaderboard.json';

const OUT_POLY_SUMMARY = 'analysis/gameplay_validator_benchmark_poly/final_poly_summary.md';
const OUT_POLY_SWEEP = 'analysis/gameplay_validator_benchmark_poly/final_poly_sweep_summary.md';
const OUT_ANDROID_SUMMARY = 'analysis/gameplay_validator_benchmark/final_android_summary.md';
const OUT_RUNTIME = 'analysis/gameplay_validator_benchmark_poly/final_runtime_report.md';
const OUT_RECOMMENDATION = 'analysis/gameplay_validator_final_recommendation.md';

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const polyResults = await loadJson<PolyResultsDoc>(path.join(repoRoot, POLY_RESULTS_PATH));
  const polyDiagnostics = await loadJson<PolyDiagnosticsDoc>(path.join(repoRoot, POLY_DIAGNOSTICS_PATH));
  const polySweep = await loadJson<any>(path.join(repoRoot, POLY_SWEEP_PATH));
  const monoResults = await loadJson<MonoResultsDoc>(path.join(repoRoot, MONO_RESULTS_PATH));
  const monoDiagnostics = await loadJson<MonoDiagnosticsDoc>(path.join(repoRoot, MONO_DIAGNOSTICS_PATH));
  const monoSweep = await loadJson<any>(path.join(repoRoot, MONO_SWEEP_PATH));

  const sweepBest = (
    polySweep?.best?.gameplayRecallEpsilon?.combined ??
    polySweep?.best?.gameplayLexicographic?.combined ??
    polySweep?.best?.strict?.combined ??
    null
  ) as { decisionConfig: ValidatorDecisionConfig; noteSetPolicy: NoteSetAggregationPolicy; activationGatePolicy: ActivationGatePolicy } | null;

  const finalDecisionConfig = sweepBest?.decisionConfig ?? polyResults.decisionConfig;
  const finalNoteSetPolicy = sweepBest?.noteSetPolicy ?? polyResults.noteSetPolicy;
  const finalGatePolicy = sweepBest?.activationGatePolicy ?? polyResults.activationGatePolicy;
  const recallEpsilon = Number(polySweep?.rankingModes?.gameplayRecallEpsilon?.stableRecallEpsilon ?? 0.01);
  const finalPolyEvaluation = evaluatePolyphonicTelemetryForConfig({
    windowTelemetry: polyDiagnostics.windowTelemetry,
    decisionConfig: finalDecisionConfig,
    noteSetPolicy: finalNoteSetPolicy,
    activationGatePolicy: finalGatePolicy,
    algorithms: ['MASP', 'spectral_game_runtime_unified_v3']
  });

  const monoSpectralCases = monoDiagnostics.caseTelemetry.filter((row) => row.algorithm === 'spectral_game_runtime_unified_v3');
  const canonicalMonoConfig = selectCanonicalMonoConfig(monoSweep, monoResults.decisionConfig);
  const monoCanonicalEval = evaluateRowsForConfig(
    monoSpectralCases,
    canonicalMonoConfig.config,
    ['spectral_game_runtime_unified_v3']
  );
  const monoCanonical = monoCanonicalEval.aggregates.spectral_game_runtime_unified_v3;
  const monoGateEval = evaluateMonoGateStack(monoSpectralCases, finalDecisionConfig, finalNoteSetPolicy, finalGatePolicy);
  const monoCurrentDefault = monoResults.aggregates.spectral_game_runtime_unified_v3;

  const polyRuntime = measurePolyRuntime(
    polyDiagnostics.windowTelemetry,
    finalDecisionConfig,
    finalNoteSetPolicy,
    finalGatePolicy
  );
  const monoRuntime = measureMonoRuntime(
    monoSpectralCases,
    finalDecisionConfig,
    finalNoteSetPolicy,
    finalGatePolicy
  );

  await fs.writeFile(path.join(repoRoot, OUT_POLY_SUMMARY), buildPolySummary(polyResults, finalPolyEvaluation.aggregates, finalDecisionConfig, finalNoteSetPolicy, finalGatePolicy), 'utf8');
  await fs.writeFile(path.join(repoRoot, OUT_POLY_SWEEP), buildPolySweepSummary(polySweep, recallEpsilon), 'utf8');
  await fs.writeFile(
    path.join(repoRoot, OUT_ANDROID_SUMMARY),
    buildAndroidSummary(
      monoCanonical,
      canonicalMonoConfig.config,
      canonicalMonoConfig.source,
      monoCurrentDefault,
      monoResults.decisionConfig,
      monoResults,
      monoGateEval.summary,
      finalDecisionConfig,
      finalNoteSetPolicy,
      finalGatePolicy
    ),
    'utf8'
  );
  await fs.writeFile(path.join(repoRoot, OUT_RUNTIME), buildRuntimeSummary(polyRuntime, monoRuntime), 'utf8');
  await fs.writeFile(
    path.join(repoRoot, OUT_RECOMMENDATION),
    buildFinalRecommendation(
      finalPolyEvaluation.aggregates,
      monoCanonical,
      canonicalMonoConfig.config,
      monoGateEval.summary,
      polyRuntime,
      monoRuntime,
      finalDecisionConfig,
      finalNoteSetPolicy,
      finalGatePolicy
    ),
    'utf8'
  );

  console.log('[gameplay-validator-final] wrote consolidated reports');
}

async function loadJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function evaluateMonoGateStack(
  cases: ValidatorCaseTelemetry[],
  decisionConfig: ValidatorDecisionConfig,
  noteSetPolicy: NoteSetAggregationPolicy,
  gatePolicy: ActivationGatePolicy
): { summary: DecisionSummary } {
  const decisions: Array<{
    expectedAccept: boolean;
    accept: boolean;
    mismatchType: string;
    sourceStringBand: 'low' | 'mid' | 'high';
  }> = [];

  for (const telemetry of cases) {
    const row = evaluateCaseTelemetry(telemetry, decisionConfig);
    const rawDetectedMidis = uniqueSorted(
      telemetry.frames
        .filter((frame) => frame.detectorAccepted && typeof frame.detectedMidi === 'number' && Number.isFinite(frame.detectedMidi))
        .map((frame) => Math.round(frame.detectedMidi as number))
    );
    const rawDetectionMaxConfidence = maxOrNull(telemetry.frames.map((frame) => frame.detectorConfidence));

    const window = evaluateNoteSetWindow({
      algorithm: telemetry.algorithm,
      noteDecisionConfigId: decisionConfig.id,
      windowId: telemetry.caseId,
      fileId: telemetry.sourceFileId,
      wavRelativePath: telemetry.sourceRelativeFilePath,
      subset: 'solo',
      startSec: 0,
      endSec: 0.4,
      expectedMidis: [telemetry.expectedMidi],
      expectedDominantMidis: [telemetry.expectedMidi],
      expectedSegmentCount: 1,
      expectedActiveRatio: 1,
      stableSetRatio: 1,
      transitionOverlapRatio: 0,
      noteSetChangeCount: 0,
      baseWindowCategory: 'single_note_window',
      windowCategory: 'single_note_window',
      isStableWindow: true,
      rawDetectedMidis,
      rawDetectionMaxConfidence,
      rawDetectionFrameRatio: ratio(telemetry.frames.map((frame) => frame.detectorAccepted)),
      perNoteRows: [row],
      policy: noteSetPolicy,
      activationGatePolicy: gatePolicy
    });

    decisions.push({
      expectedAccept: telemetry.expectedAccept,
      accept: window.postGateAccept,
      mismatchType: telemetry.mismatchType,
      sourceStringBand: telemetry.sourceStringBand
    });
  }

  return { summary: summarizeDecisions(decisions) };
}

function measurePolyRuntime(
  windows: PolyphonicWindowTelemetry[],
  decisionConfig: ValidatorDecisionConfig,
  noteSetPolicy: NoteSetAggregationPolicy,
  gatePolicy: ActivationGatePolicy
): {
  windowCount: number;
  caseCount: number;
  frameCount: number;
  detectorMs: RuntimeStats;
  validatorMs: RuntimeStats;
  gateOverheadMs: RuntimeStats;
  totalWindowMs: RuntimeStats;
  validatorOverDetectorPct: number;
  gateOverValidatorPct: number;
} {
  const spectralWindows = windows.filter((window) => window.algorithm === 'spectral_game_runtime_unified_v3');
  const detectorFrameMs: number[] = [];
  const validatorCaseMs: number[] = [];
  const gateOverheadWindowMs: number[] = [];
  const totalWindowMs: number[] = [];

  let caseCount = 0;
  let frameCount = 0;
  for (const window of spectralWindows) {
    const perNoteRows = [];
    let detectorThisWindow = 0;
    let validatorThisWindow = 0;

    for (const telemetry of window.perNoteTelemetry) {
      caseCount += 1;
      frameCount += telemetry.frames.length;
      for (const frame of telemetry.frames) {
        detectorFrameMs.push(frame.runtimeMs);
        detectorThisWindow += frame.runtimeMs;
      }

      const startedAt = performance.now();
      const row = evaluateCaseTelemetry(telemetry, decisionConfig);
      const elapsed = performance.now() - startedAt;
      validatorCaseMs.push(elapsed);
      validatorThisWindow += elapsed;
      perNoteRows.push(row);
    }

    const gateOff: ActivationGatePolicy = { ...gatePolicy, gateEnabled: false, id: `${gatePolicy.id}__off_for_timing` };
    const preGateStartedAt = performance.now();
    evaluateNoteSetWindow({
      algorithm: window.algorithm,
      noteDecisionConfigId: decisionConfig.id,
      windowId: window.windowId,
      fileId: window.fileId,
      wavRelativePath: window.wavRelativePath,
      subset: window.subset,
      startSec: window.startSec,
      endSec: window.endSec,
      expectedMidis: window.expectedMidis,
      expectedDominantMidis: window.expectedDominantMidis,
      expectedSegmentCount: window.expectedSegmentCount,
      expectedActiveRatio: window.expectedActiveRatio,
      stableSetRatio: window.stableSetRatio,
      transitionOverlapRatio: window.transitionOverlapRatio,
      noteSetChangeCount: window.noteSetChangeCount,
      baseWindowCategory: window.baseWindowCategory,
      windowCategory: window.windowCategory,
      isStableWindow: window.isStableWindow,
      rawDetectedMidis: window.rawDetectedMidis,
      rawDetectionMaxConfidence: window.rawDetectionMaxConfidence,
      rawDetectionFrameRatio: window.rawDetectionFrameRatio,
      perNoteRows,
      policy: noteSetPolicy,
      activationGatePolicy: gateOff
    });
    const preGateElapsed = performance.now() - preGateStartedAt;

    const withGateStartedAt = performance.now();
    evaluateNoteSetWindow({
      algorithm: window.algorithm,
      noteDecisionConfigId: decisionConfig.id,
      windowId: window.windowId,
      fileId: window.fileId,
      wavRelativePath: window.wavRelativePath,
      subset: window.subset,
      startSec: window.startSec,
      endSec: window.endSec,
      expectedMidis: window.expectedMidis,
      expectedDominantMidis: window.expectedDominantMidis,
      expectedSegmentCount: window.expectedSegmentCount,
      expectedActiveRatio: window.expectedActiveRatio,
      stableSetRatio: window.stableSetRatio,
      transitionOverlapRatio: window.transitionOverlapRatio,
      noteSetChangeCount: window.noteSetChangeCount,
      baseWindowCategory: window.baseWindowCategory,
      windowCategory: window.windowCategory,
      isStableWindow: window.isStableWindow,
      rawDetectedMidis: window.rawDetectedMidis,
      rawDetectionMaxConfidence: window.rawDetectionMaxConfidence,
      rawDetectionFrameRatio: window.rawDetectionFrameRatio,
      perNoteRows,
      policy: noteSetPolicy,
      activationGatePolicy: gatePolicy
    });
    const withGateElapsed = performance.now() - withGateStartedAt;
    const gateOverhead = Math.max(0, withGateElapsed - preGateElapsed);

    gateOverheadWindowMs.push(gateOverhead);
    totalWindowMs.push(detectorThisWindow + validatorThisWindow + withGateElapsed);
  }

  const detector = stats(detectorFrameMs);
  const validator = stats(validatorCaseMs);
  const gate = stats(gateOverheadWindowMs);
  const total = stats(totalWindowMs);
  const detectorWindowAvg = spectralWindows.length > 0
    ? totalWindowMs.reduce((sum, value) => sum + value, 0) / spectralWindows.length
    : 0;
  const validatorWindowAvg = spectralWindows.length > 0
    ? validatorCaseMs.reduce((sum, value) => sum + value, 0) / spectralWindows.length
    : 0;

  return {
    windowCount: spectralWindows.length,
    caseCount,
    frameCount,
    detectorMs: detector,
    validatorMs: validator,
    gateOverheadMs: gate,
    totalWindowMs: total,
    validatorOverDetectorPct: detectorWindowAvg > 0 ? (validatorWindowAvg / detectorWindowAvg) * 100 : 0,
    gateOverValidatorPct: validator.avg > 0 ? (gate.avg / validator.avg) * 100 : 0
  };
}

function measureMonoRuntime(
  cases: ValidatorCaseTelemetry[],
  decisionConfig: ValidatorDecisionConfig,
  noteSetPolicy: NoteSetAggregationPolicy,
  gatePolicy: ActivationGatePolicy
): {
  caseCount: number;
  frameCount: number;
  detectorMs: RuntimeStats;
  validatorMs: RuntimeStats;
  gateOverheadMs: RuntimeStats;
  totalCaseMs: RuntimeStats;
} {
  const detectorFrameMs: number[] = [];
  const validatorCaseMs: number[] = [];
  const gateOverheadCaseMs: number[] = [];
  const totalCaseMs: number[] = [];

  let frameCount = 0;
  for (const telemetry of cases) {
    let detectorThisCase = 0;
    frameCount += telemetry.frames.length;
    for (const frame of telemetry.frames) {
      detectorFrameMs.push(frame.runtimeMs);
      detectorThisCase += frame.runtimeMs;
    }

    const startedAt = performance.now();
    const row = evaluateCaseTelemetry(telemetry, decisionConfig);
    const validatorElapsed = performance.now() - startedAt;
    validatorCaseMs.push(validatorElapsed);

    const rawDetectedMidis = uniqueSorted(
      telemetry.frames
        .filter((frame) => frame.detectorAccepted && typeof frame.detectedMidi === 'number' && Number.isFinite(frame.detectedMidi))
        .map((frame) => Math.round(frame.detectedMidi as number))
    );
    const rawDetectionMaxConfidence = maxOrNull(telemetry.frames.map((frame) => frame.detectorConfidence));

    const gateOff: ActivationGatePolicy = { ...gatePolicy, gateEnabled: false, id: `${gatePolicy.id}__off_for_timing` };
    const preGateStartedAt = performance.now();
    evaluateNoteSetWindow({
      algorithm: telemetry.algorithm,
      noteDecisionConfigId: decisionConfig.id,
      windowId: telemetry.caseId,
      fileId: telemetry.sourceFileId,
      wavRelativePath: telemetry.sourceRelativeFilePath,
      subset: 'solo',
      startSec: 0,
      endSec: 0.4,
      expectedMidis: [telemetry.expectedMidi],
      expectedDominantMidis: [telemetry.expectedMidi],
      expectedSegmentCount: 1,
      expectedActiveRatio: 1,
      stableSetRatio: 1,
      transitionOverlapRatio: 0,
      noteSetChangeCount: 0,
      baseWindowCategory: 'single_note_window',
      windowCategory: 'single_note_window',
      isStableWindow: true,
      rawDetectedMidis,
      rawDetectionMaxConfidence,
      rawDetectionFrameRatio: ratio(telemetry.frames.map((frame) => frame.detectorAccepted)),
      perNoteRows: [row],
      policy: noteSetPolicy,
      activationGatePolicy: gateOff
    });
    const preGateElapsed = performance.now() - preGateStartedAt;

    const withGateStartedAt = performance.now();
    evaluateNoteSetWindow({
      algorithm: telemetry.algorithm,
      noteDecisionConfigId: decisionConfig.id,
      windowId: telemetry.caseId,
      fileId: telemetry.sourceFileId,
      wavRelativePath: telemetry.sourceRelativeFilePath,
      subset: 'solo',
      startSec: 0,
      endSec: 0.4,
      expectedMidis: [telemetry.expectedMidi],
      expectedDominantMidis: [telemetry.expectedMidi],
      expectedSegmentCount: 1,
      expectedActiveRatio: 1,
      stableSetRatio: 1,
      transitionOverlapRatio: 0,
      noteSetChangeCount: 0,
      baseWindowCategory: 'single_note_window',
      windowCategory: 'single_note_window',
      isStableWindow: true,
      rawDetectedMidis,
      rawDetectionMaxConfidence,
      rawDetectionFrameRatio: ratio(telemetry.frames.map((frame) => frame.detectorAccepted)),
      perNoteRows: [row],
      policy: noteSetPolicy,
      activationGatePolicy: gatePolicy
    });
    const withGateElapsed = performance.now() - withGateStartedAt;
    const gateOverhead = Math.max(0, withGateElapsed - preGateElapsed);

    gateOverheadCaseMs.push(gateOverhead);
    totalCaseMs.push(detectorThisCase + validatorElapsed + withGateElapsed);
  }

  return {
    caseCount: cases.length,
    frameCount,
    detectorMs: stats(detectorFrameMs),
    validatorMs: stats(validatorCaseMs),
    gateOverheadMs: stats(gateOverheadCaseMs),
    totalCaseMs: stats(totalCaseMs)
  };
}

function summarizeDecisions(rows: Array<{
  expectedAccept: boolean;
  accept: boolean;
  mismatchType: string;
  sourceStringBand: 'low' | 'mid' | 'high';
}>): DecisionSummary {
  const positives = rows.filter((row) => row.expectedAccept);
  const negatives = rows.filter((row) => !row.expectedAccept);
  const trueAccept = positives.filter((row) => row.accept).length;
  const falseAccept = negatives.filter((row) => row.accept).length;

  const noteMismatchNegatives = negatives.filter((row) => row.mismatchType !== 'same_pitch_alt_string');
  const noteMismatchFalseAccept = noteMismatchNegatives.filter((row) => row.accept).length;
  const positionOnlyNegatives = negatives.filter((row) => row.mismatchType === 'same_pitch_alt_string');
  const positionOnlyFalseAccept = positionOnlyNegatives.filter((row) => row.accept).length;

  const lowPositives = positives.filter((row) => row.sourceStringBand === 'low');
  const lowNegatives = negatives.filter((row) => row.sourceStringBand === 'low');

  return {
    tar: positives.length > 0 ? trueAccept / positives.length : 0,
    strictFar: negatives.length > 0 ? falseAccept / negatives.length : 0,
    noteMismatchFar: noteMismatchNegatives.length > 0 ? noteMismatchFalseAccept / noteMismatchNegatives.length : 0,
    positionOnlyFar: positionOnlyNegatives.length > 0 ? positionOnlyFalseAccept / positionOnlyNegatives.length : 0,
    lowStringTar: lowPositives.length > 0 ? lowPositives.filter((row) => row.accept).length / lowPositives.length : 0,
    lowStringFar: lowNegatives.length > 0 ? lowNegatives.filter((row) => row.accept).length / lowNegatives.length : 0,
    positives: positives.length,
    negatives: negatives.length,
    trueAccept,
    falseAccept
  };
}

function buildPolySummary(
  poly: PolyResultsDoc,
  aggregates: Record<AlgorithmName, Record<'solo' | 'comp' | 'unknown' | 'combined', NoteSetMetrics>>,
  decisionConfig: ValidatorDecisionConfig,
  noteSetPolicy: NoteSetAggregationPolicy,
  gatePolicy: ActivationGatePolicy
): string {
  const spectral = aggregates.spectral_game_runtime_unified_v3;
  const lines: string[] = [
    '# Final Polyphonic Summary (Full Corpus Pass)',
    '',
    `- Generated from: \`${POLY_RESULTS_PATH}\``,
    `- Poly files evaluated: ${poly.selectedPairCount}/${poly.totalPairCount}`,
    `- Window cap per file: ${poly.windowConfig.maxWindowsPerFile ?? 'none'}`,
    `- Window cardinality summary: mono=${poly.windowCardinalitySummary.monoWindows}, poly=${poly.windowCardinalitySummary.polyWindows}.`,
    `- Decision config used for final stack: \`${decisionConfig.id}\``,
    `- Note-set policy used for final stack: \`${noteSetPolicy.id}\``,
    `- Activation gate policy used for final stack: \`${gatePolicy.id}\``,
    `- Poly result stack ids: note_decision_config_id=\`${poly.noteDecisionConfigId}\`, aggregation_policy_id=\`${poly.aggregationPolicyId}\`, activation_gate_policy_id=\`${poly.activationGatePolicyId}\`.`,
    '',
    '## Spectral Metrics by Bucket (Pre vs Post Gate)',
    '',
    '| Bucket | Recall pre | Recall post | Precision pre | Precision post | Stable recall pre | Stable recall post | Empty FAR pre | Empty FAR post | Transition pre | Transition post | Extra pre | Extra post | Exact pre | Exact post |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];

  for (const bucket of ['solo', 'comp', 'combined'] as const) {
    const m = spectral[bucket];
    lines.push(`| ${bucket} | ${formatMetricPct(m.preGateExpectedNoteRecall)} | ${formatMetricPct(m.postGateExpectedNoteRecall)} | ${formatMetricPct(m.preGateExpectedNotePrecision)} | ${formatMetricPct(m.postGateExpectedNotePrecision)} | ${formatMetricPct(m.preGateStableNonEmptyExpectedNoteRecall)} | ${formatMetricPct(m.postGateStableNonEmptyExpectedNoteRecall)} | ${formatMetricPct(m.preGateEmptyWindowFalseAcceptRate)} | ${formatMetricPct(m.postGateEmptyWindowFalseAcceptRate)} | ${formatMetricPct(m.preGateTransitionWindowAcceptRate)} | ${formatMetricPct(m.postGateTransitionWindowAcceptRate)} | ${formatMetricPct(m.preGateExtraNoteRate)} | ${formatMetricPct(m.postGateExtraNoteRate)} | ${formatMetricPct(m.preGateExactSetRate)} | ${formatMetricPct(m.postGateExactSetRate)} |`);
  }

  lines.push('', '## Set-Relation Behavior (Spectral, Combined Post-Gate)', '');
  const combined = spectral.combined;
  lines.push(`- Exact-set rate: ${formatMetricPct(combined.postGateExactSetRate)}`);
  lines.push(`- Superset rate: ${formatMetricPct(combined.postGateSupersetRate)}`);
  lines.push(`- Subset rate: ${formatMetricPct(combined.stableNonEmptySubsetRate)}`);
  lines.push(`- Stable superset accept rate: ${formatMetricPct(combined.postGateStableNonEmptySupersetAcceptRate)}`);
  lines.push(`- Gate suppressed rate: ${formatMetricPct(combined.gateSuppressedRate)}`);
  lines.push('');

  return lines.join('\n');
}

function buildPolySweepSummary(sweepDoc: any, recallEpsilon: number): string {
  const strict = sweepDoc?.best?.strict?.combined ?? null;
  const legacy = sweepDoc?.best?.gameplayLexicographic?.combined ?? null;
  const epsilon = sweepDoc?.best?.gameplayRecallEpsilon?.combined ?? null;
  const top = Array.isArray(sweepDoc?.leaderboards?.gameplayRecallEpsilon?.combined)
    ? sweepDoc.leaderboards.gameplayRecallEpsilon.combined.slice(0, 10)
    : [];

  const lines: string[] = [
    '# Final Poly Sweep Summary',
    '',
    `- Source: \`${POLY_SWEEP_PATH}\``,
    `- Gameplay recall epsilon: ${roundNumber(recallEpsilon, 4).toFixed(4)}`,
    `- Ranking reports always surface decision-config, note-set policy, and activation-gate policy ids explicitly.`,
    '',
    '## Combined Winners',
    '',
    `- Strict symbolic winner: ${describeWinner(strict)}`,
    `- Gameplay legacy lexicographic winner: ${describeWinner(legacy)}`,
    `- Gameplay recall-epsilon winner: ${describeWinner(epsilon)}`,
    '',
    '## Gameplay Recall-Epsilon Top 10 (Combined)',
    '',
    '| Rank | Decision config | Note-set policy | Activation gate | Avg stable recall | Avg empty FAR | Avg transition accept | Avg extra rate | Avg exact rate | Avg runtime (ms) |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];

  for (const row of top) {
    lines.push(`| ${row.rank} | ${row.decisionConfig.id} | ${row.noteSetPolicy.id} | ${row.activationGatePolicy.id} | ${formatMetricPct(row.gameplay.avgStableRecall)} | ${formatMetricPct(row.gameplay.avgEmptyFar)} | ${formatMetricPct(row.gameplay.avgTransitionAccept)} | ${formatMetricPct(row.gameplay.avgExtraNoteRate)} | ${formatMetricPct(row.gameplay.avgExactRate)} | ${formatMetricNumber(row.gameplay.avgRuntimeMs, 3)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildAndroidSummary(
  canonicalMono: ValidatorAggregate,
  canonicalMonoConfig: ValidatorDecisionConfig,
  canonicalMonoSource: string,
  currentMonoDefault: ValidatorAggregate,
  currentMonoDefaultConfig: ValidatorDecisionConfig,
  currentMonoResults: MonoResultsDoc,
  gateSummary: DecisionSummary,
  decisionConfig: ValidatorDecisionConfig,
  noteSetPolicy: NoteSetAggregationPolicy,
  gatePolicy: ActivationGatePolicy
): string {
  const lines: string[] = [
    '# Final Android Mono-Note Summary (234 Takes)',
    '',
    `- Source: \`${MONO_RESULTS_PATH}\` and \`${MONO_DIAGNOSTICS_PATH}\``,
    `- Canonical mono note decision: \`${canonicalMonoConfig.id}\` (\`${canonicalMonoSource}\`)`,
    `- Canonical mono aggregation policy: \`${MONO_NOTE_SET_POLICY.id}\` (cardinality 1)`,
    `- Canonical mono activation gate policy: \`${MONO_ACTIVATION_GATE_POLICY.id}\` (disabled)`,
    `- Current mono benchmark default config: \`${currentMonoDefaultConfig.id}\``,
    `- Current mono benchmark stack ids: note_decision_config_id=\`${currentMonoResults.noteDecisionConfigId}\`, aggregation_policy_id=\`${currentMonoResults.aggregationPolicyId}\`, activation_gate_policy_id=\`${currentMonoResults.activationGatePolicyId}\`.`,
    `- Poly-derived final stack applied in mono stress-check: \`${decisionConfig.id}\` + \`${noteSetPolicy.id}\` + \`${gatePolicy.id}\``,
    '',
    '## Decision-Only Mono Metrics (Same 234 Cases)',
    '',
    '| Metric | Canonical mono config | Current mono default config | Delta (default-canonical) |',
    '| --- | ---: | ---: | ---: |',
    `| TAR | ${formatPct(canonicalMono.tar)} | ${formatPct(currentMonoDefault.tar)} | ${formatDelta(currentMonoDefault.tar - canonicalMono.tar)} |`,
    `| Strict FAR | ${formatPct(canonicalMono.strictFar)} | ${formatPct(currentMonoDefault.strictFar)} | ${formatDelta(currentMonoDefault.strictFar - canonicalMono.strictFar)} |`,
    `| Note-mismatch FAR | ${formatPct(canonicalMono.noteMismatchFar)} | ${formatPct(currentMonoDefault.noteMismatchFar)} | ${formatDelta(currentMonoDefault.noteMismatchFar - canonicalMono.noteMismatchFar)} |`,
    `| Position-only FAR | ${formatPct(canonicalMono.positionOnlyFar)} | ${formatPct(currentMonoDefault.positionOnlyFar)} | ${formatDelta(currentMonoDefault.positionOnlyFar - canonicalMono.positionOnlyFar)} |`,
    `| Low-string TAR | ${formatPct(canonicalMono.lowStringTar)} | ${formatPct(currentMonoDefault.lowStringTar)} | ${formatDelta(currentMonoDefault.lowStringTar - canonicalMono.lowStringTar)} |`,
    `| Low-string FAR | ${formatPct(canonicalMono.lowStringFar)} | ${formatPct(currentMonoDefault.lowStringFar)} | ${formatDelta(currentMonoDefault.lowStringFar - canonicalMono.lowStringFar)} |`,
    '',
    '## Poly-Derived Final Stack Stress Check on Mono',
    '',
    '| Metric | Canonical mono config (decision-only) | Poly-derived final stack (gate) | Delta (final-canonical) |',
    '| --- | ---: | ---: | ---: |',
    `| TAR | ${formatPct(canonicalMono.tar)} | ${formatPct(gateSummary.tar)} | ${formatDelta(gateSummary.tar - canonicalMono.tar)} |`,
    `| Strict FAR | ${formatPct(canonicalMono.strictFar)} | ${formatPct(gateSummary.strictFar)} | ${formatDelta(gateSummary.strictFar - canonicalMono.strictFar)} |`,
    `| Note-mismatch FAR | ${formatPct(canonicalMono.noteMismatchFar)} | ${formatPct(gateSummary.noteMismatchFar)} | ${formatDelta(gateSummary.noteMismatchFar - canonicalMono.noteMismatchFar)} |`,
    `| Position-only FAR | ${formatPct(canonicalMono.positionOnlyFar)} | ${formatPct(gateSummary.positionOnlyFar)} | ${formatDelta(gateSummary.positionOnlyFar - canonicalMono.positionOnlyFar)} |`,
    `| Low-string TAR | ${formatPct(canonicalMono.lowStringTar)} | ${formatPct(gateSummary.lowStringTar)} | ${formatDelta(gateSummary.lowStringTar - canonicalMono.lowStringTar)} |`,
    `| Low-string FAR | ${formatPct(canonicalMono.lowStringFar)} | ${formatPct(gateSummary.lowStringFar)} | ${formatDelta(gateSummary.lowStringFar - canonicalMono.lowStringFar)} |`,
    '',
    '## Interpretation',
    '',
    '- Canonical mono metrics are computed with the mono sweep winner decision config plus the mono cardinality-1 aggregation policy and gate-off policy.',
    '- Poly-derived final stack metrics are a cross-family stress-check and are not the canonical Android mono benchmark output.',
    '- The explicit config lines above are meant to prevent silent comparison between incompatible mono and poly-derived paths.',
    ''
  ];
  return lines.join('\n');
}

function buildRuntimeSummary(
  polyRuntime: ReturnType<typeof measurePolyRuntime>,
  monoRuntime: ReturnType<typeof measureMonoRuntime>
): string {
  const lines: string[] = [
    '# Final Runtime Feasibility Report',
    '',
    '## Polyphonic Path (Spectral Final Stack)',
    '',
    `- Windows evaluated (spectral): ${polyRuntime.windowCount}`,
    `- Per-note cases evaluated: ${polyRuntime.caseCount}`,
    `- Frames measured: ${polyRuntime.frameCount}`,
    '',
    '| Component | Avg (ms) | P95 (ms) | Max (ms) | Samples |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| Spectral detector (frame) | ${formatMetricNumber(polyRuntime.detectorMs.avg, 4)} | ${formatMetricNumber(polyRuntime.detectorMs.p95, 4)} | ${formatMetricNumber(polyRuntime.detectorMs.max, 4)} | ${polyRuntime.detectorMs.count} |`,
    `| Competitor-aware validator (case) | ${formatMetricNumber(polyRuntime.validatorMs.avg, 4)} | ${formatMetricNumber(polyRuntime.validatorMs.p95, 4)} | ${formatMetricNumber(polyRuntime.validatorMs.max, 4)} | ${polyRuntime.validatorMs.count} |`,
    `| Post-validator gate overhead (window, enabled-minus-disabled) | ${formatMetricNumber(polyRuntime.gateOverheadMs.avg, 4)} | ${formatMetricNumber(polyRuntime.gateOverheadMs.p95, 4)} | ${formatMetricNumber(polyRuntime.gateOverheadMs.max, 4)} | ${polyRuntime.gateOverheadMs.count} |`,
    `| Total estimated stack cost (window) | ${formatMetricNumber(polyRuntime.totalWindowMs.avg, 4)} | ${formatMetricNumber(polyRuntime.totalWindowMs.p95, 4)} | ${formatMetricNumber(polyRuntime.totalWindowMs.max, 4)} | ${polyRuntime.totalWindowMs.count} |`,
    '',
    `- Relative validator overhead vs detector (avg): ${formatPct(polyRuntime.validatorOverDetectorPct / 100)}`,
    `- Relative gate overhead vs validator (avg): ${formatPct(polyRuntime.gateOverValidatorPct / 100)}`,
    '',
    '## Android Mono Path (Spectral Final Stack)',
    '',
    `- Cases evaluated: ${monoRuntime.caseCount}`,
    `- Frames measured: ${monoRuntime.frameCount}`,
    '',
    '| Component | Avg (ms) | P95 (ms) | Max (ms) | Samples |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| Spectral detector (frame) | ${formatMetricNumber(monoRuntime.detectorMs.avg, 4)} | ${formatMetricNumber(monoRuntime.detectorMs.p95, 4)} | ${formatMetricNumber(monoRuntime.detectorMs.max, 4)} | ${monoRuntime.detectorMs.count} |`,
    `| Competitor-aware validator (case) | ${formatMetricNumber(monoRuntime.validatorMs.avg, 4)} | ${formatMetricNumber(monoRuntime.validatorMs.p95, 4)} | ${formatMetricNumber(monoRuntime.validatorMs.max, 4)} | ${monoRuntime.validatorMs.count} |`,
    `| Post-validator gate overhead (case, enabled-minus-disabled) | ${formatMetricNumber(monoRuntime.gateOverheadMs.avg, 4)} | ${formatMetricNumber(monoRuntime.gateOverheadMs.p95, 4)} | ${formatMetricNumber(monoRuntime.gateOverheadMs.max, 4)} | ${monoRuntime.gateOverheadMs.count} |`,
    `| Total estimated stack cost (case) | ${formatMetricNumber(monoRuntime.totalCaseMs.avg, 4)} | ${formatMetricNumber(monoRuntime.totalCaseMs.p95, 4)} | ${formatMetricNumber(monoRuntime.totalCaseMs.max, 4)} | ${monoRuntime.totalCaseMs.count} |`,
    '',
    '## Feasibility Interpretation',
    '',
    '- Runtime feasibility is inferred from benchmark-path timing (not direct real-time audio-thread simulation).',
    '- Detector cost remains the dominant component in both poly and mono measurements; gate overhead is expected to be secondary if enabled-minus-disabled deltas remain near zero.',
    ''
  ];
  return lines.join('\n');
}

function buildFinalRecommendation(
  polyAggregates: Record<AlgorithmName, Record<'solo' | 'comp' | 'unknown' | 'combined', NoteSetMetrics>>,
  monoCanonical: ValidatorAggregate,
  monoCanonicalConfig: ValidatorDecisionConfig,
  monoGate: DecisionSummary,
  polyRuntime: ReturnType<typeof measurePolyRuntime>,
  monoRuntime: ReturnType<typeof measureMonoRuntime>,
  decisionConfig: ValidatorDecisionConfig,
  noteSetPolicy: NoteSetAggregationPolicy,
  gatePolicy: ActivationGatePolicy
): string {
  const polyCombined = polyAggregates.spectral_game_runtime_unified_v3.combined;
  const gateHelpsPoly =
    (polyCombined.postGateEmptyWindowFalseAcceptRate ?? 1) <= (polyCombined.preGateEmptyWindowFalseAcceptRate ?? 1) &&
    (polyCombined.postGateTransitionWindowAcceptRate ?? 1) <= (polyCombined.preGateTransitionWindowAcceptRate ?? 1);
  const monoTarDrop = monoGate.tar - monoCanonical.tar;
  const monoRegressed = monoTarDrop < -0.02;

  const lines: string[] = [
    '# Gameplay Stack Final Recommendation',
    '',
    '## Final Stack Evaluated',
    '',
    `- Poly gameplay stack: \`${decisionConfig.id}\` + \`${noteSetPolicy.id}\` + \`${gatePolicy.id}\``,
    `- Canonical Android mono config: \`${monoCanonicalConfig.id}\``,
    '',
    '## A. Polyphonic Note-Centric Gameplay',
    '',
    `- Stable non-empty recall (post-gate, combined): ${formatMetricPct(polyCombined.postGateStableNonEmptyExpectedNoteRecall)}`,
    `- Empty-window FAR pre -> post: ${formatMetricPct(polyCombined.preGateEmptyWindowFalseAcceptRate)} -> ${formatMetricPct(polyCombined.postGateEmptyWindowFalseAcceptRate)}`,
    `- Transition accept pre -> post: ${formatMetricPct(polyCombined.preGateTransitionWindowAcceptRate)} -> ${formatMetricPct(polyCombined.postGateTransitionWindowAcceptRate)}`,
    `- Extra-note rate pre -> post: ${formatMetricPct(polyCombined.preGateExtraNoteRate)} -> ${formatMetricPct(polyCombined.postGateExtraNoteRate)}`,
    `- Gate benefit signal: ${gateHelpsPoly ? 'positive suppression with retained recall trend' : 'mixed; verify recall/suppression tradeoff'}`,
    '',
    '## B. Android Mono-Note Realism (234 Takes)',
    '',
    `- Canonical mono stack = \`${monoCanonicalConfig.id}\` + \`${MONO_NOTE_SET_POLICY.id}\` + \`${MONO_ACTIVATION_GATE_POLICY.id}\`.`,
    `- TAR canonical -> poly-derived final: ${formatPct(monoCanonical.tar)} -> ${formatPct(monoGate.tar)} (${formatDelta(monoGate.tar - monoCanonical.tar)})`,
    `- Strict FAR canonical -> poly-derived final: ${formatPct(monoCanonical.strictFar)} -> ${formatPct(monoGate.strictFar)} (${formatDelta(monoGate.strictFar - monoCanonical.strictFar)})`,
    `- Low-string TAR canonical -> poly-derived final: ${formatPct(monoCanonical.lowStringTar)} -> ${formatPct(monoGate.lowStringTar)} (${formatDelta(monoGate.lowStringTar - monoCanonical.lowStringTar)})`,
    `- Gate mono-regression risk: ${monoRegressed ? 'material TAR drop observed' : 'no material TAR regression observed (TAR-focused)'}; FAR impact still depends on mono-specific policy selection.`,
    '',
    '## C. Runtime / Real-Time Feasibility',
    '',
    `- Poly detector avg/p95/max frame cost (ms): ${formatMetricNumber(polyRuntime.detectorMs.avg, 4)} / ${formatMetricNumber(polyRuntime.detectorMs.p95, 4)} / ${formatMetricNumber(polyRuntime.detectorMs.max, 4)}`,
    `- Poly validator avg/p95/max case cost (ms): ${formatMetricNumber(polyRuntime.validatorMs.avg, 4)} / ${formatMetricNumber(polyRuntime.validatorMs.p95, 4)} / ${formatMetricNumber(polyRuntime.validatorMs.max, 4)}`,
    `- Poly gate overhead avg/p95/max window delta (ms): ${formatMetricNumber(polyRuntime.gateOverheadMs.avg, 4)} / ${formatMetricNumber(polyRuntime.gateOverheadMs.p95, 4)} / ${formatMetricNumber(polyRuntime.gateOverheadMs.max, 4)}`,
    `- Mono detector avg/p95/max frame cost (ms): ${formatMetricNumber(monoRuntime.detectorMs.avg, 4)} / ${formatMetricNumber(monoRuntime.detectorMs.p95, 4)} / ${formatMetricNumber(monoRuntime.detectorMs.max, 4)}`,
    '',
    '## D. Recommendation',
    '',
    `- Recommended default stack: ${gateHelpsPoly && !monoRegressed ? 'YES, enable final stack for gameplay mode' : 'CONDITIONAL, keep as opt-in until tradeoff is rechecked'}.`,
    '- Suggested default scope: gameplay note-centric mode where empty/transition suppression is prioritized over strict symbolic exactness.',
    '- Canonical Android mono path should remain the mono note-set cardinality-1 stack unless the gate is separately validated on mono and explicitly accepted as part of that benchmark family.',
    ''
  ];
  return lines.join('\n');
}

function stats(values: number[]): RuntimeStats {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (finite.length <= 0) {
    return { count: 0, avg: 0, p95: 0, max: 0 };
  }
  return {
    count: finite.length,
    avg: average(finite),
    p95: percentile(finite, 0.95),
    max: Math.max(...finite)
  };
}

function percentile(values: number[], q: number): number {
  if (values.length <= 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.min(1, Math.max(0, q));
  const position = clamped * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function average(values: number[]): number {
  if (values.length <= 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(values: boolean[]): number | null {
  if (values.length <= 0) return null;
  return values.filter(Boolean).length / values.length;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function maxOrNull(values: number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length <= 0) return null;
  return Math.max(...finite);
}

function formatMetricPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return formatPct(value);
}

function formatMetricNumber(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return roundNumber(value, digits).toFixed(digits);
}

function formatDelta(delta: number): string {
  if (!Number.isFinite(delta)) return '-';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${formatPct(delta)}`;
}

function describeWinner(entry: any): string {
  if (!entry) return 'none';
  return `${entry.decisionConfig.id} + ${entry.noteSetPolicy.id} + ${entry.activationGatePolicy.id}`;
}

function selectCanonicalMonoConfig(
  monoSweep: any,
  fallback: ValidatorDecisionConfig
): { config: ValidatorDecisionConfig; source: string } {
  const requestedId = (process.env.GAMEPLAY_VALIDATOR_ANDROID_MONO_CONFIG_ID ?? '').trim();
  const sweepBest = monoSweep?.modeB_bestUnderConstraint?.bestByAlgorithmAndMode?.note_only?.spectral_game_runtime_unified_v3?.config;
  const canonical = isDecisionConfig(sweepBest) ? sweepBest : fallback;
  const source = isDecisionConfig(sweepBest) ? 'mono_sweep_best_spectral_note_only' : 'mono_results_fallback';

  if (requestedId.length <= 0) {
    return { config: canonical, source };
  }

  if (requestedId === canonical.id) {
    return { config: canonical, source: `env_override:${requestedId}` };
  }

  if (requestedId === fallback.id) {
    return { config: fallback, source: `env_override:${requestedId}` };
  }

  throw new Error(`Unsupported GAMEPLAY_VALIDATOR_ANDROID_MONO_CONFIG_ID=${requestedId} for the current mono audit path`);
}

function isDecisionConfig(value: unknown): value is ValidatorDecisionConfig {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ValidatorDecisionConfig>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    (candidate.mode === 'legacy_hit_ratio' || candidate.mode === 'note_only' || candidate.mode === 'exact_position') &&
    candidate.note !== undefined &&
    candidate.position !== undefined &&
    candidate.legacy !== undefined
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

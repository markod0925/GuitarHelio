#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PitchDetectorPreset } from '../../src/audio/dsp-core/gh_dsp_core.js';
import { midiForStringFret } from '../../src/guitar/tuning';
import {
  buildDatasetRows,
  csvEscape,
  decodeMonoAudio,
  formatCsvValue,
  formatNullable,
  formatPct,
  FRAME_SIZE,
  readFrame,
  roundNumber,
  roundNullable
} from './shared';
import {
  buildAndroidMonoWindows,
  buildGuitarSetSoloWindows,
  buildProbeTimes,
  DEFAULT_ANDROID_WINDOW_CONFIG,
  DEFAULT_GUITARSET_WINDOW_CONFIG,
  DEFAULT_MONO_BENCHMARK_CONFIG,
  aggregateMonoResults,
  evaluateMonoWindow,
  noteLevelSummary,
  secondsToSampleIndex,
  type AndroidWindowConfig,
  type GuitarSetWindowConfig,
  type MonoAggregateMetrics,
  type MonoBenchmarkConfig,
  type MonoFrameObservation,
  type MonoWindowResult,
  type MonoWindowSpec
} from './ac14_mono_benchmark';
import {
  discoverWavJamsPairs,
  parseJamsNoteEventsFromFile
} from './gameplay_validator_polyphonic';
import { DspCoreDetector } from './shared';

const OUTPUT_ROOT = 'analysis/gameplay_validator_ac14_mono';
const ANDROID_DATASET_ROOT = 'assets/session_20260403_174852';
const GUITARSET_DATASET_ROOT = 'tools/pitch-offline-bench/input/wav';

type DatasetRun = {
  dataset: 'android' | 'guitarset_solo';
  windowConfig: AndroidWindowConfig | GuitarSetWindowConfig;
  aggregate: MonoAggregateMetrics;
  noteSummary: ReturnType<typeof noteLevelSummary>;
  results: MonoWindowResult[];
  diagnostics: Array<{
    fileId: string;
    relativeFilePath: string;
    windowId: string;
    startSec: number;
    endSec: number;
    expectedMidi: number | null;
    expectedAccept: boolean;
    windowKind: string;
    windowCategory: string;
    isStableWindow: boolean;
    sourceBand: string | null;
    acceptPreGate: boolean;
    acceptPostGate: boolean;
    accept: boolean;
    rejectReason: string;
    falseReject: boolean;
    falseAccept: boolean;
    noteMismatch: boolean;
    mismatchType: string;
    decisionLatencyMs: number | null;
    rawDetectedMidis: number[];
    detectorMaxConfidence: number;
    detectorMedianConfidence: number;
    targetHitRatio: number;
    wrongNoteRatio: number;
    supportSeconds: number;
    firstTargetHitLatencyMs: number | null;
    firstAnyHitLatencyMs: number | null;
    detectorRuntimeMs: number;
    validatorRuntimeMs: number;
    totalRuntimeMs: number;
  }>;
};

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const outputDir = path.join(repoRoot, OUTPUT_ROOT);
  await fs.mkdir(outputDir, { recursive: true });

  const benchmarkConfig = parseMonoBenchmarkConfigFromEnv(DEFAULT_MONO_BENCHMARK_CONFIG);
  const androidWindowConfig = parseAndroidWindowConfigFromEnv(DEFAULT_ANDROID_WINDOW_CONFIG);
  const guitarsetWindowConfig = parseGuitarSetWindowConfigFromEnv(DEFAULT_GUITARSET_WINDOW_CONFIG);

  const detector = new DspCoreDetector('ac14', PitchDetectorPreset.Ac14, null);
  await detector.init();

  try {
    const android = await runAndroidBenchmark({
      detector,
      benchmarkConfig,
      windowConfig: androidWindowConfig,
      repoRoot,
      outputDir
    });
    const guitarset = await runGuitarSetBenchmark({
      detector,
      benchmarkConfig,
      windowConfig: guitarsetWindowConfig,
      repoRoot,
      outputDir
    });

    await writeOutputs(outputDir, benchmarkConfig, androidWindowConfig, guitarsetWindowConfig, android, guitarset);
    console.log(`[ac14-mono] outputs: ${OUTPUT_ROOT}`);
  } finally {
    detector.dispose?.();
  }
}

async function runAndroidBenchmark(input: {
  detector: DspCoreDetector;
  benchmarkConfig: MonoBenchmarkConfig;
  windowConfig: AndroidWindowConfig;
  repoRoot: string;
  outputDir: string;
}): Promise<DatasetRun> {
  const datasetRows = await buildDatasetRows(path.join(input.repoRoot, ANDROID_DATASET_ROOT));
  if (datasetRows.length <= 0) {
    throw new Error(`No WAV files found under ${ANDROID_DATASET_ROOT}`);
  }

  const results: MonoWindowResult[] = [];
  const diagnostics: DatasetRun['diagnostics'] = [];
  for (let index = 0; index < datasetRows.length; index += 1) {
    const row = datasetRows[index];
    const decoded = await decodeMonoAudio(row.filePath);
    const midi = midiForStringFret(row.stringId, row.fret);
    const windows = buildAndroidMonoWindows({
      datasetRow: row,
      midi,
      durationSec: decoded.samples.length / decoded.sampleRate,
      config: input.windowConfig
    });

    for (const spec of windows) {
      const evaluation = await evaluateSpec(input.detector, decoded.samples, decoded.sampleRate, spec, input.benchmarkConfig);
      results.push(evaluation);
      diagnostics.push(compactResult(evaluation));
    }
    if (index % 24 === 0 || index + 1 === datasetRows.length) {
      console.log(`[ac14-mono] android ${index + 1}/${datasetRows.length} ${row.relativeFilePath}`);
    }
  }

  const aggregate = aggregateMonoResults(results);
  const noteSummary = noteLevelSummary(results);
  return {
    dataset: 'android',
    windowConfig: input.windowConfig,
    aggregate,
    noteSummary,
    results,
    diagnostics
  };
}

async function runGuitarSetBenchmark(input: {
  detector: DspCoreDetector;
  benchmarkConfig: MonoBenchmarkConfig;
  windowConfig: GuitarSetWindowConfig;
  repoRoot: string;
  outputDir: string;
}): Promise<DatasetRun> {
  const pairs = await discoverWavJamsPairs(path.join(input.repoRoot, GUITARSET_DATASET_ROOT));
  const soloPairs = pairs.filter((pair) => pair.subset === 'solo');
  if (soloPairs.length <= 0) {
    throw new Error(`No _solo WAV/JAMS pairs found under ${GUITARSET_DATASET_ROOT}`);
  }

  const results: MonoWindowResult[] = [];
  const diagnostics: DatasetRun['diagnostics'] = [];
  for (let index = 0; index < soloPairs.length; index += 1) {
    const pair = soloPairs[index];
    const [decoded, parsed] = await Promise.all([
      decodeMonoAudio(pair.wavPath),
      parseJamsNoteEventsFromFile(pair.jamsPath)
    ]);
    const windows = buildGuitarSetSoloWindows({
      fileId: pair.fileId,
      relativeFilePath: pair.wavRelativePath,
      durationSec: decoded.samples.length / decoded.sampleRate,
      events: parsed.events,
      config: input.windowConfig
    });

    for (const spec of windows) {
      const evaluation = await evaluateSpec(input.detector, decoded.samples, decoded.sampleRate, spec, input.benchmarkConfig);
      results.push(evaluation);
      diagnostics.push(compactResult(evaluation));
    }
    if (index % 12 === 0 || index + 1 === soloPairs.length) {
      console.log(`[ac14-mono] guitarset ${index + 1}/${soloPairs.length} ${pair.wavRelativePath}`);
    }
  }

  const aggregate = aggregateMonoResults(results);
  const noteSummary = noteLevelSummary(results);
  return {
    dataset: 'guitarset_solo',
    windowConfig: input.windowConfig,
    aggregate,
    noteSummary,
    results,
    diagnostics
  };
}

async function evaluateSpec(
  detector: DspCoreDetector,
  samples: Float32Array,
  sampleRate: number,
  spec: MonoWindowSpec,
  benchmarkConfig: MonoBenchmarkConfig
): Promise<MonoWindowResult> {
  const observations: MonoFrameObservation[] = [];
  const times = buildProbeTimes({
    startSec: spec.startSec,
    endSec: spec.endSec,
    spacingSec: benchmarkConfig.probeSpacingSec
  });

  detector.reset();
  for (let frameIndex = 0; frameIndex < times.length; frameIndex += 1) {
    const timeSec = times[frameIndex];
    const startSample = secondsToSampleIndex(timeSec, sampleRate);
    const frame = readFrame(samples, startSample, FRAME_SIZE);
    const startedAt = performance.now();
    const result = detector.processFrame({
      timestampMs: timeSec * 1000,
      frameIndex,
      sampleRate,
      rawFrame: frame,
      processedFrame: frame,
      analysisWindowId: frameIndex
    });
    const runtimeMs = performance.now() - startedAt;
    observations.push({
      frameIndex,
      timestampMs: timeSec * 1000,
      runtimeMs,
      detectorAccepted: result.accepted,
      detectorConfidence: result.confidence ?? 0,
      detectedMidi: result.midi ?? null,
      rejectReason: result.rejectReason ?? null
    });
  }

  const validatorStartedAt = performance.now();
  const evaluated = evaluateMonoWindow({
    spec,
    observations,
    config: benchmarkConfig
  });
  const validatorRuntimeMs = performance.now() - validatorStartedAt;
  const detectorRuntimeMs = observations.reduce((sum, obs) => sum + obs.runtimeMs, 0);
  return {
    ...evaluated,
    observations,
    validatorRuntimeMs,
    detectorRuntimeMs,
    totalRuntimeMs: detectorRuntimeMs + validatorRuntimeMs
  };
}

function compactResult(result: MonoWindowResult): DatasetRun['diagnostics'][number] {
  return {
    fileId: result.fileId,
    relativeFilePath: result.relativeFilePath,
    windowId: result.windowId,
    startSec: roundNumber(result.startSec, 6),
    endSec: roundNumber(result.endSec, 6),
    expectedMidi: result.expectedMidi,
    expectedAccept: result.expectedAccept,
    windowKind: result.windowKind,
    windowCategory: result.windowCategory,
    isStableWindow: result.isStableWindow,
    sourceBand: result.sourceBand,
    acceptPreGate: result.acceptPreGate,
    acceptPostGate: result.acceptPostGate,
    accept: result.accept,
    rejectReason: result.rejectReason,
    falseReject: result.falseReject,
    falseAccept: result.falseAccept,
    noteMismatch: result.noteMismatch,
    mismatchType: result.mismatchType,
    decisionLatencyMs: roundNullable(result.decisionLatencyMs, 3),
    rawDetectedMidis: result.evidence.rawDetectedMidis,
    detectorMaxConfidence: roundNumber(result.evidence.maxConfidence, 6),
    detectorMedianConfidence: roundNumber(result.evidence.medianConfidence, 6),
    targetHitRatio: roundNumber(result.evidence.targetHitRatio, 6),
    wrongNoteRatio: roundNumber(result.evidence.wrongNoteRatio, 6),
    supportSeconds: roundNumber(result.evidence.supportSeconds, 6),
    firstTargetHitLatencyMs: roundNullable(result.evidence.firstTargetHitLatencyMs, 3),
    firstAnyHitLatencyMs: roundNullable(result.evidence.firstAnyHitLatencyMs, 3),
    detectorRuntimeMs: roundNumber(result.detectorRuntimeMs, 6),
    validatorRuntimeMs: roundNumber(result.validatorRuntimeMs, 6),
    totalRuntimeMs: roundNumber(result.totalRuntimeMs, 6)
  };
}

async function writeOutputs(
  outputDir: string,
  benchmarkConfig: MonoBenchmarkConfig,
  androidWindowConfig: AndroidWindowConfig,
  guitarsetWindowConfig: GuitarSetWindowConfig,
  android: DatasetRun,
  guitarset: DatasetRun
): Promise<void> {
  const androidResultsDoc = {
    generatedAtIso: new Date().toISOString(),
    dataset: 'android' as const,
    datasetRoot: ANDROID_DATASET_ROOT,
    benchmarkConfig,
    windowConfig: androidWindowConfig,
    aggregate: android.aggregate,
    noteSummary: android.noteSummary,
    results: android.results.map(compactResult),
    diagnostics: android.diagnostics
  };
  const guitarsetResultsDoc = {
    generatedAtIso: new Date().toISOString(),
    dataset: 'guitarset_solo' as const,
    datasetRoot: GUITARSET_DATASET_ROOT,
    benchmarkConfig,
    windowConfig: guitarsetWindowConfig,
    aggregate: guitarset.aggregate,
    noteSummary: guitarset.noteSummary,
    results: guitarset.results.map(compactResult),
    diagnostics: guitarset.diagnostics
  };

  await fs.writeFile(path.join(outputDir, 'android_results.json'), `${JSON.stringify(androidResultsDoc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'guitarset_solo_results.json'), `${JSON.stringify(guitarsetResultsDoc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'android_results.csv'), `${buildCsv(android.results)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'guitarset_solo_results.csv'), `${buildCsv(guitarset.results)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'android_diagnostics.json'), `${JSON.stringify(android.diagnostics, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'guitarset_solo_diagnostics.json'), `${JSON.stringify(guitarset.diagnostics, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'audit.md'), buildAuditMarkdown(benchmarkConfig, androidWindowConfig, guitarsetWindowConfig, android, guitarset), 'utf8');
  await fs.writeFile(path.join(outputDir, 'android_summary.md'), buildDatasetSummaryMarkdown('Android mono-note takes', android), 'utf8');
  await fs.writeFile(path.join(outputDir, 'guitarset_solo_summary.md'), buildDatasetSummaryMarkdown('GuitarSet _solo', guitarset), 'utf8');
  await fs.writeFile(path.join(outputDir, 'runtime_report.md'), buildRuntimeMarkdown(android, guitarset), 'utf8');
  await fs.writeFile(path.join(outputDir, 'final_recommendation.md'), buildFinalRecommendationMarkdown(android, guitarset, benchmarkConfig), 'utf8');
  await fs.writeFile(
    path.join(outputDir, 'window_config.json'),
    `${JSON.stringify({
      benchmarkConfig,
      androidWindowConfig,
      guitarsetWindowConfig
    }, null, 2)}\n`,
    'utf8'
  );
}

function buildDatasetSummaryMarkdown(title: string, run: DatasetRun): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    `- Windows: ${run.aggregate.windows}`,
    `- Positive windows: ${run.aggregate.positiveWindows}`,
    `- Negative windows: ${run.aggregate.negativeWindows}`,
    `- Stable windows: ${run.aggregate.stableWindows}`,
    `- Transition windows: ${run.aggregate.transitionWindows}`,
    `- Guard windows: ${run.aggregate.guardWindows}`,
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| TAR | ${formatPct(run.aggregate.tar)} |`,
    `| Strict FAR | ${formatPct(run.aggregate.strictFar)} |`,
    `| Note-mismatch FAR | ${formatPct(run.aggregate.noteMismatchFar)} |`,
    `| Precision | ${formatPct(run.aggregate.precision)} |`,
    `| Recall | ${formatPct(run.aggregate.recall)} |`,
    `| Detector runtime avg (ms) | ${formatNumber(run.aggregate.detectorRuntimeAvgMs, 4)} |`,
    `| Detector runtime p95 (ms) | ${formatNumber(run.aggregate.detectorRuntimeP95Ms, 4)} |`,
    `| Validator runtime avg (ms) | ${formatNumber(run.aggregate.validatorRuntimeAvgMs, 4)} |`,
    `| Validator runtime p95 (ms) | ${formatNumber(run.aggregate.validatorRuntimeP95Ms, 4)} |`,
    `| End-to-end avg (ms) | ${formatNumber(run.aggregate.totalRuntimeAvgMs, 4)} |`,
    `| End-to-end p95 (ms) | ${formatNumber(run.aggregate.totalRuntimeP95Ms, 4)} |`,
    ''
  ];

  if (run.dataset === 'android') {
    lines.push(
      '## Low String View',
      '',
      `- Low-string TAR: ${formatNullable(run.aggregate.lowBandTar, 3)}`,
      `- Low-string FAR: ${formatNullable(run.aggregate.lowBandFar, 3)}`,
      ''
    );
  } else {
    lines.push(
      '## Low String View',
      '',
      '- Low-string metrics are unavailable for GuitarSet because the JAMS annotations do not encode string/fret position.',
      ''
    );
  }

  lines.push(
    '## Window Timing',
    '',
    `- Average support seconds: ${formatNumber(run.aggregate.averageSupportSeconds, 4)}`,
    `- Average target-hit ratio: ${formatPct(run.aggregate.averageTargetHitRatio)}`,
    `- Average wrong-note ratio: ${formatPct(run.aggregate.averageWrongNoteRatio)}`,
    `- First target-hit latency avg/p95 (ms): ${formatNullable(run.aggregate.firstTargetHitLatencyMsAvg, 3)} / ${formatNullable(run.aggregate.firstTargetHitLatencyMsP95, 3)}`,
    `- First any-hit latency avg/p95 (ms): ${formatNullable(run.aggregate.firstAnyHitLatencyMsAvg, 3)} / ${formatNullable(run.aggregate.firstAnyHitLatencyMsP95, 3)}`,
    ''
  );

  return lines.join('\n');
}

function buildRuntimeMarkdown(android: DatasetRun, guitarset: DatasetRun): string {
  const lines: string[] = [
    '# Runtime Report',
    '',
    '- Detector avg/p95 and validator avg/p95 are per processed probe/frame.',
    '- End-to-end avg/p95 is the accumulated cost across all probes in each benchmark window.',
    '',
    '## Android',
    '',
    `- Detector avg/p95 (ms): ${formatNumber(android.aggregate.detectorRuntimeAvgMs, 4)} / ${formatNumber(android.aggregate.detectorRuntimeP95Ms, 4)}`,
    `- Validator avg/p95 (ms): ${formatNumber(android.aggregate.validatorRuntimeAvgMs, 4)} / ${formatNumber(android.aggregate.validatorRuntimeP95Ms, 4)}`,
    `- End-to-end avg/p95 (ms): ${formatNumber(android.aggregate.totalRuntimeAvgMs, 4)} / ${formatNumber(android.aggregate.totalRuntimeP95Ms, 4)}`,
    '',
    '## GuitarSet _solo',
    '',
    `- Detector avg/p95 (ms): ${formatNumber(guitarset.aggregate.detectorRuntimeAvgMs, 4)} / ${formatNumber(guitarset.aggregate.detectorRuntimeP95Ms, 4)}`,
    `- Validator avg/p95 (ms): ${formatNumber(guitarset.aggregate.validatorRuntimeAvgMs, 4)} / ${formatNumber(guitarset.aggregate.validatorRuntimeP95Ms, 4)}`,
    `- End-to-end avg/p95 (ms): ${formatNumber(guitarset.aggregate.totalRuntimeAvgMs, 4)} / ${formatNumber(guitarset.aggregate.totalRuntimeP95Ms, 4)}`,
    ''
  ];
  return lines.join('\n');
}

function buildFinalRecommendationMarkdown(
  android: DatasetRun,
  guitarset: DatasetRun,
  benchmarkConfig: MonoBenchmarkConfig
): string {
  const androidPass =
    android.aggregate.tar >= 0.9 &&
    android.aggregate.strictFar <= 0.05 &&
    android.aggregate.noteMismatchFar <= 0.10;
  const guitarPass =
    guitarset.aggregate.recall >= 0.9 &&
    guitarset.aggregate.strictFar <= 0.05 &&
    guitarset.aggregate.noteMismatchFar <= 0.10;
  const runtimePass =
    android.aggregate.detectorRuntimeAvgMs <= 16.7 &&
    guitarset.aggregate.detectorRuntimeAvgMs <= 16.7 &&
    android.aggregate.validatorRuntimeAvgMs <= 1 &&
    guitarset.aggregate.validatorRuntimeAvgMs <= 1;
  const recommendation = androidPass && guitarPass && runtimePass ? 'GO' : 'NO-GO';

  const lines: string[] = [
    '# ac14 Gameplay Mono Fallback Recommendation',
    '',
    '## Benchmark Contract',
    '',
    `- Probe spacing: ${formatNumber(benchmarkConfig.probeSpacingSec, 3)} s`,
    `- Stable target ratio threshold: ${formatNumber(benchmarkConfig.minStableTargetRatio, 3)}`,
    `- Transition target ratio threshold: ${formatNumber(benchmarkConfig.minTransitionTargetRatio, 3)}`,
    `- Empty-window confidence cap: ${formatNumber(benchmarkConfig.emptyMaxConfidence, 3)}`,
    '',
    '## Android Mono-Note Takes',
    '',
    `- TAR: ${formatPct(android.aggregate.tar)}`,
    `- Strict FAR: ${formatPct(android.aggregate.strictFar)}`,
    `- Note-mismatch FAR: ${formatPct(android.aggregate.noteMismatchFar)}`,
    `- Low-string TAR/FAR: ${formatNullable(android.aggregate.lowBandTar, 3)} / ${formatNullable(android.aggregate.lowBandFar, 3)}`,
    '',
    '## GuitarSet _solo',
    '',
    `- Note recall: ${formatPct(guitarset.aggregate.recall)}`,
    `- Strict FAR: ${formatPct(guitarset.aggregate.strictFar)}`,
    `- Note-mismatch FAR: ${formatPct(guitarset.aggregate.noteMismatchFar)}`,
    `- Stable-window accept rate: ${formatNullable(guitarset.aggregate.stableWindowAcceptRate, 3)}`,
    `- Transition-window accept rate: ${formatNullable(guitarset.aggregate.transitionWindowAcceptRate, 3)}`,
    '',
    '## Runtime',
    '',
    `- Android end-to-end avg/p95 (ms): ${formatNumber(android.aggregate.totalRuntimeAvgMs, 4)} / ${formatNumber(android.aggregate.totalRuntimeP95Ms, 4)}`,
    `- GuitarSet end-to-end avg/p95 (ms): ${formatNumber(guitarset.aggregate.totalRuntimeAvgMs, 4)} / ${formatNumber(guitarset.aggregate.totalRuntimeP95Ms, 4)}`,
    '',
    '## Decision',
    '',
    `- Recommendation: **${recommendation}**.`,
    androidPass
      ? '- Android data supports a monophonic fallback with context-aware suppression.'
      : '- Android data does not clear the acceptance threshold for the fallback.',
    guitarPass
      ? '- GuitarSet _solo stays stable enough to support the monophonic contract.'
      : '- GuitarSet _solo still shows enough weakness to avoid a clean fallback decision.',
    runtimePass
      ? '- Runtime stays lightweight enough for gameplay use.'
      : '- Runtime is heavier than desired for a low-latency gameplay path.',
    ''
  ];

  return lines.join('\n');
}

function buildAuditMarkdown(
  benchmarkConfig: MonoBenchmarkConfig,
  androidWindowConfig: AndroidWindowConfig,
  guitarsetWindowConfig: GuitarSetWindowConfig,
  android: DatasetRun,
  guitarset: DatasetRun
): string {
  return [
    '# ac14 Mono Benchmark Audit',
    '',
    '## Reusable Detector-Agnostic Pieces',
    '',
    '- Fixed second-based window definitions for both Android and GuitarSet.',
    '- Frame probing uses a fixed spacing in seconds, not frame-count or sample-rate-derived window semantics.',
    '- The validator only consumes detector acceptance, detected MIDI, confidence, and time stamps.',
    '- Stable, transition, and guard windows are handled separately so spurious activations can be suppressed contextually.',
    '',
    '## ac14 Integration Points',
    '',
    '- The benchmark uses `PitchDetectorPreset.Ac14` through `DspCoreDetector`.',
    '- No spectral runtime model is injected, and no competitor-score evidence is required.',
    '- The runtime path remains compatible with the existing `ac14` backend name used by Android and Electron.',
    '',
    '## Window Semantics Normalized to Seconds',
    '',
    `- Probe spacing: ${formatNumber(benchmarkConfig.probeSpacingSec, 3)} s`,
    `- Android pre-guard: ${formatNumber(androidWindowConfig.preGuardStartSec, 3)} - ${formatNumber(androidWindowConfig.preGuardStartSec + androidWindowConfig.preGuardDurationSec, 3)} s`,
    `- Android attack transition: ${formatNumber(androidWindowConfig.attackStartSec, 3)} - ${formatNumber(androidWindowConfig.attackStartSec + androidWindowConfig.attackDurationSec, 3)} s`,
    `- Android stable windows: ${formatNumber(androidWindowConfig.stable1StartSec, 3)} - ${formatNumber(androidWindowConfig.stable1StartSec + androidWindowConfig.stable1DurationSec, 3)} s, ${formatNumber(androidWindowConfig.stable2StartSec, 3)} - ${formatNumber(androidWindowConfig.stable2StartSec + androidWindowConfig.stable2DurationSec, 3)} s, ${formatNumber(androidWindowConfig.stable3StartSec, 3)} - ${formatNumber(androidWindowConfig.stable3StartSec + androidWindowConfig.stable3DurationSec, 3)} s`,
    `- Android tail guard: ${formatNumber(androidWindowConfig.tailGuardStartSec, 3)} - ${formatNumber(androidWindowConfig.tailGuardStartSec + androidWindowConfig.tailGuardDurationSec, 3)} s`,
    `- GuitarSet onset transition: ${formatNumber(guitarsetWindowConfig.onsetTransitionSec, 3)} s`,
    `- GuitarSet stable window: ${formatNumber(guitarsetWindowConfig.stableWindowSec, 3)} s`,
    `- GuitarSet release transition: ${formatNumber(guitarsetWindowConfig.releaseTransitionSec, 3)} s`,
    `- GuitarSet gap padding: ${formatNumber(guitarsetWindowConfig.gapPaddingSec, 3)} s`,
    '',
    '## Dataset Separation',
    '',
    `- Android windows: ${android.results.length}`,
    `- GuitarSet _solo windows: ${guitarset.results.length}`,
    '',
    '## Reusable Logic vs Dataset-Specific Logic',
    '',
    '- Reused: audio decoding, frame reading, detector timing, and the compact mono acceptance evaluator.',
    '- Dataset-specific: Android fixed-window placement, GuitarSet note-relative window placement, and low-string reporting only for Android.',
    ''
  ].join('\n');
}

function buildCsv(rows: MonoWindowResult[]): string {
  const header = [
    'dataset',
    'file_id',
    'relative_file_path',
    'window_id',
    'start_sec',
    'end_sec',
    'expected_midi',
    'expected_accept',
    'window_kind',
    'window_category',
    'is_stable_window',
    'source_string_id',
    'source_fret',
    'source_take',
    'source_band',
    'accept_pre_gate',
    'accept_post_gate',
    'accept',
    'reject_reason',
    'false_reject',
    'false_accept',
    'note_mismatch',
    'mismatch_type',
    'decision_latency_ms',
    'raw_detected_midis',
    'detector_max_confidence',
    'detector_median_confidence',
    'target_hit_ratio',
    'wrong_note_ratio',
    'support_seconds',
    'first_target_hit_latency_ms',
    'first_any_hit_latency_ms',
    'detector_runtime_ms',
    'validator_runtime_ms',
    'total_runtime_ms'
  ];
  const out = [header.join(',')];
  for (const row of rows) {
    out.push([
      row.dataset,
      row.fileId,
      row.relativeFilePath,
      row.windowId,
      roundNumber(row.startSec, 6),
      roundNumber(row.endSec, 6),
      row.expectedMidi,
      row.expectedAccept,
      row.windowKind,
      row.windowCategory,
      row.isStableWindow,
      row.sourceStringId,
      row.sourceFret,
      row.sourceTake,
      row.sourceBand,
      row.acceptPreGate,
      row.acceptPostGate,
      row.accept,
      row.rejectReason,
      row.falseReject,
      row.falseAccept,
      row.noteMismatch,
      row.mismatchType,
      row.decisionLatencyMs,
      row.evidence.rawDetectedMidis.join('|'),
      roundNumber(row.evidence.maxConfidence, 6),
      roundNumber(row.evidence.medianConfidence, 6),
      roundNumber(row.evidence.targetHitRatio, 6),
      roundNumber(row.evidence.wrongNoteRatio, 6),
      roundNumber(row.evidence.supportSeconds, 6),
      row.evidence.firstTargetHitLatencyMs,
      row.evidence.firstAnyHitLatencyMs,
      roundNumber(row.detectorRuntimeMs, 6),
      roundNumber(row.validatorRuntimeMs, 6),
      roundNumber(row.totalRuntimeMs, 6)
    ].map((value) => csvEscape(formatCsvValue(value))).join(','));
  }
  return out.join('\n');
}

function formatNumber(value: number, digits: number): string {
  return Number.isFinite(value) ? roundNumber(value, digits).toFixed(digits) : '-';
}

function parseMonoBenchmarkConfigFromEnv(base: MonoBenchmarkConfig): MonoBenchmarkConfig {
  return {
    ...base,
    probeSpacingSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_PROBE_SPACING_SEC', base.probeSpacingSec),
    minStableSupportSeconds: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_MIN_STABLE_SUPPORT_SEC', base.minStableSupportSeconds),
    minTransitionSupportSeconds: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_MIN_TRANSITION_SUPPORT_SEC', base.minTransitionSupportSeconds),
    minStableTargetRatio: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_MIN_STABLE_TARGET_RATIO', base.minStableTargetRatio),
    minTransitionTargetRatio: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_MIN_TRANSITION_TARGET_RATIO', base.minTransitionTargetRatio),
    minStableConfidence: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_MIN_STABLE_CONFIDENCE', base.minStableConfidence),
    minTransitionConfidence: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_MIN_TRANSITION_CONFIDENCE', base.minTransitionConfidence),
    maxWrongNoteRatio: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_MAX_WRONG_NOTE_RATIO', base.maxWrongNoteRatio),
    maxTransitionWrongNoteRatio: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_MAX_TRANSITION_WRONG_NOTE_RATIO', base.maxTransitionWrongNoteRatio),
    emptyMaxConfidence: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_EMPTY_MAX_CONFIDENCE', base.emptyMaxConfidence),
    semitoneTolerance: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_SEMITONE_TOLERANCE', base.semitoneTolerance)
  };
}

function parseAndroidWindowConfigFromEnv(base: AndroidWindowConfig): AndroidWindowConfig {
  return {
    preGuardStartSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_ANDROID_PRE_GUARD_START_SEC', base.preGuardStartSec),
    preGuardDurationSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_ANDROID_PRE_GUARD_DURATION_SEC', base.preGuardDurationSec),
    attackStartSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_ANDROID_ATTACK_START_SEC', base.attackStartSec),
    attackDurationSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_ANDROID_ATTACK_DURATION_SEC', base.attackDurationSec),
    stable1StartSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_ANDROID_STABLE1_START_SEC', base.stable1StartSec),
    stable1DurationSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_ANDROID_STABLE1_DURATION_SEC', base.stable1DurationSec),
    stable2StartSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_ANDROID_STABLE2_START_SEC', base.stable2StartSec),
    stable2DurationSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_ANDROID_STABLE2_DURATION_SEC', base.stable2DurationSec),
    stable3StartSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_ANDROID_STABLE3_START_SEC', base.stable3StartSec),
    stable3DurationSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_ANDROID_STABLE3_DURATION_SEC', base.stable3DurationSec),
    tailGuardStartSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_ANDROID_TAIL_GUARD_START_SEC', base.tailGuardStartSec),
    tailGuardDurationSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_ANDROID_TAIL_GUARD_DURATION_SEC', base.tailGuardDurationSec)
  };
}

function parseGuitarSetWindowConfigFromEnv(base: GuitarSetWindowConfig): GuitarSetWindowConfig {
  return {
    onsetTransitionSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_GUITARSET_ONSET_TRANSITION_SEC', base.onsetTransitionSec),
    stableWindowSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_GUITARSET_STABLE_WINDOW_SEC', base.stableWindowSec),
    releaseTransitionSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_GUITARSET_RELEASE_TRANSITION_SEC', base.releaseTransitionSec),
    gapPaddingSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_GUITARSET_GAP_PADDING_SEC', base.gapPaddingSec),
    gapMinSec: parseEnvNumber('GAMEPLAY_VALIDATOR_AC14_GUITARSET_GAP_MIN_SEC', base.gapMinSec)
  };
}

function parseEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim().length <= 0) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

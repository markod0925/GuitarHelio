#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ALGORITHMS,
  DEFAULT_VALIDATOR_DECISION_CONFIG,
  deriveConfigWithMode,
  type AlgorithmName,
  type ValidatorDecisionConfig
} from './gameplay_validator_core';
import {
  DEFAULT_ACTIVATION_GATE_POLICY,
  DEFAULT_NOTE_SET_POLICY,
  evaluatePolyphonicTelemetryForConfig,
  type ActivationGatePolicy,
  type NoteSetAggregationPolicy,
  type NoteSetMetrics,
  type PolyphonicWindowTelemetry
} from './gameplay_validator_polyphonic';
import {
  compareGameplayLexicographicAlgorithmMetrics,
  compareGameplayLexicographicCombinedMetrics,
  compareGameplayRecallEpsilonAlgorithmMetrics,
  compareGameplayRecallEpsilonCombinedMetrics,
  compareStrictSymbolicAlgorithmMetrics,
  compareStrictSymbolicCombinedMetrics,
  formatRecallEpsilon,
  normalizeRecallEpsilon
} from './gameplay_validator_poly_sweep_ranking';
import { formatPct, roundNumber } from './shared';

const OUTPUT_ROOT = 'analysis/gameplay_validator_benchmark_poly';
const SWEEP_ROOT = path.join(OUTPUT_ROOT, 'sweep');
const DIAGNOSTICS_FILE = path.join(OUTPUT_ROOT, 'diagnostics.json');

type DiagnosticsDoc = {
  windowTelemetry: PolyphonicWindowTelemetry[];
};

type CombinedModeMetrics = {
  avgPostRecall: number;
  avgStableRecall: number;
  avgEmptyFar: number;
  avgTransitionAccept: number;
  avgExtraNoteRate: number;
  avgExactRate: number;
  avgStableSupersetAccept: number;
  avgRuntimeMs: number;
  score: number;
};

type SweepEntry = {
  decisionConfig: ValidatorDecisionConfig;
  noteSetPolicy: NoteSetAggregationPolicy;
  activationGatePolicy: ActivationGatePolicy;
  byAlgorithm: Record<AlgorithmName, NoteSetMetrics>;
  strict: CombinedModeMetrics;
  gameplay: CombinedModeMetrics;
};

type RankedEntry = SweepEntry & { rank: number };
type RankingMode = 'strict_symbolic' | 'gameplay_lexicographic' | 'gameplay_recall_epsilon';

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const diagnosticsPath = path.resolve(repoRoot, DIAGNOSTICS_FILE);
  const sweepDir = path.resolve(repoRoot, SWEEP_ROOT);
  await fs.mkdir(sweepDir, { recursive: true });

  const diagnostics = await loadDiagnostics(diagnosticsPath);
  const telemetry = diagnostics.windowTelemetry;
  if (!Array.isArray(telemetry) || telemetry.length <= 0) {
    throw new Error(`No window telemetry found in ${diagnosticsPath}. Run benchmark:suite:gameplay-validator:poly first.`);
  }

  const decisionConfigLimit = parseEnvLimit('GAMEPLAY_VALIDATOR_POLY_SWEEP_MAX_DECISION_CONFIGS');
  const noteSetPolicyLimit = parseEnvLimit('GAMEPLAY_VALIDATOR_POLY_SWEEP_MAX_NOTESET_POLICIES');
  const gatePolicyLimit = parseEnvLimit('GAMEPLAY_VALIDATOR_POLY_SWEEP_MAX_GATE_POLICIES');
  const candidateLimit = parseEnvLimit('GAMEPLAY_VALIDATOR_POLY_SWEEP_MAX_CANDIDATES');
  const gameplayRecallEpsilon = parseRecallEpsilonFromEnv('GAMEPLAY_VALIDATOR_POLY_SWEEP_RECALL_EPSILON');

  const decisionConfigsAll = buildDecisionConfigs();
  const noteSetPoliciesAll = buildPolicyConfigs();
  const activationGatePoliciesAll = buildActivationGateConfigs();

  const decisionConfigs = decisionConfigLimit !== null ? decisionConfigsAll.slice(0, decisionConfigLimit) : decisionConfigsAll;
  const noteSetPolicies = noteSetPolicyLimit !== null ? noteSetPoliciesAll.slice(0, noteSetPolicyLimit) : noteSetPoliciesAll;
  const activationGatePolicies = gatePolicyLimit !== null ? activationGatePoliciesAll.slice(0, gatePolicyLimit) : activationGatePoliciesAll;

  if (decisionConfigs.length !== decisionConfigsAll.length || noteSetPolicies.length !== noteSetPoliciesAll.length || activationGatePolicies.length !== activationGatePoliciesAll.length || candidateLimit !== null) {
    console.log('[gameplay-validator-poly-sweep] running in bounded mode via env limits');
  }

  const entries: SweepEntry[] = [];
  sweepLoop: for (const decisionConfig of decisionConfigs) {
    for (const noteSetPolicy of noteSetPolicies) {
      for (const activationGatePolicy of activationGatePolicies) {
        const evaluation = evaluatePolyphonicTelemetryForConfig({
          windowTelemetry: telemetry,
          decisionConfig,
          noteSetPolicy,
          activationGatePolicy,
          algorithms: ALGORITHMS
        });

        const byAlgorithm = Object.fromEntries(
          ALGORITHMS.map((algorithm) => [algorithm, evaluation.aggregates[algorithm].combined])
        ) as Record<AlgorithmName, NoteSetMetrics>;

        const strict = buildCombinedMetrics(byAlgorithm, 'strict_symbolic');
        const gameplay = buildCombinedMetrics(byAlgorithm, 'gameplay_note_centric');
        entries.push({ decisionConfig, noteSetPolicy, activationGatePolicy, byAlgorithm, strict, gameplay });
        if (candidateLimit !== null && entries.length >= candidateLimit) {
          break sweepLoop;
        }
      }
    }
  }

  const strictPerAlgorithm = Object.fromEntries(ALGORITHMS.map((algorithm) => {
    const ranked = [...entries].sort((left, right) => compareByAlgorithm(left, right, algorithm, 'strict_symbolic', gameplayRecallEpsilon));
    return [algorithm, ranked];
  })) as Record<AlgorithmName, SweepEntry[]>;

  const gameplayLexicographicPerAlgorithm = Object.fromEntries(ALGORITHMS.map((algorithm) => {
    const ranked = [...entries].sort((left, right) => compareByAlgorithm(left, right, algorithm, 'gameplay_lexicographic', gameplayRecallEpsilon));
    return [algorithm, ranked];
  })) as Record<AlgorithmName, SweepEntry[]>;

  const gameplayRecallEpsilonPerAlgorithm = Object.fromEntries(ALGORITHMS.map((algorithm) => {
    const ranked = [...entries].sort((left, right) => compareByAlgorithm(left, right, algorithm, 'gameplay_recall_epsilon', gameplayRecallEpsilon));
    return [algorithm, ranked];
  })) as Record<AlgorithmName, SweepEntry[]>;

  const strictCombined = rankEntries([...entries].sort((left, right) => compareCombined(left, right, 'strict_symbolic', gameplayRecallEpsilon)));
  const gameplayLexicographicCombined = rankEntries(
    [...entries].sort((left, right) => compareCombined(left, right, 'gameplay_lexicographic', gameplayRecallEpsilon))
  );
  const gameplayRecallEpsilonCombined = rankEntries(
    [...entries].sort((left, right) => compareCombined(left, right, 'gameplay_recall_epsilon', gameplayRecallEpsilon))
  );

  const strictBestByAlgorithm = Object.fromEntries(ALGORITHMS.map((algorithm) => [
    algorithm,
    strictPerAlgorithm[algorithm][0] ?? null
  ])) as Record<AlgorithmName, SweepEntry | null>;

  const gameplayLexicographicBestByAlgorithm = Object.fromEntries(ALGORITHMS.map((algorithm) => [
    algorithm,
    gameplayLexicographicPerAlgorithm[algorithm][0] ?? null
  ])) as Record<AlgorithmName, SweepEntry | null>;

  const gameplayRecallEpsilonBestByAlgorithm = Object.fromEntries(ALGORITHMS.map((algorithm) => [
    algorithm,
    gameplayRecallEpsilonPerAlgorithm[algorithm][0] ?? null
  ])) as Record<AlgorithmName, SweepEntry | null>;

  const strictBestCombined = strictCombined[0] ?? null;
  const gameplayLexicographicBestCombined = gameplayLexicographicCombined[0] ?? null;
  const gameplayRecallEpsilonBestCombined = gameplayRecallEpsilonCombined[0] ?? null;

  const jsonDoc = {
    generatedAtIso: new Date().toISOString(),
    sourceDiagnostics: DIAGNOSTICS_FILE,
    decisionConfigCount: decisionConfigs.length,
    noteSetPolicyCount: noteSetPolicies.length,
    activationGatePolicyCount: activationGatePolicies.length,
    candidateCount: entries.length,
    sweepLimits: {
      decisionConfigLimit,
      noteSetPolicyLimit,
      gatePolicyLimit,
      candidateLimit
    },
    rankingModes: {
      strictSymbolic: {
        id: 'strict_symbolic',
        stableRecallEpsilon: null
      },
      gameplayLexicographic: {
        id: 'gameplay_note_centric_lexicographic',
        stableRecallEpsilon: null
      },
      gameplayRecallEpsilon: {
        id: 'gameplay_note_centric_recall_epsilon',
        stableRecallEpsilon: gameplayRecallEpsilon
      }
    },
    best: {
      strict: {
        byAlgorithm: strictBestByAlgorithm,
        combined: strictBestCombined
      },
      gameplayLexicographic: {
        byAlgorithm: gameplayLexicographicBestByAlgorithm,
        combined: gameplayLexicographicBestCombined
      },
      gameplayRecallEpsilon: {
        byAlgorithm: gameplayRecallEpsilonBestByAlgorithm,
        combined: gameplayRecallEpsilonBestCombined
      }
    },
    leaderboards: {
      strict: {
        perAlgorithm: strictPerAlgorithm,
        combined: strictCombined
      },
      gameplayLexicographic: {
        perAlgorithm: gameplayLexicographicPerAlgorithm,
        combined: gameplayLexicographicCombined
      },
      gameplayRecallEpsilon: {
        perAlgorithm: gameplayRecallEpsilonPerAlgorithm,
        combined: gameplayRecallEpsilonCombined
      }
    }
  };

  await fs.writeFile(path.join(sweepDir, 'leaderboard.json'), `${JSON.stringify(jsonDoc, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    path.join(sweepDir, 'leaderboard.md'),
    buildLeaderboardMarkdown(
      gameplayRecallEpsilon,
      strictPerAlgorithm,
      gameplayLexicographicPerAlgorithm,
      gameplayRecallEpsilonPerAlgorithm,
      strictCombined,
      gameplayLexicographicCombined,
      gameplayRecallEpsilonCombined,
      strictBestByAlgorithm,
      gameplayLexicographicBestByAlgorithm,
      gameplayRecallEpsilonBestByAlgorithm,
      strictBestCombined,
      gameplayLexicographicBestCombined,
      gameplayRecallEpsilonBestCombined
    ),
    'utf8'
  );

  console.log(`[gameplay-validator-poly-sweep] strict combined best: ${describeBest(strictBestCombined)}`);
  console.log(`[gameplay-validator-poly-sweep] gameplay lexicographic combined best: ${describeBest(gameplayLexicographicBestCombined)}`);
  console.log(`[gameplay-validator-poly-sweep] gameplay epsilon combined best (eps=${formatRecallEpsilon(gameplayRecallEpsilon)}): ${describeBest(gameplayRecallEpsilonBestCombined)}`);
  console.log(`[gameplay-validator-poly-sweep] candidates: ${entries.length}`);
  console.log(`[gameplay-validator-poly-sweep] outputs: ${SWEEP_ROOT}`);
}

function buildDecisionConfigs(): ValidatorDecisionConfig[] {
  const base = deriveConfigWithMode(DEFAULT_VALIDATOR_DECISION_CONFIG, 'note_only');

  const minExpectedFrameRatio = [0.04, 0.08];
  const minConsecutiveExpectedFrames = [1, 2];
  const minExpectedConfidence = [0.2, 0.35, 0.45];
  const minExpectedVsBestMargin = [-1_000_000, 0];
  const minExpectedVsOctaveMargin = [-1_000_000, 0];
  const minExpectedTop1FrameRatio = [0, 0.2];
  const minExpectedTop3FrameRatio = [0, 0.4];

  const out: ValidatorDecisionConfig[] = [];
  for (const frameRatio of minExpectedFrameRatio) {
    for (const consecutive of minConsecutiveExpectedFrames) {
      for (const confidence of minExpectedConfidence) {
        for (const bestMargin of minExpectedVsBestMargin) {
          for (const octaveMargin of minExpectedVsOctaveMargin) {
            for (const top1Ratio of minExpectedTop1FrameRatio) {
              for (const top3Ratio of minExpectedTop3FrameRatio) {
                out.push({
                  ...base,
                  id: [
                    'poly_sweep_note_only',
                    `fr${toIdScale(frameRatio)}`,
                    `ce${consecutive}`,
                    `cf${toIdScale(confidence)}`,
                    `mb${toIdScale(bestMargin)}`,
                    `mo${toIdScale(octaveMargin)}`,
                    `t1${toIdScale(top1Ratio)}`,
                    `t3${toIdScale(top3Ratio)}`
                  ].join('_'),
                  label: 'Poly sweep note-only decision',
                  mode: 'note_only',
                  note: {
                    ...base.note,
                    minExpectedFrameRatio: frameRatio,
                    minConsecutiveExpectedFrames: consecutive,
                    minExpectedConfidence: confidence,
                    minExpectedVsBestMargin: bestMargin,
                    minExpectedVsOctaveMargin: octaveMargin,
                    minExpectedTop1FrameRatio: top1Ratio,
                    minExpectedTop3FrameRatio: top3Ratio
                  }
                });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

function buildPolicyConfigs(): NoteSetAggregationPolicy[] {
  const policies: NoteSetAggregationPolicy[] = [];
  const addPolicy = (policy: NoteSetAggregationPolicy) => {
    policies.push(policy);
  };

  addPolicy({
    ...DEFAULT_NOTE_SET_POLICY,
    id: 'poly_policy_strict_exact',
    mode: 'all_notes_required',
    minNoteRatio: 1,
    minNoteCount: 1,
    maxExtraDetectedNotes: 0,
    allowSupersetIfExpectedCovered: false,
    emptyWindowMustBeQuiet: true
  });

  for (const ratio of [0.5, 0.67, 0.75, 1.0]) {
    addPolicy({
      ...DEFAULT_NOTE_SET_POLICY,
      id: `poly_policy_gameplay_ratio_${toIdScale(ratio)}_superset`,
      mode: 'min_ratio_required',
      minNoteRatio: ratio,
      minNoteCount: 1,
      maxExtraDetectedNotes: null,
      allowSupersetIfExpectedCovered: true,
      emptyWindowMustBeQuiet: true
    });
    addPolicy({
      ...DEFAULT_NOTE_SET_POLICY,
      id: `poly_policy_ratio_${toIdScale(ratio)}_maxextra1`,
      mode: 'min_ratio_required',
      minNoteRatio: ratio,
      minNoteCount: 1,
      maxExtraDetectedNotes: 1,
      allowSupersetIfExpectedCovered: true,
      emptyWindowMustBeQuiet: true
    });
  }

  for (const count of [1, 2, 3]) {
    addPolicy({
      ...DEFAULT_NOTE_SET_POLICY,
      id: `poly_policy_min_count_${count}_strict_extra0`,
      mode: 'min_count_required',
      minNoteCount: count,
      minNoteRatio: 0,
      maxExtraDetectedNotes: 0,
      allowSupersetIfExpectedCovered: false,
      emptyWindowMustBeQuiet: true
    });
    addPolicy({
      ...DEFAULT_NOTE_SET_POLICY,
      id: `poly_policy_min_count_${count}_gameplay`,
      mode: 'min_count_required',
      minNoteCount: count,
      minNoteRatio: 0,
      maxExtraDetectedNotes: 1,
      allowSupersetIfExpectedCovered: true,
      emptyWindowMustBeQuiet: true
    });
  }

  return policies;
}

function buildActivationGateConfigs(): ActivationGatePolicy[] {
  const configs: ActivationGatePolicy[] = [];
  const add = (policy: ActivationGatePolicy) => configs.push(policy);

  add({
    ...DEFAULT_ACTIVATION_GATE_POLICY,
    id: 'gate_disabled_passthrough',
    gateEnabled: false
  });

  add({
    ...DEFAULT_ACTIVATION_GATE_POLICY,
    id: 'gate_default_v1',
    gateEnabled: true
  });

  add({
    ...DEFAULT_ACTIVATION_GATE_POLICY,
    id: 'gate_empty_strict_transition_mild',
    gateEnabled: true,
    emptyWindowMustBeQuiet: true,
    emptyWindowMaxValidatedNotes: 0,
    emptyWindowMaxExtraNotes: 0,
    emptyWindowMaxConfidence: 0.4,
    transitionMinStableRatio: 0.82,
    transitionMaxOverlapRatio: 0.28,
    transitionMinNoteRatio: 0.75,
    transitionAllowSuperset: false
  });

  add({
    ...DEFAULT_ACTIVATION_GATE_POLICY,
    id: 'gate_empty_strict_transition_strict',
    gateEnabled: true,
    emptyWindowMustBeQuiet: true,
    emptyWindowMaxValidatedNotes: 0,
    emptyWindowMaxExtraNotes: 0,
    emptyWindowMaxConfidence: 0.35,
    transitionMinStableRatio: 0.9,
    transitionMaxOverlapRatio: 0.18,
    transitionMinNoteRatio: 0.85,
    transitionAllowSuperset: false
  });

  add({
    ...DEFAULT_ACTIVATION_GATE_POLICY,
    id: 'gate_transition_exact',
    gateEnabled: true,
    requireExactOnTransition: true,
    transitionMinStableRatio: 0.88,
    transitionMaxOverlapRatio: 0.2,
    transitionMinNoteRatio: 0.8,
    transitionAllowSuperset: false
  });

  add({
    ...DEFAULT_ACTIVATION_GATE_POLICY,
    id: 'gate_gameplay_superset_friendly',
    gateEnabled: true,
    transitionAllowSuperset: true,
    stableAllowSupersetIfExpectedCovered: true,
    transitionMinStableRatio: 0.84,
    transitionMaxOverlapRatio: 0.25,
    transitionMinNoteRatio: 0.72
  });

  add({
    ...DEFAULT_ACTIVATION_GATE_POLICY,
    id: 'gate_with_hysteresis_2',
    gateEnabled: true,
    hysteresisFrames: 2,
    transitionMinStableRatio: 0.86,
    transitionMaxOverlapRatio: 0.22,
    transitionMinNoteRatio: 0.8
  });

  return configs;
}

function buildCombinedMetrics(
  byAlgorithm: Record<AlgorithmName, NoteSetMetrics>,
  mode: 'strict_symbolic' | 'gameplay_note_centric'
): CombinedModeMetrics {
  const postRecalls = ALGORITHMS.map((algorithm) => byAlgorithm[algorithm].postGateExpectedNoteRecall ?? byAlgorithm[algorithm].expectedNoteRecall ?? 0);
  const stableRecalls = ALGORITHMS.map((algorithm) => byAlgorithm[algorithm].postGateStableNonEmptyExpectedNoteRecall ?? byAlgorithm[algorithm].stableNonEmptyExpectedNoteRecall ?? 0);
  const emptyFars = ALGORITHMS.map((algorithm) => byAlgorithm[algorithm].postGateEmptyWindowFalseAcceptRate ?? byAlgorithm[algorithm].emptyWindowFalseAcceptRate ?? 1);
  const transitionAccepts = ALGORITHMS.map((algorithm) => byAlgorithm[algorithm].postGateTransitionWindowAcceptRate ?? byAlgorithm[algorithm].transitionWindowAcceptRate ?? 1);
  const extraRates = ALGORITHMS.map((algorithm) => byAlgorithm[algorithm].postGateExtraNoteRate ?? byAlgorithm[algorithm].extraNoteRate ?? 1);
  const exactRates = ALGORITHMS.map((algorithm) => byAlgorithm[algorithm].postGateExactSetRate ?? byAlgorithm[algorithm].exactSetMatchRate ?? 0);
  const stableSupersetAccepts = ALGORITHMS.map((algorithm) =>
    byAlgorithm[algorithm].postGateStableNonEmptySupersetAcceptRate
    ?? byAlgorithm[algorithm].postGateStableNonEmptySupersetRate
    ?? byAlgorithm[algorithm].stableNonEmptySupersetRate
    ?? 0
  );
  const runtimes = ALGORITHMS.map((algorithm) => byAlgorithm[algorithm].averagePerNoteRuntimeMs ?? 0);

  const avgPostRecall = average(postRecalls);
  const avgStableRecall = average(stableRecalls);
  const avgEmptyFar = average(emptyFars);
  const avgTransitionAccept = average(transitionAccepts);
  const avgExtraNoteRate = average(extraRates);
  const avgExactRate = average(exactRates);
  const avgStableSupersetAccept = average(stableSupersetAccepts);
  const avgRuntimeMs = average(runtimes);

  const runtimeScore = 1 / (1 + avgRuntimeMs);
  const score = mode === 'strict_symbolic'
    ? 100 * (
      0.32 * avgPostRecall +
      0.20 * (1 - avgEmptyFar) +
      0.18 * (1 - avgTransitionAccept) +
      0.14 * (1 - avgExtraNoteRate) +
      0.10 * avgExactRate +
      0.06 * runtimeScore
    )
    : 100 * (
      0.34 * avgStableRecall +
      0.22 * (1 - avgEmptyFar) +
      0.18 * (1 - avgTransitionAccept) +
      0.12 * (1 - avgExtraNoteRate) +
      0.08 * avgStableSupersetAccept +
      0.06 * runtimeScore
    );

  return {
    avgPostRecall,
    avgStableRecall,
    avgEmptyFar,
    avgTransitionAccept,
    avgExtraNoteRate,
    avgExactRate,
    avgStableSupersetAccept,
    avgRuntimeMs,
    score
  };
}

function compareByAlgorithm(
  left: SweepEntry,
  right: SweepEntry,
  algorithm: AlgorithmName,
  mode: RankingMode,
  gameplayRecallEpsilon: number
): number {
  const a = left.byAlgorithm[algorithm];
  const b = right.byAlgorithm[algorithm];

  const leftMetrics = {
    postRecall: a.postGateExpectedNoteRecall ?? a.expectedNoteRecall ?? a.noteLevelRecall ?? 0,
    stableRecall: a.postGateStableNonEmptyExpectedNoteRecall ?? a.stableNonEmptyExpectedNoteRecall ?? 0,
    emptyFar: a.postGateEmptyWindowFalseAcceptRate ?? a.emptyWindowFalseAcceptRate ?? 1,
    transitionAccept: a.postGateTransitionWindowAcceptRate ?? a.transitionWindowAcceptRate ?? 1,
    extraRate: a.postGateExtraNoteRate ?? a.extraNoteRate ?? 1,
    exactRate: a.postGateExactSetRate ?? a.exactSetMatchRate ?? 0,
    stableSupersetAccept: a.postGateStableNonEmptySupersetAcceptRate ?? a.postGateStableNonEmptySupersetRate ?? a.stableNonEmptySupersetRate ?? 0,
    runtimeMs: a.averagePerNoteRuntimeMs ?? Number.POSITIVE_INFINITY
  };
  const rightMetrics = {
    postRecall: b.postGateExpectedNoteRecall ?? b.expectedNoteRecall ?? b.noteLevelRecall ?? 0,
    stableRecall: b.postGateStableNonEmptyExpectedNoteRecall ?? b.stableNonEmptyExpectedNoteRecall ?? 0,
    emptyFar: b.postGateEmptyWindowFalseAcceptRate ?? b.emptyWindowFalseAcceptRate ?? 1,
    transitionAccept: b.postGateTransitionWindowAcceptRate ?? b.transitionWindowAcceptRate ?? 1,
    extraRate: b.postGateExtraNoteRate ?? b.extraNoteRate ?? 1,
    exactRate: b.postGateExactSetRate ?? b.exactSetMatchRate ?? 0,
    stableSupersetAccept: b.postGateStableNonEmptySupersetAcceptRate ?? b.postGateStableNonEmptySupersetRate ?? b.stableNonEmptySupersetRate ?? 0,
    runtimeMs: b.averagePerNoteRuntimeMs ?? Number.POSITIVE_INFINITY
  };

  let comparison = 0;
  if (mode === 'strict_symbolic') {
    comparison = compareStrictSymbolicAlgorithmMetrics(leftMetrics, rightMetrics);
  } else if (mode === 'gameplay_lexicographic') {
    comparison = compareGameplayLexicographicAlgorithmMetrics(leftMetrics, rightMetrics);
  } else {
    comparison = compareGameplayRecallEpsilonAlgorithmMetrics(leftMetrics, rightMetrics, gameplayRecallEpsilon);
  }
  if (comparison !== 0) return comparison;

  return describeEntryId(left).localeCompare(describeEntryId(right));
}

function compareCombined(
  left: SweepEntry,
  right: SweepEntry,
  mode: RankingMode,
  gameplayRecallEpsilon: number
): number {
  const a = mode === 'strict_symbolic' ? left.strict : left.gameplay;
  const b = mode === 'strict_symbolic' ? right.strict : right.gameplay;

  const leftMetrics = {
    avgPostRecall: a.avgPostRecall,
    avgStableRecall: a.avgStableRecall,
    avgEmptyFar: a.avgEmptyFar,
    avgTransitionAccept: a.avgTransitionAccept,
    avgExtraNoteRate: a.avgExtraNoteRate,
    avgExactRate: a.avgExactRate,
    avgStableSupersetAccept: a.avgStableSupersetAccept,
    avgRuntimeMs: a.avgRuntimeMs
  };
  const rightMetrics = {
    avgPostRecall: b.avgPostRecall,
    avgStableRecall: b.avgStableRecall,
    avgEmptyFar: b.avgEmptyFar,
    avgTransitionAccept: b.avgTransitionAccept,
    avgExtraNoteRate: b.avgExtraNoteRate,
    avgExactRate: b.avgExactRate,
    avgStableSupersetAccept: b.avgStableSupersetAccept,
    avgRuntimeMs: b.avgRuntimeMs
  };

  let comparison = 0;
  if (mode === 'strict_symbolic') {
    comparison = compareStrictSymbolicCombinedMetrics(leftMetrics, rightMetrics);
  } else if (mode === 'gameplay_lexicographic') {
    comparison = compareGameplayLexicographicCombinedMetrics(leftMetrics, rightMetrics);
  } else {
    comparison = compareGameplayRecallEpsilonCombinedMetrics(leftMetrics, rightMetrics, gameplayRecallEpsilon);
  }
  if (comparison !== 0) return comparison;

  if (a.score !== b.score) return b.score - a.score;
  return describeEntryId(left).localeCompare(describeEntryId(right));
}

function rankEntries(entries: SweepEntry[]): RankedEntry[] {
  return entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function buildLeaderboardMarkdown(
  gameplayRecallEpsilon: number,
  strictPerAlgorithm: Record<AlgorithmName, SweepEntry[]>,
  gameplayLexicographicPerAlgorithm: Record<AlgorithmName, SweepEntry[]>,
  gameplayRecallEpsilonPerAlgorithm: Record<AlgorithmName, SweepEntry[]>,
  strictCombined: RankedEntry[],
  gameplayLexicographicCombined: RankedEntry[],
  gameplayRecallEpsilonCombined: RankedEntry[],
  strictBestByAlgorithm: Record<AlgorithmName, SweepEntry | null>,
  gameplayLexicographicBestByAlgorithm: Record<AlgorithmName, SweepEntry | null>,
  gameplayRecallEpsilonBestByAlgorithm: Record<AlgorithmName, SweepEntry | null>,
  strictBestCombined: RankedEntry | null,
  gameplayLexicographicBestCombined: RankedEntry | null,
  gameplayRecallEpsilonBestCombined: RankedEntry | null
): string {
  const epsilonText = formatRecallEpsilon(gameplayRecallEpsilon);
  const lines: string[] = [
    '# Gameplay Validator Polyphonic Sweep',
    '',
    '## Ranking Modes',
    '',
    '### Mode 1: strict symbolic',
    '1. maximize expected-note recall (post-gate)',
    '2. minimize empty-window false activation (post-gate)',
    '3. minimize transition-window over-acceptance (post-gate)',
    '4. minimize extra-note rate (post-gate)',
    '5. improve exact-set behavior (post-gate)',
    '6. runtime secondary',
    '',
    '### Mode 2: gameplay note-centric (legacy lexicographic)',
    '1. maximize stable non-empty expected-note recall (post-gate)',
    '2. minimize empty-window false activation (post-gate)',
    '3. minimize transition-window accept rate when unstable (post-gate)',
    '4. minimize extra-note rate (post-gate)',
    '5. preserve stable-window superset acceptance when expected notes are covered',
    '6. runtime secondary',
    '',
    `### Mode 3: gameplay note-centric (recall-epsilon, eps=${epsilonText})`,
    `1. treat stable non-empty recall as equivalent when delta <= ${epsilonText}`,
    '2. within equivalent recall: minimize empty-window false activation (post-gate)',
    '3. then minimize transition-window over-acceptance (post-gate)',
    '4. then minimize extra-note rate (post-gate)',
    '5. then minimize set-mismatch proxy (maximize exact-set rate)',
    '6. runtime secondary',
    ''
  ];

  lines.push('## Strict Mode Best Per Algorithm', '');
  lines.push('| Algorithm | Decision config | Note-set policy | Activation gate | Recall | Empty FAR | Transition accept | Extra rate | Exact rate | Runtime (ms) | Score |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const algorithm of ALGORITHMS) {
    const best = strictBestByAlgorithm[algorithm];
    if (!best) {
      lines.push(`| ${algorithm} | none | none | none | - | - | - | - | - | - | - |`);
      continue;
    }
    const metric = best.byAlgorithm[algorithm];
    lines.push(`| ${algorithm} | ${best.decisionConfig.id} | ${best.noteSetPolicy.id} | ${best.activationGatePolicy.id} | ${formatPct(metric.postGateExpectedNoteRecall ?? 0)} | ${formatPct(metric.postGateEmptyWindowFalseAcceptRate ?? 0)} | ${formatPct(metric.postGateTransitionWindowAcceptRate ?? 0)} | ${formatPct(metric.postGateExtraNoteRate ?? 0)} | ${formatPct(metric.postGateExactSetRate ?? 0)} | ${formatNumber(metric.averagePerNoteRuntimeMs, 3)} | ${formatNumber(best.strict.score, 2)} |`);
  }

  lines.push('', '## Gameplay Legacy Lexicographic Best Per Algorithm', '');
  lines.push('| Algorithm | Decision config | Note-set policy | Activation gate | Stable recall | Empty FAR | Transition accept | Extra rate | Stable superset accept | Runtime (ms) | Score |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const algorithm of ALGORITHMS) {
    const best = gameplayLexicographicBestByAlgorithm[algorithm];
    if (!best) {
      lines.push(`| ${algorithm} | none | none | none | - | - | - | - | - | - | - |`);
      continue;
    }
    const metric = best.byAlgorithm[algorithm];
    lines.push(`| ${algorithm} | ${best.decisionConfig.id} | ${best.noteSetPolicy.id} | ${best.activationGatePolicy.id} | ${formatPct(metric.postGateStableNonEmptyExpectedNoteRecall ?? 0)} | ${formatPct(metric.postGateEmptyWindowFalseAcceptRate ?? 0)} | ${formatPct(metric.postGateTransitionWindowAcceptRate ?? 0)} | ${formatPct(metric.postGateExtraNoteRate ?? 0)} | ${formatPct(metric.postGateStableNonEmptySupersetAcceptRate ?? 0)} | ${formatNumber(metric.averagePerNoteRuntimeMs, 3)} | ${formatNumber(best.gameplay.score, 2)} |`);
  }

  lines.push('', `## Gameplay Recall-Epsilon Best Per Algorithm (eps=${epsilonText})`, '');
  lines.push('| Algorithm | Decision config | Note-set policy | Activation gate | Stable recall | Empty FAR | Transition accept | Extra rate | Exact rate | Runtime (ms) | Score |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const algorithm of ALGORITHMS) {
    const best = gameplayRecallEpsilonBestByAlgorithm[algorithm];
    if (!best) {
      lines.push(`| ${algorithm} | none | none | none | - | - | - | - | - | - | - |`);
      continue;
    }
    const metric = best.byAlgorithm[algorithm];
    lines.push(`| ${algorithm} | ${best.decisionConfig.id} | ${best.noteSetPolicy.id} | ${best.activationGatePolicy.id} | ${formatPct(metric.postGateStableNonEmptyExpectedNoteRecall ?? 0)} | ${formatPct(metric.postGateEmptyWindowFalseAcceptRate ?? 0)} | ${formatPct(metric.postGateTransitionWindowAcceptRate ?? 0)} | ${formatPct(metric.postGateExtraNoteRate ?? 0)} | ${formatPct(metric.postGateExactSetRate ?? 0)} | ${formatNumber(metric.averagePerNoteRuntimeMs, 3)} | ${formatNumber(best.gameplay.score, 2)} |`);
  }

  lines.push('', '## Strict Combined Best', '');
  if (strictBestCombined) {
    lines.push(`- Decision config: \`${strictBestCombined.decisionConfig.id}\``);
    lines.push(`- Note-set policy: \`${strictBestCombined.noteSetPolicy.id}\``);
    lines.push(`- Activation gate: \`${strictBestCombined.activationGatePolicy.id}\``);
    lines.push(`- Avg post-gate recall: ${formatPct(strictBestCombined.strict.avgPostRecall)}`);
    lines.push(`- Avg post-gate empty FAR: ${formatPct(strictBestCombined.strict.avgEmptyFar)}`);
    lines.push(`- Avg post-gate transition accept: ${formatPct(strictBestCombined.strict.avgTransitionAccept)}`);
    lines.push(`- Avg post-gate extra-note rate: ${formatPct(strictBestCombined.strict.avgExtraNoteRate)}`);
    lines.push(`- Avg post-gate exact-set rate: ${formatPct(strictBestCombined.strict.avgExactRate)}`);
  } else {
    lines.push('- none');
  }

  lines.push('', '## Gameplay Legacy Lexicographic Combined Best', '');
  if (gameplayLexicographicBestCombined) {
    lines.push(`- Decision config: \`${gameplayLexicographicBestCombined.decisionConfig.id}\``);
    lines.push(`- Note-set policy: \`${gameplayLexicographicBestCombined.noteSetPolicy.id}\``);
    lines.push(`- Activation gate: \`${gameplayLexicographicBestCombined.activationGatePolicy.id}\``);
    lines.push(`- Avg stable post-gate recall: ${formatPct(gameplayLexicographicBestCombined.gameplay.avgStableRecall)}`);
    lines.push(`- Avg post-gate empty FAR: ${formatPct(gameplayLexicographicBestCombined.gameplay.avgEmptyFar)}`);
    lines.push(`- Avg post-gate transition accept: ${formatPct(gameplayLexicographicBestCombined.gameplay.avgTransitionAccept)}`);
    lines.push(`- Avg post-gate extra-note rate: ${formatPct(gameplayLexicographicBestCombined.gameplay.avgExtraNoteRate)}`);
    lines.push(`- Avg stable superset accept: ${formatPct(gameplayLexicographicBestCombined.gameplay.avgStableSupersetAccept)}`);
  } else {
    lines.push('- none');
  }

  lines.push('', `## Gameplay Recall-Epsilon Combined Best (eps=${epsilonText})`, '');
  if (gameplayRecallEpsilonBestCombined) {
    lines.push(`- Decision config: \`${gameplayRecallEpsilonBestCombined.decisionConfig.id}\``);
    lines.push(`- Note-set policy: \`${gameplayRecallEpsilonBestCombined.noteSetPolicy.id}\``);
    lines.push(`- Activation gate: \`${gameplayRecallEpsilonBestCombined.activationGatePolicy.id}\``);
    lines.push(`- Avg stable post-gate recall: ${formatPct(gameplayRecallEpsilonBestCombined.gameplay.avgStableRecall)}`);
    lines.push(`- Avg post-gate empty FAR: ${formatPct(gameplayRecallEpsilonBestCombined.gameplay.avgEmptyFar)}`);
    lines.push(`- Avg post-gate transition accept: ${formatPct(gameplayRecallEpsilonBestCombined.gameplay.avgTransitionAccept)}`);
    lines.push(`- Avg post-gate extra-note rate: ${formatPct(gameplayRecallEpsilonBestCombined.gameplay.avgExtraNoteRate)}`);
    lines.push(`- Avg post-gate exact-set rate: ${formatPct(gameplayRecallEpsilonBestCombined.gameplay.avgExactRate)}`);
  } else {
    lines.push('- none');
  }

  lines.push('', '## Strict Top 10 Combined', '');
  lines.push('| Rank | Decision config | Note-set policy | Activation gate | Avg recall | Avg empty FAR | Avg transition accept | Avg extra rate | Avg exact rate | Avg runtime (ms) | Score |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  strictCombined.slice(0, 10).forEach((entry) => {
    lines.push(`| ${entry.rank} | ${entry.decisionConfig.id} | ${entry.noteSetPolicy.id} | ${entry.activationGatePolicy.id} | ${formatPct(entry.strict.avgPostRecall)} | ${formatPct(entry.strict.avgEmptyFar)} | ${formatPct(entry.strict.avgTransitionAccept)} | ${formatPct(entry.strict.avgExtraNoteRate)} | ${formatPct(entry.strict.avgExactRate)} | ${formatNumber(entry.strict.avgRuntimeMs, 3)} | ${formatNumber(entry.strict.score, 2)} |`);
  });

  lines.push('', '## Gameplay Legacy Lexicographic Top 10 Combined', '');
  lines.push('| Rank | Decision config | Note-set policy | Activation gate | Avg stable recall | Avg empty FAR | Avg transition accept | Avg extra rate | Avg stable superset accept | Avg runtime (ms) | Score |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  gameplayLexicographicCombined.slice(0, 10).forEach((entry) => {
    lines.push(`| ${entry.rank} | ${entry.decisionConfig.id} | ${entry.noteSetPolicy.id} | ${entry.activationGatePolicy.id} | ${formatPct(entry.gameplay.avgStableRecall)} | ${formatPct(entry.gameplay.avgEmptyFar)} | ${formatPct(entry.gameplay.avgTransitionAccept)} | ${formatPct(entry.gameplay.avgExtraNoteRate)} | ${formatPct(entry.gameplay.avgStableSupersetAccept)} | ${formatNumber(entry.gameplay.avgRuntimeMs, 3)} | ${formatNumber(entry.gameplay.score, 2)} |`);
  });

  lines.push('', `## Gameplay Recall-Epsilon Top 10 Combined (eps=${epsilonText})`, '');
  lines.push('| Rank | Decision config | Note-set policy | Activation gate | Avg stable recall | Avg empty FAR | Avg transition accept | Avg extra rate | Avg exact rate | Avg runtime (ms) | Score |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  gameplayRecallEpsilonCombined.slice(0, 10).forEach((entry) => {
    lines.push(`| ${entry.rank} | ${entry.decisionConfig.id} | ${entry.noteSetPolicy.id} | ${entry.activationGatePolicy.id} | ${formatPct(entry.gameplay.avgStableRecall)} | ${formatPct(entry.gameplay.avgEmptyFar)} | ${formatPct(entry.gameplay.avgTransitionAccept)} | ${formatPct(entry.gameplay.avgExtraNoteRate)} | ${formatPct(entry.gameplay.avgExactRate)} | ${formatNumber(entry.gameplay.avgRuntimeMs, 3)} | ${formatNumber(entry.gameplay.score, 2)} |`);
  });

  for (const algorithm of ALGORITHMS) {
    lines.push('', `## ${algorithm} Strict Top 10`, '');
    lines.push('| Rank | Decision config | Note-set policy | Activation gate | Recall | Empty FAR | Transition accept | Extra rate | Exact rate | Runtime (ms) |');
    lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    strictPerAlgorithm[algorithm].slice(0, 10).forEach((entry, index) => {
      const metric = entry.byAlgorithm[algorithm];
      lines.push(`| ${index + 1} | ${entry.decisionConfig.id} | ${entry.noteSetPolicy.id} | ${entry.activationGatePolicy.id} | ${formatPct(metric.postGateExpectedNoteRecall ?? 0)} | ${formatPct(metric.postGateEmptyWindowFalseAcceptRate ?? 0)} | ${formatPct(metric.postGateTransitionWindowAcceptRate ?? 0)} | ${formatPct(metric.postGateExtraNoteRate ?? 0)} | ${formatPct(metric.postGateExactSetRate ?? 0)} | ${formatNumber(metric.averagePerNoteRuntimeMs, 3)} |`);
    });
  }

  for (const algorithm of ALGORITHMS) {
    lines.push('', `## ${algorithm} Gameplay Legacy Lexicographic Top 10`, '');
    lines.push('| Rank | Decision config | Note-set policy | Activation gate | Stable recall | Empty FAR | Transition accept | Extra rate | Stable superset accept | Runtime (ms) |');
    lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    gameplayLexicographicPerAlgorithm[algorithm].slice(0, 10).forEach((entry, index) => {
      const metric = entry.byAlgorithm[algorithm];
      lines.push(`| ${index + 1} | ${entry.decisionConfig.id} | ${entry.noteSetPolicy.id} | ${entry.activationGatePolicy.id} | ${formatPct(metric.postGateStableNonEmptyExpectedNoteRecall ?? 0)} | ${formatPct(metric.postGateEmptyWindowFalseAcceptRate ?? 0)} | ${formatPct(metric.postGateTransitionWindowAcceptRate ?? 0)} | ${formatPct(metric.postGateExtraNoteRate ?? 0)} | ${formatPct(metric.postGateStableNonEmptySupersetAcceptRate ?? 0)} | ${formatNumber(metric.averagePerNoteRuntimeMs, 3)} |`);
    });
  }

  for (const algorithm of ALGORITHMS) {
    lines.push('', `## ${algorithm} Gameplay Recall-Epsilon Top 10`, '');
    lines.push('| Rank | Decision config | Note-set policy | Activation gate | Stable recall | Empty FAR | Transition accept | Extra rate | Exact rate | Runtime (ms) |');
    lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    gameplayRecallEpsilonPerAlgorithm[algorithm].slice(0, 10).forEach((entry, index) => {
      const metric = entry.byAlgorithm[algorithm];
      lines.push(`| ${index + 1} | ${entry.decisionConfig.id} | ${entry.noteSetPolicy.id} | ${entry.activationGatePolicy.id} | ${formatPct(metric.postGateStableNonEmptyExpectedNoteRecall ?? 0)} | ${formatPct(metric.postGateEmptyWindowFalseAcceptRate ?? 0)} | ${formatPct(metric.postGateTransitionWindowAcceptRate ?? 0)} | ${formatPct(metric.postGateExtraNoteRate ?? 0)} | ${formatPct(metric.postGateExactSetRate ?? 0)} | ${formatNumber(metric.averagePerNoteRuntimeMs, 3)} |`);
    });
  }

  lines.push('');
  return lines.join('\n');
}

function describeBest(best: RankedEntry | null): string {
  if (!best) return 'none';
  return `${best.decisionConfig.id} + ${best.noteSetPolicy.id} + ${best.activationGatePolicy.id}`;
}

function describeEntryId(entry: SweepEntry): string {
  return `${entry.decisionConfig.id}__${entry.noteSetPolicy.id}__${entry.activationGatePolicy.id}`;
}

function toIdScale(value: number): string {
  return value.toString().replace('-', 'm').replace('.', 'p');
}

function formatNumber(value: number | null, digits: number): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return roundNumber(value, digits).toFixed(digits);
}

function average(values: number[]): number {
  if (values.length <= 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseEnvLimit(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseRecallEpsilonFromEnv(name: string): number {
  const raw = process.env[name];
  if (!raw) return normalizeRecallEpsilon(null);
  const parsed = Number.parseFloat(raw);
  return normalizeRecallEpsilon(parsed);
}

async function loadDiagnostics(filePath: string): Promise<DiagnosticsDoc> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as DiagnosticsDoc;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

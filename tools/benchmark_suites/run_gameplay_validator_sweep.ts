#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ALGORITHMS,
  DEFAULT_VALIDATOR_DECISION_CONFIG,
  deriveConfigWithMode,
  evaluateRowsForConfig,
  type AlgorithmName,
  type DecisionMode,
  type ValidatorAggregate,
  type ValidatorCaseTelemetry,
  type ValidatorDecisionConfig
} from './gameplay_validator_core';
import {
  MONO_ACTIVATION_GATE_POLICY,
  MONO_NOTE_SET_POLICY
} from './gameplay_validator_polyphonic';
import { formatPct } from './shared';

const OUTPUT_ROOT = 'analysis/gameplay_validator_benchmark';
const SWEEP_ROOT = path.join(OUTPUT_ROOT, 'sweep');
const DIAGNOSTICS_FILE = path.join(OUTPUT_ROOT, 'diagnostics.json');
const MODES: DecisionMode[] = ['note_only', 'exact_position'];

type AlgorithmMetrics = {
  tar: number;
  strictFar: number;
  noteMismatchFar: number;
  positionOnlyFar: number;
  runtimeAvgMs: number;
  tar100Pass: boolean;
};

type SweepEntry = {
  rank: number;
  config: ValidatorDecisionConfig;
  mode: DecisionMode;
  algorithms: Record<AlgorithmName, AlgorithmMetrics>;
  combined: {
    bothTar100Pass: boolean;
    minTar: number;
    avgStrictFar: number;
    avgNoteMismatchFar: number;
    avgPositionOnlyFar: number;
    avgRuntimeAvgMs: number;
  };
};

type DiagnosticsDoc = {
  caseTelemetry: ValidatorCaseTelemetry[];
};

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const diagnosticsPath = path.resolve(repoRoot, DIAGNOSTICS_FILE);
  const sweepDir = path.resolve(repoRoot, SWEEP_ROOT);
  await fs.mkdir(sweepDir, { recursive: true });

  const diagnostics = await loadDiagnostics(diagnosticsPath);
  const telemetry = diagnostics.caseTelemetry;
  if (!Array.isArray(telemetry) || telemetry.length === 0) {
    throw new Error(`No telemetry rows found in ${diagnosticsPath}. Run benchmark:suite:gameplay-validator first.`);
  }

  const candidates = buildSweepConfigs();
  const evaluated = candidates.map((config) => evaluateSweepEntry(telemetry, config));

  const byMode = Object.fromEntries(
    MODES.map((mode) => {
      const modeEntries = evaluated.filter((entry) => entry.mode === mode);
      const perAlgorithm = Object.fromEntries(ALGORITHMS.map((algorithm) => {
        const ranked = [...modeEntries].sort((left, right) => compareByAlgorithm(left, right, algorithm));
        ranked.forEach((entry, index) => {
          if (algorithm === ALGORITHMS[0]) entry.rank = index + 1;
        });
        return [algorithm, ranked];
      })) as Record<AlgorithmName, SweepEntry[]>;
      const combined = [...modeEntries].sort(compareCombined);
      return [mode, { perAlgorithm, combined }];
    })
  ) as Record<DecisionMode, { perAlgorithm: Record<AlgorithmName, SweepEntry[]>; combined: SweepEntry[] }>;

  const fixedPolicies = buildFixedPolicies();
  const fixedComparisons = fixedPolicies.map((config) => evaluateSweepEntry(telemetry, config));

  const bestByAlgorithmAndMode = Object.fromEntries(
    MODES.map((mode) => {
      const byAlgorithm = Object.fromEntries(ALGORITHMS.map((algorithm) => {
        const ranked = byMode[mode].perAlgorithm[algorithm];
        const best = ranked.find((entry) => entry.algorithms[algorithm].tar100Pass) ?? ranked[0] ?? null;
        return [algorithm, best];
      })) as Record<AlgorithmName, SweepEntry | null>;
      return [mode, byAlgorithm];
    })
  ) as Record<DecisionMode, Record<AlgorithmName, SweepEntry | null>>;

  const jsonDoc = {
    generatedAtIso: new Date().toISOString(),
    sourceDiagnostics: DIAGNOSTICS_FILE,
    candidateCount: candidates.length,
    noteDecisionConfigId: DEFAULT_VALIDATOR_DECISION_CONFIG.id,
    aggregationPolicyId: MONO_NOTE_SET_POLICY.id,
    activationGatePolicyId: MONO_ACTIVATION_GATE_POLICY.id,
    modeA_fixedPolicyComparison: fixedComparisons,
    modeB_bestUnderConstraint: {
      bestByAlgorithmAndMode,
      leaderboards: byMode
    }
  };

  await fs.writeFile(path.join(sweepDir, 'leaderboard.json'), `${JSON.stringify(jsonDoc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(sweepDir, 'best_config.json'), `${JSON.stringify(bestByAlgorithmAndMode, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(sweepDir, 'leaderboard.md'), buildLeaderboardMarkdown(fixedComparisons, byMode, bestByAlgorithmAndMode), 'utf8');

  const noteBestMasp = bestByAlgorithmAndMode.note_only.MASP?.config.id ?? 'none';
  const noteBestSpectral = bestByAlgorithmAndMode.note_only.spectral_game_runtime_unified_v3?.config.id ?? 'none';
  const exactBestMasp = bestByAlgorithmAndMode.exact_position.MASP?.config.id ?? 'none';
  const exactBestSpectral = bestByAlgorithmAndMode.exact_position.spectral_game_runtime_unified_v3?.config.id ?? 'none';

  console.log(`[gameplay-validator-sweep] candidates: ${candidates.length}`);
  console.log(`[gameplay-validator-sweep] note_only best: MASP=${noteBestMasp}, spectral=${noteBestSpectral}`);
  console.log(`[gameplay-validator-sweep] exact_position best: MASP=${exactBestMasp}, spectral=${exactBestSpectral}`);
  console.log(`[gameplay-validator-sweep] outputs: ${SWEEP_ROOT}`);
}

function buildFixedPolicies(): ValidatorDecisionConfig[] {
  const noteOnly = {
    ...deriveConfigWithMode(DEFAULT_VALIDATOR_DECISION_CONFIG, 'note_only'),
    id: 'fixed_shared_policy_note_only_v1',
    label: 'Fixed shared policy (note_only)'
  };
  const exactPosition = {
    ...deriveConfigWithMode(DEFAULT_VALIDATOR_DECISION_CONFIG, 'exact_position'),
    id: 'fixed_shared_policy_exact_position_v1',
    label: 'Fixed shared policy (exact_position)'
  };
  return [noteOnly, exactPosition];
}

function buildSweepConfigs(): ValidatorDecisionConfig[] {
  const base = DEFAULT_VALIDATOR_DECISION_CONFIG;
  const minExpectedScore = [0];
  const minExpectedSupportSeconds = [0.02, 0.04];
  const minConsecutiveExpectedFrames = [1, 2];
  const minExpectedVsBestMargin = [-1000000, 0];
  const minExpectedVsBestRatio = [0, 1.0];
  const minExpectedVsOctaveMargin = [-1000000, 0];
  const minExpectedTop1FrameRatio = [0, 0.25];
  const minExpectedTop3FrameRatio = [0];
  const minExpectedPairwiseWinRate = [0, 0.6];
  const maxOctaveConfusionFrameRatio = [1];
  const minExpectedVsSourceFrameRatio = [0, 0.6];
  const minPositionFrameRatio = [0.3, 0.45];
  const minConsecutivePositionFrames = [1, 2];

  const out: ValidatorDecisionConfig[] = [];
  for (const mode of MODES) {
    for (const score of minExpectedScore) {
      for (const supportSeconds of minExpectedSupportSeconds) {
        for (const consecutive of minConsecutiveExpectedFrames) {
          for (const bestMargin of minExpectedVsBestMargin) {
            for (const bestRatio of minExpectedVsBestRatio) {
              for (const octaveMargin of minExpectedVsOctaveMargin) {
                for (const top1Ratio of minExpectedTop1FrameRatio) {
                  for (const top3Ratio of minExpectedTop3FrameRatio) {
                    for (const pairwiseRate of minExpectedPairwiseWinRate) {
                      for (const octaveConf of maxOctaveConfusionFrameRatio) {
                        for (const vsSource of minExpectedVsSourceFrameRatio) {
                          for (const positionRatio of minPositionFrameRatio) {
                            for (const positionConsecutive of minConsecutivePositionFrames) {
                              out.push({
                                ...base,
                                id: `sweep_${mode}_s${toIdScale(score)}_ss${toIdScale(supportSeconds)}_ce${consecutive}_mb${toIdScale(bestMargin)}_rb${toIdScale(bestRatio)}_mo${toIdScale(octaveMargin)}_t1${toIdScale(top1Ratio)}_t3${toIdScale(top3Ratio)}_pw${toIdScale(pairwiseRate)}_oc${toIdScale(octaveConf)}_vs${toIdScale(vsSource)}_rp${toIdScale(positionRatio)}_cp${positionConsecutive}`,
                                label: `Sweep ${mode}`,
                                mode,
                                note: {
                                  ...base.note,
                                  minExpectedScore: score,
                                  minExpectedSupportSeconds: supportSeconds,
                                  minConsecutiveExpectedFrames: consecutive,
                                  minExpectedVsBestMargin: bestMargin,
                                  minExpectedVsBestRatio: bestRatio,
                                  minExpectedVsOctaveMargin: octaveMargin,
                                  minExpectedTop1FrameRatio: top1Ratio,
                                  minExpectedTop3FrameRatio: top3Ratio,
                                  minExpectedPairwiseWinRate: pairwiseRate,
                                  maxOctaveConfusionFrameRatio: octaveConf,
                                  minExpectedVsSourceFrameRatio: vsSource
                                },
                                position: {
                                  ...base.position,
                                  minPositionFrameRatio: positionRatio,
                                  minConsecutivePositionFrames: positionConsecutive,
                                  rejectSamePitchAltFrames: true
                                }
                              });
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

function evaluateSweepEntry(
  telemetry: ValidatorCaseTelemetry[],
  config: ValidatorDecisionConfig
): SweepEntry {
  const { aggregates } = evaluateRowsForConfig(telemetry, config, ALGORITHMS);
  const algorithmMetrics = Object.fromEntries(ALGORITHMS.map((algorithm) => {
    const agg = aggregates[algorithm];
    return [algorithm, {
      tar: agg.tar,
      strictFar: agg.strictFar,
      noteMismatchFar: agg.noteMismatchFar,
      positionOnlyFar: agg.positionOnlyFar,
      runtimeAvgMs: agg.runtimeAvgMs,
      tar100Pass: agg.tar >= 1
    } satisfies AlgorithmMetrics];
  })) as Record<AlgorithmName, AlgorithmMetrics>;

  const tarValues = ALGORITHMS.map((algorithm) => algorithmMetrics[algorithm].tar);
  const strictFarValues = ALGORITHMS.map((algorithm) => algorithmMetrics[algorithm].strictFar);
  const noteMismatchFarValues = ALGORITHMS.map((algorithm) => algorithmMetrics[algorithm].noteMismatchFar);
  const positionOnlyFarValues = ALGORITHMS.map((algorithm) => algorithmMetrics[algorithm].positionOnlyFar);
  const runtimeValues = ALGORITHMS.map((algorithm) => algorithmMetrics[algorithm].runtimeAvgMs);

  return {
    rank: 0,
    config,
    mode: config.mode,
    algorithms: algorithmMetrics,
    combined: {
      bothTar100Pass: ALGORITHMS.every((algorithm) => algorithmMetrics[algorithm].tar100Pass),
      minTar: Math.min(...tarValues),
      avgStrictFar: average(strictFarValues),
      avgNoteMismatchFar: average(noteMismatchFarValues),
      avgPositionOnlyFar: average(positionOnlyFarValues),
      avgRuntimeAvgMs: average(runtimeValues)
    }
  };
}

function compareByAlgorithm(
  a: SweepEntry,
  b: SweepEntry,
  algorithm: AlgorithmName
): number {
  const left = a.algorithms[algorithm];
  const right = b.algorithms[algorithm];
  if (left.tar100Pass !== right.tar100Pass) {
    return left.tar100Pass ? -1 : 1;
  }
  if (left.tar !== right.tar) {
    return right.tar - left.tar;
  }
  if (left.strictFar !== right.strictFar) {
    return left.strictFar - right.strictFar;
  }
  if (left.noteMismatchFar !== right.noteMismatchFar) {
    return left.noteMismatchFar - right.noteMismatchFar;
  }
  if (left.positionOnlyFar !== right.positionOnlyFar) {
    return left.positionOnlyFar - right.positionOnlyFar;
  }
  if (left.runtimeAvgMs !== right.runtimeAvgMs) {
    return left.runtimeAvgMs - right.runtimeAvgMs;
  }
  return a.config.id.localeCompare(b.config.id);
}

function compareCombined(a: SweepEntry, b: SweepEntry): number {
  if (a.combined.bothTar100Pass !== b.combined.bothTar100Pass) {
    return a.combined.bothTar100Pass ? -1 : 1;
  }
  if (a.combined.minTar !== b.combined.minTar) {
    return b.combined.minTar - a.combined.minTar;
  }
  if (a.combined.avgStrictFar !== b.combined.avgStrictFar) {
    return a.combined.avgStrictFar - b.combined.avgStrictFar;
  }
  if (a.combined.avgNoteMismatchFar !== b.combined.avgNoteMismatchFar) {
    return a.combined.avgNoteMismatchFar - b.combined.avgNoteMismatchFar;
  }
  if (a.combined.avgPositionOnlyFar !== b.combined.avgPositionOnlyFar) {
    return a.combined.avgPositionOnlyFar - b.combined.avgPositionOnlyFar;
  }
  if (a.combined.avgRuntimeAvgMs !== b.combined.avgRuntimeAvgMs) {
    return a.combined.avgRuntimeAvgMs - b.combined.avgRuntimeAvgMs;
  }
  return a.config.id.localeCompare(b.config.id);
}

function toIdScale(value: number): string {
  return value.toString().replace('-', 'm').replace('.', 'p');
}

function average(values: number[]): number {
  if (values.length <= 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildLeaderboardMarkdown(
  fixedComparisons: SweepEntry[],
  byMode: Record<DecisionMode, { perAlgorithm: Record<AlgorithmName, SweepEntry[]>; combined: SweepEntry[] }>,
  bestByAlgorithmAndMode: Record<DecisionMode, Record<AlgorithmName, SweepEntry | null>>
): string {
  const lines: string[] = [
    '# Gameplay Validator Harmonized Sweep',
    '',
    '## Shared Ranking Policy',
    '',
    '1. TAR=100% is a hard pass gate.',
    '2. Then TAR descending.',
    '3. Then strict FAR ascending.',
    '4. Then note-mismatch FAR ascending.',
    '5. Then same-pitch-alt FAR ascending.',
    '6. Then runtime ascending.',
    '',
    `- Note decision config id: ${DEFAULT_VALIDATOR_DECISION_CONFIG.id}.`,
    `- Mono aggregation policy id: ${MONO_NOTE_SET_POLICY.id}.`,
    `- Mono activation gate policy id: ${MONO_ACTIVATION_GATE_POLICY.id}.`,
    '',
    '## Mode A: Fixed Policy Comparison',
    '',
    '| Mode | Config | MASP TAR / strict FAR / note FAR / position FAR | Spectral TAR / strict FAR / note FAR / position FAR |',
    '| --- | --- | --- | --- |',
    ...fixedComparisons.map((entry) => {
      const masp = entry.algorithms.MASP;
      const spectral = entry.algorithms.spectral_game_runtime_unified_v3;
      return `| ${entry.mode} | ${entry.config.id} | ${formatPct(masp.tar)} / ${formatPct(masp.strictFar)} / ${formatPct(masp.noteMismatchFar)} / ${formatPct(masp.positionOnlyFar)} | ${formatPct(spectral.tar)} / ${formatPct(spectral.strictFar)} / ${formatPct(spectral.noteMismatchFar)} / ${formatPct(spectral.positionOnlyFar)} |`;
    }),
    ''
  ];

  for (const mode of MODES) {
    lines.push(`## Mode B (${mode}): Best Under Constraint`, '');
    lines.push('| Algorithm | Best config (TAR=100 hard pass) | TAR | Strict FAR | Note FAR | Position FAR | Runtime avg (ms) |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const algorithm of ALGORITHMS) {
      const best = bestByAlgorithmAndMode[mode][algorithm];
      if (!best) {
        lines.push(`| ${algorithm} | none | n/a | n/a | n/a | n/a | n/a |`);
        continue;
      }
      const metric = best.algorithms[algorithm];
      lines.push(`| ${algorithm} | ${best.config.id} | ${formatPct(metric.tar)} | ${formatPct(metric.strictFar)} | ${formatPct(metric.noteMismatchFar)} | ${formatPct(metric.positionOnlyFar)} | ${metric.runtimeAvgMs.toFixed(3)} |`);
    }
    lines.push('');

    lines.push('### Per-Algorithm Leaderboard (Top 10)', '');
    for (const algorithm of ALGORITHMS) {
      const top = byMode[mode].perAlgorithm[algorithm].slice(0, 10);
      lines.push(`#### ${algorithm}`, '');
      lines.push('| Rank | Config | TAR=100 pass | TAR | Strict FAR | Note FAR | Position FAR | Runtime avg (ms) |');
      lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
      lines.push(...top.map((entry, index) => {
        const metric = entry.algorithms[algorithm];
        return `| ${index + 1} | ${entry.config.id} | ${metric.tar100Pass ? 'yes' : 'no'} | ${formatPct(metric.tar)} | ${formatPct(metric.strictFar)} | ${formatPct(metric.noteMismatchFar)} | ${formatPct(metric.positionOnlyFar)} | ${metric.runtimeAvgMs.toFixed(3)} |`;
      }));
      lines.push('');
    }

    const combinedTop = byMode[mode].combined.slice(0, 10);
    lines.push('### Combined Leaderboard (Top 10)', '');
    lines.push('| Rank | Config | Both TAR=100 pass | Min TAR | Avg strict FAR | Avg note FAR | Avg position FAR | Avg runtime (ms) |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
    lines.push(...combinedTop.map((entry, index) =>
      `| ${index + 1} | ${entry.config.id} | ${entry.combined.bothTar100Pass ? 'yes' : 'no'} | ${formatPct(entry.combined.minTar)} | ${formatPct(entry.combined.avgStrictFar)} | ${formatPct(entry.combined.avgNoteMismatchFar)} | ${formatPct(entry.combined.avgPositionOnlyFar)} | ${entry.combined.avgRuntimeAvgMs.toFixed(3)} |`
    ));
    lines.push('');
  }

  return lines.join('\n');
}

async function loadDiagnostics(filePath: string): Promise<DiagnosticsDoc> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as DiagnosticsDoc;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

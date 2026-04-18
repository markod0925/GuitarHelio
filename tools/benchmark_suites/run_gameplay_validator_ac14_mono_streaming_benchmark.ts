#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { PitchDetectorPreset } from '../../src/audio/dsp-core/gh_dsp_core.js';
import { midiForStringFret } from '../../src/guitar/tuning';
import {
  buildDatasetRows,
  csvEscape,
  decodeMonoAudio,
  formatCsvValue,
  formatNullable,
  formatPct,
  roundNumber,
  roundNullable
} from './shared';
import {
  aggregateMonoResults,
  buildAndroidMonoWindows,
  buildBenchmarkVariantKey,
  buildGuitarSetSoloWindows,
  buildStreamingBenchmarkSweepVariants,
  buildStreamingBenchmarkSweepVariants as buildSweepVariants,
  buildStreamingFrameTimeline,
  buildStreamingBenchmarkSweepVariants as buildTraceAndValidationVariants,
  centsDifference,
  DEFAULT_ANDROID_WINDOW_CONFIG,
  DEFAULT_GUITARSET_WINDOW_CONFIG,
  DEFAULT_MONO_BENCHMARK_CONFIG,
  evaluateMonoWindow,
  formatBenchmarkVariantLabel,
  noteLevelSummary,
  prepareMonoAudioForBenchmark,
  runStreamingTrace,
  selectWindowObservations,
  type AndroidWindowConfig,
  type GuitarSetWindowConfig,
  type MonoAggregateMetrics,
  type MonoBenchmarkConfig,
  type MonoFrameObservation,
  type MonoWindowResult,
  type MonoWindowSpec,
  type SampleRateMode,
  type StreamingTrace
} from './ac14_mono_streaming';
import {
  discoverWavJamsPairs,
  parseJamsNoteEventsFromFile
} from './gameplay_validator_polyphonic';
import { DspCoreDetector } from './shared';

const OUTPUT_ROOT = 'analysis/gameplay_validator_ac14_mono';
const ANDROID_DATASET_ROOT = 'assets/session_20260403_174852';
const GUITARSET_DATASET_ROOT = 'tools/pitch-offline-bench/input/wav';
const SWEEP_ROOT = path.join(OUTPUT_ROOT, 'sweep');

type DatasetName = 'android' | 'guitarset_solo';

type DatasetFileEntry = {
  fileId: string;
  filePath: string;
  relativeFilePath: string;
  durationSec: number;
  windows: MonoWindowSpec[];
};

type TraceSummary = {
  sampleRateMode: SampleRateMode;
  fftSize: 2048 | 4096;
  detectorRuntimeAvgMs: number;
  detectorRuntimeP95Ms: number;
};

type VariantSummary = {
  config: MonoBenchmarkConfig;
  key: string;
  aggregate: MonoAggregateMetrics;
  traceKey: string;
  traceSummary: TraceSummary | null;
};

type DetailedDatasetRun = {
  dataset: DatasetName;
  windowConfig: AndroidWindowConfig | GuitarSetWindowConfig;
  aggregate: MonoAggregateMetrics;
  noteSummary: ReturnType<typeof noteLevelSummary>;
  results: MonoWindowResult[];
  diagnostics: Array<Record<string, unknown>>;
};

type DatasetSweepRun = {
  dataset: DatasetName;
  windowConfig: AndroidWindowConfig | GuitarSetWindowConfig;
  entries: DatasetFileEntry[];
  variantSummaries: VariantSummary[];
  bestVariant: VariantSummary;
  detailed: DetailedDatasetRun;
};

type VariantAccumulator = {
  config: MonoBenchmarkConfig;
  key: string;
  traceKey: string;
  windows: number;
  positiveWindows: number;
  negativeWindows: number;
  stableWindows: number;
  transitionWindows: number;
  guardWindows: number;
  confirmedWindows: number;
  positiveConfirmedWindows: number;
  negativeConfirmedWindows: number;
  noteMismatchConfirmedWindows: number;
  lowBandWindows: number;
  lowBandPositiveWindows: number;
  lowBandNegativeWindows: number;
  lowBandConfirmedWindows: number;
  stableAccepted: number;
  transitionAccepted: number;
  guardAccepted: number;
  totalSelectedFrameCount: number;
  totalTargetHitCount: number;
  totalWrongNoteCount: number;
  totalNoDetectCount: number;
  supportSecondsSum: number;
  targetHitRatioSum: number;
  wrongNoteRatioSum: number;
  noDetectFrameRatioSum: number;
  resetCountSum: number;
  confirmationLatencies: number[];
  confirmationLatenciesFromOnset: number[];
  firstTargetHitLatencies: number[];
  firstAnyHitLatencies: number[];
  validatorRuntimeSamples: number[];
  totalRuntimeSamples: number[];
  traceSummary: TraceSummary | null;
};

type TraceAccumulator = {
  runtimeSamples: number[];
};

type CombinedVariantRow = {
  key: string;
  config: MonoBenchmarkConfig;
  android: MonoAggregateMetrics;
  guitarset: MonoAggregateMetrics;
};

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const outputDir = path.join(repoRoot, OUTPUT_ROOT);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(path.join(outputDir, 'sweep'), { recursive: true });

  const detector = new DspCoreDetector('ac14', PitchDetectorPreset.Ac14, null);
  await detector.init();

  try {
    const sweepVariants = buildSweepVariants();
    const androidWindowConfig = DEFAULT_ANDROID_WINDOW_CONFIG;
    const guitarsetWindowConfig = DEFAULT_GUITARSET_WINDOW_CONFIG;

    const androidEntries = await loadAndroidEntries(repoRoot, androidWindowConfig);
    const guitarsetEntries = await loadGuitarSetEntries(repoRoot, guitarsetWindowConfig);

    const android = await runDatasetSweep({
      dataset: 'android',
      entries: androidEntries,
      detector,
      sweepVariants
    });
    const guitarset = await runDatasetSweep({
      dataset: 'guitarset_solo',
      entries: guitarsetEntries,
      detector,
      sweepVariants
    });

    const combinedRows = combineVariantRows(android.variantSummaries, guitarset.variantSummaries);
    const bestCombined = rankCombinedRows(combinedRows)[0] ?? null;
    const leaderboard = buildLeaderboardDoc(android, guitarset, combinedRows, bestCombined);

    await writeOutputs({
      outputDir,
      android,
      guitarset,
      leaderboard,
      sweepVariants,
      androidWindowConfig,
      guitarsetWindowConfig,
      combinedRows,
      bestCombined
    });

    console.log(`[ac14-streaming] outputs: ${OUTPUT_ROOT}`);
  } finally {
    detector.dispose?.();
  }
}

async function loadAndroidEntries(repoRoot: string, windowConfig: AndroidWindowConfig): Promise<DatasetFileEntry[]> {
  const datasetRows = await buildDatasetRows(path.join(repoRoot, ANDROID_DATASET_ROOT));
  if (datasetRows.length <= 0) {
    throw new Error(`No WAV files found under ${ANDROID_DATASET_ROOT}`);
  }

  const entries: DatasetFileEntry[] = [];
  for (const row of datasetRows) {
    const decoded = await decodeMonoAudio(row.filePath);
    const durationSec = decoded.samples.length / decoded.sampleRate;
    const midi = midiForStringFret(row.stringId, row.fret);
    entries.push({
      fileId: row.fileId,
      filePath: row.filePath,
      relativeFilePath: row.relativeFilePath,
      durationSec,
      windows: buildAndroidMonoWindows({
        datasetRow: row,
        midi,
        durationSec,
        config: windowConfig
      })
    });
  }
  return entries;
}

async function loadGuitarSetEntries(repoRoot: string, windowConfig: GuitarSetWindowConfig): Promise<DatasetFileEntry[]> {
  const pairs = await discoverWavJamsPairs(path.join(repoRoot, GUITARSET_DATASET_ROOT));
  const soloPairs = pairs.filter((pair) => pair.subset === 'solo');
  if (soloPairs.length <= 0) {
    throw new Error(`No _solo WAV/JAMS pairs found under ${GUITARSET_DATASET_ROOT}`);
  }

  const entries: DatasetFileEntry[] = [];
  for (const pair of soloPairs) {
    const [decoded, parsed] = await Promise.all([
      decodeMonoAudio(pair.wavPath),
      parseJamsNoteEventsFromFile(pair.jamsPath)
    ]);
    const durationSec = decoded.samples.length / decoded.sampleRate;
    entries.push({
      fileId: pair.fileId,
      filePath: pair.wavPath,
      relativeFilePath: pair.wavRelativePath,
      durationSec,
      windows: buildGuitarSetSoloWindows({
        fileId: pair.fileId,
        relativeFilePath: pair.wavRelativePath,
        durationSec,
        events: parsed.events,
        config: windowConfig
      })
    });
  }
  return entries;
}

async function runDatasetSweep(input: {
  dataset: DatasetName;
  entries: DatasetFileEntry[];
  detector: DspCoreDetector;
  sweepVariants: MonoBenchmarkConfig[];
}): Promise<DatasetSweepRun> {
  const traceConfigs = uniqueTraceConfigs(input.sweepVariants);
  const validationConfigs = uniqueValidationConfigs(input.sweepVariants);
  const variantAccumulators = new Map<string, VariantAccumulator>();
  const traceAccumulators = new Map<string, TraceAccumulator>();

  for (let entryIndex = 0; entryIndex < input.entries.length; entryIndex += 1) {
    const entry = input.entries[entryIndex];
    const decoded = await decodeMonoAudio(entry.filePath);

    for (const traceConfig of traceConfigs) {
      const prepared = prepareMonoAudioForBenchmark({
        samples: decoded.samples,
        sampleRate: decoded.sampleRate,
        sampleRateMode: traceConfig.sampleRateMode
      });
      const trace = runStreamingTrace({
        detector: input.detector,
        samples: prepared.samples,
        sampleRate: prepared.sampleRate,
        config: traceConfig
      });
      updateTraceAccumulator(traceAccumulators, traceConfig, trace);

      for (const validationConfig of validationConfigs) {
        const config = buildFullVariantConfig(traceConfig, validationConfig);
        const key = buildBenchmarkVariantKey(config);
        const traceKey = buildTraceKey(traceConfig);
        const accumulator = getOrCreateVariantAccumulator(variantAccumulators, config, key, traceKey);
        for (const spec of entry.windows) {
          const result = evaluateMonoWindow({
            spec,
            observations: trace.observations,
            config
          });
          updateVariantAccumulator(accumulator, result);
        }
      }
    }

    if (entryIndex % 16 === 0 || entryIndex + 1 === input.entries.length) {
      console.log(`[ac14-streaming] ${input.dataset} ${entryIndex + 1}/${input.entries.length} ${entry.relativeFilePath}`);
    }
  }

  const variantSummaries = finalizeVariantSummaries(variantAccumulators, traceAccumulators);
  const ranked = rankVariantSummaries(input.dataset, variantSummaries);
  const bestVariant = ranked[0];
  if (!bestVariant) {
    throw new Error(`No benchmark variants produced for ${input.dataset}`);
  }

  const detailed = await runDetailedVariant({
    dataset: input.dataset,
    detector: input.detector,
    entries: input.entries,
    config: bestVariant.config
  });

  return {
    dataset: input.dataset,
    windowConfig: input.dataset === 'android' ? DEFAULT_ANDROID_WINDOW_CONFIG : DEFAULT_GUITARSET_WINDOW_CONFIG,
    entries: input.entries,
    variantSummaries: ranked,
    bestVariant,
    detailed
  };
}

async function runDetailedVariant(input: {
  dataset: DatasetName;
  detector: DspCoreDetector;
  entries: DatasetFileEntry[];
  config: MonoBenchmarkConfig;
}): Promise<DetailedDatasetRun> {
  const results: MonoWindowResult[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  for (const entry of input.entries) {
    const decoded = await decodeMonoAudio(entry.filePath);
    const prepared = prepareMonoAudioForBenchmark({
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      sampleRateMode: input.config.sampleRateMode
    });
    const trace = runStreamingTrace({
      detector: input.detector,
      samples: prepared.samples,
      sampleRate: prepared.sampleRate,
      config: {
        ...input.config,
        frameSizeSamples: input.config.fftSize
      }
    });

    for (const spec of entry.windows) {
      const result = evaluateMonoWindow({
        spec,
        observations: trace.observations,
        config: {
          ...input.config,
          frameSizeSamples: input.config.fftSize
        }
      });
      results.push(result);
      diagnostics.push(compactResult(result));
    }
  }

  const aggregate = aggregateMonoResults(results);
  return {
    dataset: input.dataset,
    windowConfig: input.dataset === 'android' ? DEFAULT_ANDROID_WINDOW_CONFIG : DEFAULT_GUITARSET_WINDOW_CONFIG,
    aggregate,
    noteSummary: noteLevelSummary(results),
    results,
    diagnostics
  };
}

function updateTraceAccumulator(
  accumulators: Map<string, TraceAccumulator>,
  config: MonoBenchmarkConfig,
  trace: StreamingTrace
): void {
  const key = buildTraceKey(config);
  const accumulator = accumulators.get(key) ?? { runtimeSamples: [] };
  accumulator.runtimeSamples.push(...trace.observations.map((obs) => obs.runtimeMs));
  accumulators.set(key, accumulator);
}

function getOrCreateVariantAccumulator(
  accumulators: Map<string, VariantAccumulator>,
  config: MonoBenchmarkConfig,
  key: string,
  traceKey: string
): VariantAccumulator {
  const existing = accumulators.get(key);
  if (existing) return existing;
  const created: VariantAccumulator = {
    config,
    key,
    traceKey,
    windows: 0,
    positiveWindows: 0,
    negativeWindows: 0,
    stableWindows: 0,
    transitionWindows: 0,
    guardWindows: 0,
    confirmedWindows: 0,
    positiveConfirmedWindows: 0,
    negativeConfirmedWindows: 0,
    noteMismatchConfirmedWindows: 0,
    lowBandWindows: 0,
    lowBandPositiveWindows: 0,
    lowBandNegativeWindows: 0,
    lowBandConfirmedWindows: 0,
    stableAccepted: 0,
    transitionAccepted: 0,
    guardAccepted: 0,
    totalSelectedFrameCount: 0,
    totalTargetHitCount: 0,
    totalWrongNoteCount: 0,
    totalNoDetectCount: 0,
    supportSecondsSum: 0,
    targetHitRatioSum: 0,
    wrongNoteRatioSum: 0,
    noDetectFrameRatioSum: 0,
    resetCountSum: 0,
    confirmationLatencies: [],
    confirmationLatenciesFromOnset: [],
    firstTargetHitLatencies: [],
    firstAnyHitLatencies: [],
    validatorRuntimeSamples: [],
    totalRuntimeSamples: [],
    traceSummary: null
  };
  accumulators.set(key, created);
  return created;
}

function updateVariantAccumulator(accumulator: VariantAccumulator, result: MonoWindowResult): void {
  accumulator.windows += 1;
  if (result.expectedAccept) {
    accumulator.positiveWindows += 1;
  } else {
    accumulator.negativeWindows += 1;
  }
  if (result.windowKind === 'stable') accumulator.stableWindows += 1;
  if (result.windowKind === 'transition') accumulator.transitionWindows += 1;
  if (result.windowKind === 'guard') accumulator.guardWindows += 1;
  if (result.accept) {
    accumulator.confirmedWindows += 1;
    if (result.expectedAccept) {
      accumulator.positiveConfirmedWindows += 1;
    } else {
      accumulator.negativeConfirmedWindows += 1;
    }
  }
  if (result.noteMismatch && result.accept && result.expectedAccept) {
    accumulator.noteMismatchConfirmedWindows += 1;
  }
  if (result.sourceBand === 'low') {
    accumulator.lowBandWindows += 1;
    if (result.expectedAccept) {
      accumulator.lowBandPositiveWindows += 1;
      if (result.accept) accumulator.lowBandConfirmedWindows += 1;
    } else {
      accumulator.lowBandNegativeWindows += 1;
      if (result.accept) accumulator.lowBandConfirmedWindows += 1;
    }
  }
  if (result.accept && result.windowKind === 'stable') accumulator.stableAccepted += 1;
  if (result.accept && result.windowKind === 'transition') accumulator.transitionAccepted += 1;
  if (result.accept && result.windowKind === 'guard') accumulator.guardAccepted += 1;

  accumulator.totalSelectedFrameCount += result.evidence.selectedFrameCount;
  accumulator.totalTargetHitCount += result.evidence.targetHitCount;
  accumulator.totalWrongNoteCount += result.evidence.wrongNoteFrameCount;
  accumulator.totalNoDetectCount += result.evidence.noDetectFrameCount;
  accumulator.supportSecondsSum += result.evidence.supportSeconds;
  accumulator.targetHitRatioSum += result.evidence.targetHitRatio;
  accumulator.wrongNoteRatioSum += result.evidence.wrongNoteRatio;
  accumulator.noDetectFrameRatioSum += result.evidence.noDetectFrameRatio;
  accumulator.resetCountSum += result.evidence.resetCount;

  if (result.evidence.confirmationLatencyMs !== null) {
    accumulator.confirmationLatencies.push(result.evidence.confirmationLatencyMs);
  }
  if (result.evidence.confirmationLatencyFromTargetOnsetMs !== null) {
    accumulator.confirmationLatenciesFromOnset.push(result.evidence.confirmationLatencyFromTargetOnsetMs);
  }
  if (result.evidence.firstTargetHitLatencyMs !== null) {
    accumulator.firstTargetHitLatencies.push(result.evidence.firstTargetHitLatencyMs);
  }
  if (result.evidence.firstAnyHitLatencyMs !== null) {
    accumulator.firstAnyHitLatencies.push(result.evidence.firstAnyHitLatencyMs);
  }
  accumulator.validatorRuntimeSamples.push(result.validatorRuntimeMs);
  accumulator.totalRuntimeSamples.push(result.totalRuntimeMs);
}

function finalizeVariantSummaries(
  variantAccumulators: Map<string, VariantAccumulator>,
  traceAccumulators: Map<string, TraceAccumulator>
): VariantSummary[] {
  return [...variantAccumulators.values()].map((accumulator) => {
    const traceSummary = finalizeTraceSummary(accumulator.traceKey, traceAccumulators);
    accumulator.traceSummary = traceSummary;
    return {
      config: accumulator.config,
      key: accumulator.key,
      traceKey: accumulator.traceKey,
      traceSummary,
      aggregate: finalizeVariantAggregate(accumulator, traceSummary)
    };
  });
}

function finalizeTraceSummary(traceKey: string, traceAccumulators: Map<string, TraceAccumulator>): TraceSummary {
  const accumulator = traceAccumulators.get(traceKey);
  if (!accumulator) {
    throw new Error(`Missing trace summary for ${traceKey}`);
  }
  const [sampleRateMode, fftLabel] = traceKey.split('|');
  return {
    sampleRateMode: sampleRateMode as SampleRateMode,
    fftSize: Number(fftLabel.replace(/^fft/, '')) as 2048 | 4096,
    detectorRuntimeAvgMs: average(accumulator.runtimeSamples),
    detectorRuntimeP95Ms: percentile(accumulator.runtimeSamples, 0.95)
  };
}

function finalizeVariantAggregate(accumulator: VariantAccumulator, traceSummary: TraceSummary): MonoAggregateMetrics {
  const precision = accumulator.confirmedWindows > 0
    ? accumulator.positiveConfirmedWindows / accumulator.confirmedWindows
    : 0;
  const recall = accumulator.positiveWindows > 0
    ? accumulator.positiveConfirmedWindows / accumulator.positiveWindows
    : 0;
  const lowBandTar = accumulator.lowBandPositiveWindows > 0
    ? accumulator.lowBandConfirmedWindows / accumulator.lowBandPositiveWindows
    : null;
  const lowBandFar = accumulator.lowBandNegativeWindows > 0
    ? accumulator.lowBandConfirmedWindows / accumulator.lowBandNegativeWindows
    : null;

  return {
    dataset: accumulator.config.sampleRateMode === 'force_48000' || accumulator.config.sampleRateMode === 'force_44100'
      ? 'android'
      : 'android',
    windows: accumulator.windows,
    positiveWindows: accumulator.positiveWindows,
    negativeWindows: accumulator.negativeWindows,
    stableWindows: accumulator.stableWindows,
    transitionWindows: accumulator.transitionWindows,
    guardWindows: accumulator.guardWindows,
    confirmedWindows: accumulator.confirmedWindows,
    confirmedWindowRate: accumulator.windows > 0 ? accumulator.confirmedWindows / accumulator.windows : 0,
    tar: recall,
    strictFar: accumulator.negativeWindows > 0 ? accumulator.negativeConfirmedWindows / accumulator.negativeWindows : 0,
    noteMismatchFar: accumulator.positiveWindows > 0 ? accumulator.noteMismatchConfirmedWindows / accumulator.positiveWindows : 0,
    precision,
    recall,
    lowBandTar,
    lowBandFar,
    stableWindowAcceptRate: accumulator.stableWindows > 0 ? accumulator.stableAccepted / accumulator.stableWindows : null,
    transitionWindowAcceptRate: accumulator.transitionWindows > 0 ? accumulator.transitionAccepted / accumulator.transitionWindows : null,
    guardWindowFalseAcceptRate: accumulator.guardWindows > 0 ? accumulator.guardAccepted / accumulator.guardWindows : null,
    averageSupportSeconds: accumulator.windows > 0 ? accumulator.supportSecondsSum / accumulator.windows : 0,
    averageTargetHitRatio: accumulator.windows > 0 ? accumulator.targetHitRatioSum / accumulator.windows : 0,
    averageWrongNoteRatio: accumulator.windows > 0 ? accumulator.wrongNoteRatioSum / accumulator.windows : 0,
    averageConfirmationLatencyMsAvg: accumulator.confirmationLatencies.length > 0 ? average(accumulator.confirmationLatencies) : null,
    averageConfirmationLatencyMsP95: accumulator.confirmationLatencies.length > 0 ? percentile(accumulator.confirmationLatencies, 0.95) : null,
    averageConfirmationLatencyFromTargetOnsetMsAvg: accumulator.confirmationLatenciesFromOnset.length > 0 ? average(accumulator.confirmationLatenciesFromOnset) : null,
    averageConfirmationLatencyFromTargetOnsetMsP95: accumulator.confirmationLatenciesFromOnset.length > 0 ? percentile(accumulator.confirmationLatenciesFromOnset, 0.95) : null,
    firstTargetHitLatencyMsAvg: accumulator.firstTargetHitLatencies.length > 0 ? average(accumulator.firstTargetHitLatencies) : null,
    firstTargetHitLatencyMsP95: accumulator.firstTargetHitLatencies.length > 0 ? percentile(accumulator.firstTargetHitLatencies, 0.95) : null,
    firstAnyHitLatencyMsAvg: accumulator.firstAnyHitLatencies.length > 0 ? average(accumulator.firstAnyHitLatencies) : null,
    firstAnyHitLatencyMsP95: accumulator.firstAnyHitLatencies.length > 0 ? percentile(accumulator.firstAnyHitLatencies, 0.95) : null,
    noDetectFrameRatio: accumulator.totalSelectedFrameCount > 0 ? accumulator.totalNoDetectCount / accumulator.totalSelectedFrameCount : 0,
    resetCountAvg: accumulator.windows > 0 ? accumulator.resetCountSum / accumulator.windows : 0,
    detectorRuntimeAvgMs: traceSummary.detectorRuntimeAvgMs,
    detectorRuntimeP95Ms: traceSummary.detectorRuntimeP95Ms,
    validatorRuntimeAvgMs: average(accumulator.validatorRuntimeSamples),
    validatorRuntimeP95Ms: percentile(accumulator.validatorRuntimeSamples, 0.95),
    totalRuntimeAvgMs: average(accumulator.totalRuntimeSamples),
    totalRuntimeP95Ms: percentile(accumulator.totalRuntimeSamples, 0.95)
  };
}

function combineVariantRows(android: VariantSummary[], guitarset: VariantSummary[]): CombinedVariantRow[] {
  const guitarByKey = new Map(guitarset.map((row) => [row.key, row]));
  const rows: CombinedVariantRow[] = [];
  for (const androidRow of android) {
    const guitarRow = guitarByKey.get(androidRow.key);
    if (!guitarRow) continue;
    rows.push({
      key: androidRow.key,
      config: androidRow.config,
      android: androidRow.aggregate,
      guitarset: guitarRow.aggregate
    });
  }
  return rows;
}

function rankVariantSummaries(dataset: DatasetName, summaries: VariantSummary[]): VariantSummary[] {
  return [...summaries].sort((left, right) => compareVariantSummaries(dataset, left, right));
}

function compareVariantSummaries(dataset: DatasetName, left: VariantSummary, right: VariantSummary): number {
  const leftMetrics = left.aggregate;
  const rightMetrics = right.aggregate;
  const first = compareNumbers(rightMetrics.tar, leftMetrics.tar);
  if (first !== 0) return first;
  const second = compareNumbers(leftMetrics.noteMismatchFar, rightMetrics.noteMismatchFar);
  if (second !== 0) return second;
  const third = compareNumbers(leftMetrics.strictFar, rightMetrics.strictFar);
  if (third !== 0) return third;
  const fourth = compareNumbers(leftMetrics.lowBandFar ?? Number.POSITIVE_INFINITY, rightMetrics.lowBandFar ?? Number.POSITIVE_INFINITY);
  if (fourth !== 0) return fourth;
  const fifth = compareNumbers(leftMetrics.totalRuntimeAvgMs, rightMetrics.totalRuntimeAvgMs);
  if (fifth !== 0) return fifth;
  const sixth = compareNumbers(leftMetrics.validatorRuntimeAvgMs, rightMetrics.validatorRuntimeAvgMs);
  if (sixth !== 0) return sixth;
  const seventh = compareNumbers(left.config.requiredConsecutiveFrames, right.config.requiredConsecutiveFrames);
  if (seventh !== 0) return seventh;
  const eighth = compareNumbers(left.config.fftSize, right.config.fftSize);
  if (eighth !== 0) return eighth;
  const ninth = compareSampleRatePreference(left.config.sampleRateMode, right.config.sampleRateMode);
  if (ninth !== 0) return ninth;
  return left.key.localeCompare(right.key);
}

function rankCombinedRows(rows: CombinedVariantRow[]): CombinedVariantRow[] {
  return [...rows].sort((left, right) => {
    const a = left.android;
    const b = right.android;
    const first = compareNumbers(b.tar, a.tar);
    if (first !== 0) return first;
    const second = compareNumbers(a.noteMismatchFar, b.noteMismatchFar);
    if (second !== 0) return second;
    const third = compareNumbers(a.strictFar, b.strictFar);
    if (third !== 0) return third;
    const fourth = compareNumbers(a.lowBandFar ?? Number.POSITIVE_INFINITY, b.lowBandFar ?? Number.POSITIVE_INFINITY);
    if (fourth !== 0) return fourth;
    const fifth = compareNumbers(right.guitarset.recall, left.guitarset.recall);
    if (fifth !== 0) return fifth;
    const sixth = compareNumbers(left.guitarset.noteMismatchFar, right.guitarset.noteMismatchFar);
    if (sixth !== 0) return sixth;
    const seventh = compareNumbers(left.guitarset.strictFar, right.guitarset.strictFar);
    if (seventh !== 0) return seventh;
    const eighth = compareNumbers(left.android.totalRuntimeAvgMs + left.guitarset.totalRuntimeAvgMs, right.android.totalRuntimeAvgMs + right.guitarset.totalRuntimeAvgMs);
    if (eighth !== 0) return eighth;
    const ninth = compareNumbers(left.config.requiredConsecutiveFrames, right.config.requiredConsecutiveFrames);
    if (ninth !== 0) return ninth;
    const tenth = compareNumbers(left.config.fftSize, right.config.fftSize);
    if (tenth !== 0) return tenth;
    return compareSampleRatePreference(left.config.sampleRateMode, right.config.sampleRateMode);
  });
}

function compareNumbers(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareSampleRatePreference(left: SampleRateMode, right: SampleRateMode): number {
  const order: Record<SampleRateMode, number> = {
    force_48000: 0,
    native: 1,
    force_44100: 2
  };
  return compareNumbers(order[left], order[right]);
}

function uniqueTraceConfigs(variants: MonoBenchmarkConfig[]): MonoBenchmarkConfig[] {
  const seen = new Map<string, MonoBenchmarkConfig>();
  for (const variant of variants) {
    const traceKey = buildTraceKey(variant);
    if (!seen.has(traceKey)) {
      seen.set(traceKey, {
        ...variant,
        pitchToleranceCents: DEFAULT_MONO_BENCHMARK_CONFIG.pitchToleranceCents,
        requiredConsecutiveFrames: DEFAULT_MONO_BENCHMARK_CONFIG.requiredConsecutiveFrames
      });
    }
  }
  return [...seen.values()];
}

function uniqueValidationConfigs(variants: MonoBenchmarkConfig[]): MonoBenchmarkConfig[] {
  const seen = new Map<string, MonoBenchmarkConfig>();
  for (const variant of variants) {
    const key = buildValidationKey(variant);
    if (!seen.has(key)) {
      seen.set(key, {
        frameSizeSamples: DEFAULT_MONO_BENCHMARK_CONFIG.frameSizeSamples,
        hopSizeSamples: DEFAULT_MONO_BENCHMARK_CONFIG.hopSizeSamples,
        pitchToleranceCents: variant.pitchToleranceCents,
        requiredConsecutiveFrames: variant.requiredConsecutiveFrames,
        fftSize: DEFAULT_MONO_BENCHMARK_CONFIG.fftSize,
        sampleRateMode: DEFAULT_MONO_BENCHMARK_CONFIG.sampleRateMode
      });
    }
  }
  return [...seen.values()];
}

function buildTraceKey(config: MonoBenchmarkConfig): string {
  return `${config.sampleRateMode}|fft${config.fftSize}`;
}

function buildValidationKey(config: MonoBenchmarkConfig): string {
  return `tol${config.pitchToleranceCents}|c${config.requiredConsecutiveFrames}`;
}

function buildFullVariantConfig(traceConfig: MonoBenchmarkConfig, validationConfig: MonoBenchmarkConfig): MonoBenchmarkConfig {
  return {
    frameSizeSamples: traceConfig.fftSize,
    hopSizeSamples: traceConfig.hopSizeSamples,
    pitchToleranceCents: validationConfig.pitchToleranceCents,
    requiredConsecutiveFrames: validationConfig.requiredConsecutiveFrames,
    fftSize: traceConfig.fftSize,
    sampleRateMode: traceConfig.sampleRateMode
  };
}

function buildLeaderboardDoc(
  android: DatasetSweepRun,
  guitarset: DatasetSweepRun,
  combinedRows: CombinedVariantRow[],
  bestCombined: CombinedVariantRow | null
): Record<string, unknown> {
  const combinedRanked = rankCombinedRows(combinedRows);
  return {
    generatedAtIso: new Date().toISOString(),
    rankingPolicy: [
      'Android TAR desc',
      'Android note-mismatch FAR asc',
      'Android strict FAR asc',
      'Android low-string FAR asc',
      'GuitarSet recall desc',
      'GuitarSet note-mismatch FAR asc',
      'GuitarSet strict FAR asc',
      'Total runtime asc',
      'Required consecutive frames asc',
      'FFT size asc',
      '48 kHz preference before 44.1 kHz'
    ],
    android: {
      bestVariant: summarizeVariant(android.bestVariant),
      leaderboard: android.variantSummaries.slice(0, 24).map(summarizeVariant)
    },
    guitarset_solo: {
      bestVariant: summarizeVariant(guitarset.bestVariant),
      leaderboard: guitarset.variantSummaries.slice(0, 24).map(summarizeVariant)
    },
    combined: {
      bestVariant: bestCombined ? {
        key: bestCombined.key,
        config: bestCombined.config,
        android: bestCombined.android,
        guitarset: bestCombined.guitarset
      } : null,
      leaderboard: combinedRanked.slice(0, 24).map((row) => ({
        key: row.key,
        config: row.config,
        android: row.android,
        guitarset: row.guitarset
      }))
    }
  };
}

function summarizeVariant(variant: VariantSummary): Record<string, unknown> {
  return {
    key: variant.key,
    config: variant.config,
    traceKey: variant.traceKey,
    traceSummary: variant.traceSummary,
    aggregate: variant.aggregate
  };
}

async function writeOutputs(input: {
  outputDir: string;
  android: DatasetSweepRun;
  guitarset: DatasetSweepRun;
  leaderboard: Record<string, unknown>;
  sweepVariants: MonoBenchmarkConfig[];
  androidWindowConfig: AndroidWindowConfig;
  guitarsetWindowConfig: GuitarSetWindowConfig;
  combinedRows: CombinedVariantRow[];
  bestCombined: CombinedVariantRow | null;
}): Promise<void> {
  const generatedAtIso = new Date().toISOString();
  const bestCombinedConfig = input.bestCombined?.config ?? null;

  const androidResultsDoc = buildDetailedDoc('android', ANDROID_DATASET_ROOT, generatedAtIso, input.android.detailed, input.android.bestVariant);
  const guitarsetResultsDoc = buildDetailedDoc('guitarset_solo', GUITARSET_DATASET_ROOT, generatedAtIso, input.guitarset.detailed, input.guitarset.bestVariant);

  await fs.writeFile(path.join(input.outputDir, 'android_results.json'), `${JSON.stringify(androidResultsDoc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'guitarset_solo_results.json'), `${JSON.stringify(guitarsetResultsDoc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'android_results.csv'), `${buildCsv(input.android.detailed.results)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'guitarset_solo_results.csv'), `${buildCsv(input.guitarset.detailed.results)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'android_diagnostics.json'), `${JSON.stringify(input.android.detailed.diagnostics, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'guitarset_solo_diagnostics.json'), `${JSON.stringify(input.guitarset.detailed.diagnostics, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'audit.md'), buildAuditMarkdown(input.android, input.guitarset, input.sweepVariants), 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'android_summary.md'), buildDatasetSummaryMarkdown('Android mono-note takes', input.android), 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'guitarset_solo_summary.md'), buildDatasetSummaryMarkdown('GuitarSet _solo', input.guitarset), 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'runtime_report.md'), buildRuntimeMarkdown(input.android, input.guitarset), 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'final_recommendation.md'), buildFinalRecommendationMarkdown(input.android, input.guitarset, bestCombinedConfig), 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'window_config.json'), `${JSON.stringify({
    androidWindowConfig: input.androidWindowConfig,
    guitarsetWindowConfig: input.guitarsetWindowConfig,
    sweepAxes: {
      pitchToleranceCents: [30, 100, 300],
      requiredConsecutiveFrames: [2, 3],
      fftSizes: [2048, 4096],
      sampleRateModes: ['force_48000', 'force_44100']
    },
    bestConfig: bestCombinedConfig
  }, null, 2)}\n`, 'utf8');

  await fs.writeFile(path.join(input.outputDir, 'sweep', 'leaderboard.json'), `${JSON.stringify(input.leaderboard, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'sweep', 'best_config.json'), `${JSON.stringify(input.bestCombined?.config ?? null, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'sweep', 'leaderboard.md'), buildLeaderboardMarkdown(input.android, input.guitarset, input.combinedRows, input.bestCombined), 'utf8');
}

function buildDetailedDoc(
  dataset: DatasetName,
  datasetRoot: string,
  generatedAtIso: string,
  detailed: DetailedDatasetRun,
  bestVariant: VariantSummary
): Record<string, unknown> {
  return {
    generatedAtIso,
    dataset,
    datasetRoot,
    bestVariant: {
      key: bestVariant.key,
      config: bestVariant.config,
      traceKey: bestVariant.traceKey,
      traceSummary: bestVariant.traceSummary,
      aggregate: bestVariant.aggregate
    },
    aggregate: detailed.aggregate,
    noteSummary: detailed.noteSummary,
    results: detailed.results.map(compactResult),
    diagnostics: detailed.diagnostics
  };
}

function buildDatasetSummaryMarkdown(title: string, run: DatasetSweepRun): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    `- Best config: ${formatBenchmarkVariantLabel(run.bestVariant.config)}`,
    `- Windows: ${run.detailed.aggregate.windows}`,
    `- Positive windows: ${run.detailed.aggregate.positiveWindows}`,
    `- Negative windows: ${run.detailed.aggregate.negativeWindows}`,
    `- Stable windows: ${run.detailed.aggregate.stableWindows}`,
    `- Transition windows: ${run.detailed.aggregate.transitionWindows}`,
    `- Guard windows: ${run.detailed.aggregate.guardWindows}`,
    `- Confirmed windows: ${run.detailed.aggregate.confirmedWindows}`,
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| TAR | ${formatPct(run.detailed.aggregate.tar)} |`,
    `| Strict FAR | ${formatPct(run.detailed.aggregate.strictFar)} |`,
    `| Note-mismatch FAR | ${formatPct(run.detailed.aggregate.noteMismatchFar)} |`,
    `| Precision | ${formatPct(run.detailed.aggregate.precision)} |`,
    `| Recall | ${formatPct(run.detailed.aggregate.recall)} |`,
    `| Confirmed window rate | ${formatPct(run.detailed.aggregate.confirmedWindowRate)} |`,
    `| Detector runtime avg (ms) | ${formatNumber(run.detailed.aggregate.detectorRuntimeAvgMs, 4)} |`,
    `| Detector runtime p95 (ms) | ${formatNumber(run.detailed.aggregate.detectorRuntimeP95Ms, 4)} |`,
    `| Validator runtime avg (ms) | ${formatNumber(run.detailed.aggregate.validatorRuntimeAvgMs, 4)} |`,
    `| Validator runtime p95 (ms) | ${formatNumber(run.detailed.aggregate.validatorRuntimeP95Ms, 4)} |`,
    `| End-to-end avg (ms) | ${formatNumber(run.detailed.aggregate.totalRuntimeAvgMs, 4)} |`,
    `| End-to-end p95 (ms) | ${formatNumber(run.detailed.aggregate.totalRuntimeP95Ms, 4)} |`,
    ''
  ];

  if (run.dataset === 'android') {
    lines.push(
      '## Low String View',
      '',
      `- Low-string TAR: ${formatNullable(run.detailed.aggregate.lowBandTar, 3)}`,
      `- Low-string FAR: ${formatNullable(run.detailed.aggregate.lowBandFar, 3)}`,
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
    `- Average support seconds: ${formatNumber(run.detailed.aggregate.averageSupportSeconds, 4)}`,
    `- Average target-hit ratio: ${formatPct(run.detailed.aggregate.averageTargetHitRatio)}`,
    `- Average wrong-note ratio: ${formatPct(run.detailed.aggregate.averageWrongNoteRatio)}`,
    `- Confirmation latency avg/p95 (ms): ${formatNullable(run.detailed.aggregate.averageConfirmationLatencyMsAvg, 3)} / ${formatNullable(run.detailed.aggregate.averageConfirmationLatencyMsP95, 3)}`,
    `- Confirmation latency from onset avg/p95 (ms): ${formatNullable(run.detailed.aggregate.averageConfirmationLatencyFromTargetOnsetMsAvg, 3)} / ${formatNullable(run.detailed.aggregate.averageConfirmationLatencyFromTargetOnsetMsP95, 3)}`,
    `- First target-hit latency avg/p95 (ms): ${formatNullable(run.detailed.aggregate.firstTargetHitLatencyMsAvg, 3)} / ${formatNullable(run.detailed.aggregate.firstTargetHitLatencyMsP95, 3)}`,
    `- First any-hit latency avg/p95 (ms): ${formatNullable(run.detailed.aggregate.firstAnyHitLatencyMsAvg, 3)} / ${formatNullable(run.detailed.aggregate.firstAnyHitLatencyMsP95, 3)}`,
    `- No-detect frame ratio: ${formatPct(run.detailed.aggregate.noDetectFrameRatio)}`,
    `- Reset count avg: ${formatNumber(run.detailed.aggregate.resetCountAvg, 4)}`,
    ''
  );

  return lines.join('\n');
}

function buildRuntimeMarkdown(android: DatasetSweepRun, guitarset: DatasetSweepRun): string {
  const lines: string[] = [
    '# Runtime Report',
    '',
    '- Detector runtime is measured per streaming frame.',
    '- Validator runtime is measured per window evaluation.',
    '- End-to-end runtime is measured per window and includes both the frame processing slice and the validator overhead.',
    '',
    '## Android',
    '',
    `- Best config: ${formatBenchmarkVariantLabel(android.bestVariant.config)}`,
    `- Detector avg/p95 (ms): ${formatNumber(android.detailed.aggregate.detectorRuntimeAvgMs, 4)} / ${formatNumber(android.detailed.aggregate.detectorRuntimeP95Ms, 4)}`,
    `- Validator avg/p95 (ms): ${formatNumber(android.detailed.aggregate.validatorRuntimeAvgMs, 4)} / ${formatNumber(android.detailed.aggregate.validatorRuntimeP95Ms, 4)}`,
    `- End-to-end avg/p95 (ms): ${formatNumber(android.detailed.aggregate.totalRuntimeAvgMs, 4)} / ${formatNumber(android.detailed.aggregate.totalRuntimeP95Ms, 4)}`,
    '',
    '## GuitarSet _solo',
    '',
    `- Best config: ${formatBenchmarkVariantLabel(guitarset.bestVariant.config)}`,
    `- Detector avg/p95 (ms): ${formatNumber(guitarset.detailed.aggregate.detectorRuntimeAvgMs, 4)} / ${formatNumber(guitarset.detailed.aggregate.detectorRuntimeP95Ms, 4)}`,
    `- Validator avg/p95 (ms): ${formatNumber(guitarset.detailed.aggregate.validatorRuntimeAvgMs, 4)} / ${formatNumber(guitarset.detailed.aggregate.validatorRuntimeP95Ms, 4)}`,
    `- End-to-end avg/p95 (ms): ${formatNumber(guitarset.detailed.aggregate.totalRuntimeAvgMs, 4)} / ${formatNumber(guitarset.detailed.aggregate.totalRuntimeP95Ms, 4)}`,
    ''
  ];
  return lines.join('\n');
}

function buildFinalRecommendationMarkdown(
  android: DatasetSweepRun,
  guitarset: DatasetSweepRun,
  bestConfig: MonoBenchmarkConfig | null
): string {
  const lines: string[] = [
    '# ac14 Gameplay Mono Fallback Recommendation',
    '',
    '## Benchmark Contract',
    '',
    `- Reference frame size: ${DEFAULT_MONO_BENCHMARK_CONFIG.frameSizeSamples} samples`,
    `- Reference hop size: ${DEFAULT_MONO_BENCHMARK_CONFIG.hopSizeSamples} samples`,
    '- Target windows are defined in seconds and evaluated with frame-midpoint inclusion.',
    '- Cents tolerance is evaluated from detected pitch frequency against the target MIDI frequency.',
    '- Confirmation requires consecutive good frames inside the active window.',
    '- Sample-rate comparison is explicit: 48 kHz and 44.1 kHz are both swept by resampling the corpus to the target rate.',
    '- FFT comparison is explicit: 2048 vs 4096 sample analysis windows.',
    '',
    '## Android Mono-Note Takes',
    '',
    `- Best config: ${formatBenchmarkVariantLabel(android.bestVariant.config)}`,
    `- TAR: ${formatPct(android.detailed.aggregate.tar)}`,
    `- Strict FAR: ${formatPct(android.detailed.aggregate.strictFar)}`,
    `- Note-mismatch FAR: ${formatPct(android.detailed.aggregate.noteMismatchFar)}`,
    `- Low-string TAR/FAR: ${formatNullable(android.detailed.aggregate.lowBandTar, 3)} / ${formatNullable(android.detailed.aggregate.lowBandFar, 3)}`,
    '',
    '## GuitarSet _solo',
    '',
    `- Best config: ${formatBenchmarkVariantLabel(guitarset.bestVariant.config)}`,
    `- Note recall: ${formatPct(guitarset.detailed.aggregate.recall)}`,
    `- Strict FAR: ${formatPct(guitarset.detailed.aggregate.strictFar)}`,
    `- Note-mismatch FAR: ${formatPct(guitarset.detailed.aggregate.noteMismatchFar)}`,
    '',
    '## Decision',
    '',
    bestConfig
      ? `- Recommended config: **${formatBenchmarkVariantLabel(bestConfig)}**.`
      : '- Recommended config: **none**.',
    bestConfig?.fftSize === 2048
      ? '- 2048 is preferable for gameplay latency because it keeps the analysis window shorter while preserving the same hop cadence.'
      : '- 4096 did not clearly lose on accuracy, but it is the higher-latency option and should only be chosen if the measured gain justifies the extra delay.',
    ' - TAR lower than FAR can still be reasonable here when the positive and negative window populations are not balanced and the benchmark is explicitly validating gameplay-style target windows rather than a symmetric classifier. The key question is whether the streaming contract matches gameplay behavior, not whether the two rates are numerically close.',
    ''
  ];

  if (android.detailed.aggregate.tar >= android.detailed.aggregate.strictFar && android.detailed.aggregate.noteMismatchFar <= 0.25) {
    lines.splice(lines.length - 2, 0, '- The Android benchmark is reasonably viable under faithful streaming semantics.');
  } else {
    lines.splice(lines.length - 2, 0, '- The Android benchmark is not yet a clean gameplay fallback under faithful streaming semantics.');
  }

  return lines.join('\n');
}

function buildLeaderboardMarkdown(
  android: DatasetSweepRun,
  guitarset: DatasetSweepRun,
  combinedRows: CombinedVariantRow[],
  bestCombined: CombinedVariantRow | null
): string {
  const lines: string[] = [
    '# ac14 Streaming Sweep Leaderboard',
    '',
    '## Ranking Policy',
    '',
    '1. Android TAR descending',
    '2. Android note-mismatch FAR ascending',
    '3. Android strict FAR ascending',
    '4. Android low-string FAR ascending',
    '5. GuitarSet recall descending',
    '6. GuitarSet note-mismatch FAR ascending',
    '7. GuitarSet strict FAR ascending',
    '8. Total runtime ascending',
    '9. Required consecutive frames ascending',
    '10. FFT size ascending',
    '11. 48 kHz preferred over 44.1 kHz',
    '',
    '## Android Leaderboard',
    '',
    '| Rank | Config | TAR | Strict FAR | Note FAR | Low FAR | Runtime avg (ms) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  rankVariantSummaries('android', android.variantSummaries).slice(0, 10).forEach((entry, index) => {
    lines.push(
      `| ${index + 1} | ${formatBenchmarkVariantLabel(entry.config)} | ${formatPct(entry.aggregate.tar)} | ${formatPct(entry.aggregate.strictFar)} | ${formatPct(entry.aggregate.noteMismatchFar)} | ${formatNullable(entry.aggregate.lowBandFar, 3)} | ${formatNumber(entry.aggregate.totalRuntimeAvgMs, 4)} |`
    );
  });

  lines.push(
    '',
    '## GuitarSet _solo Leaderboard',
    '',
    '| Rank | Config | Recall | Strict FAR | Note FAR | Runtime avg (ms) |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  );
  rankVariantSummaries('guitarset_solo', guitarset.variantSummaries).slice(0, 10).forEach((entry, index) => {
    lines.push(
      `| ${index + 1} | ${formatBenchmarkVariantLabel(entry.config)} | ${formatPct(entry.aggregate.recall)} | ${formatPct(entry.aggregate.strictFar)} | ${formatPct(entry.aggregate.noteMismatchFar)} | ${formatNumber(entry.aggregate.totalRuntimeAvgMs, 4)} |`
    );
  });

  lines.push(
    '',
    '## Combined Leaderboard',
    '',
    '| Rank | Config | Android TAR | Android strict FAR | Android note FAR | Guitar recall | Guitar strict FAR | Runtime avg (ms) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  rankCombinedRows(combinedRows).slice(0, 10).forEach((row, index) => {
    lines.push(
      `| ${index + 1} | ${formatBenchmarkVariantLabel(row.config)} | ${formatPct(row.android.tar)} | ${formatPct(row.android.strictFar)} | ${formatPct(row.android.noteMismatchFar)} | ${formatPct(row.guitarset.recall)} | ${formatPct(row.guitarset.strictFar)} | ${formatNumber(row.android.totalRuntimeAvgMs + row.guitarset.totalRuntimeAvgMs, 4)} |`
    );
  });

  lines.push(
    '',
    `## Recommended Variant`,
    '',
    bestCombined
      ? `- ${formatBenchmarkVariantLabel(bestCombined.config)}`
      : '- none',
    ''
  );
  return lines.join('\n');
}

function buildAuditMarkdown(
  android: DatasetSweepRun,
  guitarset: DatasetSweepRun,
  sweepVariants: MonoBenchmarkConfig[]
): string {
  const lines: string[] = [
    '# ac14 Streaming Benchmark Audit',
    '',
    '## Reused',
    '',
    '- Android mono-note take discovery still uses `buildDatasetRows` from `tools/benchmark_suites/shared.ts`.',
    '- GuitarSet `_solo` discovery still uses `discoverWavJamsPairs` and JAMS parsing from `tools/benchmark_suites/gameplay_validator_polyphonic.ts`.',
    '- The detector itself stays on `PitchDetectorPreset.Ac14` and is not redesigned.',
    '',
    '## Replaced',
    '',
    '- The old window-ratio benchmark is bypassed for the streaming sweep.',
    '- Acceptance now happens frame-by-frame inside second-based validation windows.',
    '- The benchmark now records cents tolerance, consecutive-frame confirmation, and confirmation latency explicitly.',
    '',
    '## Sweep Axes',
    '',
    `- Variants evaluated: ${sweepVariants.length}`,
    '- Pitch tolerance: 30c, 100c, 300c',
    '- Consecutive frames: 2, 3',
    '- FFT size: 2048, 4096',
    '- Sample rate: 48 kHz and 44.1 kHz forced-resample scenarios',
    '',
    '## Dataset Isolation',
    '',
    '- Android and GuitarSet _solo are evaluated separately and only combined at the final recommendation stage.',
    '',
    '## Current Bests',
    '',
    `- Android best: ${formatBenchmarkVariantLabel(android.bestVariant.config)}`,
    `- GuitarSet _solo best: ${formatBenchmarkVariantLabel(guitarset.bestVariant.config)}`,
    ''
  ];
  return lines.join('\n');
}

function buildCsv(results: MonoWindowResult[]): string {
  const header = [
    'dataset',
    'fileId',
    'windowId',
    'startSec',
    'endSec',
    'targetOnsetSec',
    'expectedMidi',
    'expectedAccept',
    'windowKind',
    'windowCategory',
    'isStableWindow',
    'sourceBand',
    'sampleRateMode',
    'sampleRateHz',
    'fftSize',
    'frameSizeSamples',
    'hopSizeSamples',
    'pitchToleranceCents',
    'requiredConsecutiveFrames',
    'accept',
    'falseReject',
    'falseAccept',
    'noteMismatch',
    'mismatchType',
    'decisionLatencyMs',
    'decisionLatencyFromTargetOnsetMs',
    'detectorRuntimeMs',
    'validatorRuntimeMs',
    'totalRuntimeMs'
  ];

  const lines = [header.map(csvEscape).join(',')];
  for (const result of results) {
    lines.push([
      result.dataset,
      result.fileId,
      result.windowId,
      result.startSec,
      result.endSec,
      result.targetOnsetSec,
      result.expectedMidi,
      result.expectedAccept,
      result.windowKind,
      result.windowCategory,
      result.isStableWindow,
      result.sourceBand,
      result.sampleRateMode,
      result.sampleRateHz,
      result.fftSize,
      result.frameSizeSamples,
      result.hopSizeSamples,
      result.pitchToleranceCents,
      result.requiredConsecutiveFrames,
      result.accept,
      result.falseReject,
      result.falseAccept,
      result.noteMismatch,
      result.mismatchType,
      result.decisionLatencyMs,
      result.decisionLatencyFromTargetOnsetMs,
      result.detectorRuntimeMs,
      result.validatorRuntimeMs,
      result.totalRuntimeMs
    ].map(formatCsvValue).join(','));
  }
  return lines.join('\n');
}

function compactResult(result: MonoWindowResult): Record<string, unknown> {
  return {
    fileId: result.fileId,
    relativeFilePath: result.relativeFilePath,
    windowId: result.windowId,
    startSec: roundNumber(result.startSec, 6),
    endSec: roundNumber(result.endSec, 6),
    targetOnsetSec: roundNullable(result.targetOnsetSec, 6),
    expectedMidi: result.expectedMidi,
    expectedAccept: result.expectedAccept,
    windowKind: result.windowKind,
    windowCategory: result.windowCategory,
    isStableWindow: result.isStableWindow,
    sourceBand: result.sourceBand,
    sampleRateMode: result.sampleRateMode,
    sampleRateHz: result.sampleRateHz,
    fftSize: result.fftSize,
    frameSizeSamples: result.frameSizeSamples,
    hopSizeSamples: result.hopSizeSamples,
    pitchToleranceCents: result.pitchToleranceCents,
    requiredConsecutiveFrames: result.requiredConsecutiveFrames,
    accept: result.accept,
    falseReject: result.falseReject,
    falseAccept: result.falseAccept,
    noteMismatch: result.noteMismatch,
    mismatchType: result.mismatchType,
    decisionLatencyMs: roundNullable(result.decisionLatencyMs, 3),
    decisionLatencyFromTargetOnsetMs: roundNullable(result.decisionLatencyFromTargetOnsetMs, 3),
    targetHitRatio: roundNumber(result.evidence.targetHitRatio, 6),
    wrongNoteRatio: roundNumber(result.evidence.wrongNoteRatio, 6),
    supportSeconds: roundNumber(result.evidence.supportSeconds, 6),
    confirmationLatencyMs: roundNullable(result.evidence.confirmationLatencyMs, 3),
    confirmationLatencyFromTargetOnsetMs: roundNullable(result.evidence.confirmationLatencyFromTargetOnsetMs, 3),
    firstTargetHitLatencyMs: roundNullable(result.evidence.firstTargetHitLatencyMs, 3),
    firstAnyHitLatencyMs: roundNullable(result.evidence.firstAnyHitLatencyMs, 3),
    noDetectFrameRatio: roundNumber(result.evidence.noDetectFrameRatio, 6),
    resetCount: result.evidence.resetCount,
    detectorRuntimeMs: roundNumber(result.detectorRuntimeMs, 6),
    validatorRuntimeMs: roundNumber(result.validatorRuntimeMs, 6),
    totalRuntimeMs: roundNumber(result.totalRuntimeMs, 6)
  };
}

function buildDetailedResultsMarkdown(title: string, run: DetailedDatasetRun): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    `- Windows: ${run.aggregate.windows}`,
    `- Positive windows: ${run.aggregate.positiveWindows}`,
    `- Negative windows: ${run.aggregate.negativeWindows}`,
    `- Confirmed windows: ${run.aggregate.confirmedWindows}`,
    `- TAR: ${formatPct(run.aggregate.tar)}`,
    `- Strict FAR: ${formatPct(run.aggregate.strictFar)}`,
    `- Note-mismatch FAR: ${formatPct(run.aggregate.noteMismatchFar)}`,
    `- Best sample-rate mode: ${run.results[0]?.sampleRateMode ?? 'n/a'}`,
    ''
  ];
  return lines.join('\n');
}

function buildTraceSummaryMap(summaries: VariantSummary[]): Map<string, TraceSummary> {
  return new Map(summaries.map((summary) => [summary.traceKey, summary.traceSummary ?? {
    sampleRateMode: summary.config.sampleRateMode,
    fftSize: summary.config.fftSize,
    detectorRuntimeAvgMs: 0,
    detectorRuntimeP95Ms: 0
  }]));
}

function formatNumber(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function compareVariantSummariesForDataset(dataset: DatasetName, left: VariantSummary, right: VariantSummary): number {
  return compareVariantSummaries(dataset, left, right);
}

function buildPairwiseSampleRateWarning(bestCombined: CombinedVariantRow | null): string {
  if (!bestCombined) return 'none';
  return bestCombined.config.sampleRateMode === 'force_48000'
    ? '48 kHz was the preferred winning sample-rate scenario.'
    : '44.1 kHz was the preferred winning sample-rate scenario.';
}

function buildSweepResultsDoc(android: DatasetSweepRun, guitarset: DatasetSweepRun, combinedRows: CombinedVariantRow[]): Record<string, unknown> {
  return {
    generatedAtIso: new Date().toISOString(),
    android: android.variantSummaries.map(summarizeVariant),
    guitarset_solo: guitarset.variantSummaries.map(summarizeVariant),
    combined: rankCombinedRows(combinedRows).map((row) => ({
      key: row.key,
      config: row.config,
      android: row.android,
      guitarset: row.guitarset
    }))
  };
}

function finalizeTraceSummaryMap(accumulators: Map<string, TraceAccumulator>): Map<string, TraceSummary> {
  const summaries = new Map<string, TraceSummary>();
  for (const [key, accumulator] of accumulators.entries()) {
    const [sampleRateMode, fftLabel] = key.split('|');
    summaries.set(key, {
      sampleRateMode: sampleRateMode as SampleRateMode,
      fftSize: Number(fftLabel.replace(/^fft/, '')) as 2048 | 4096,
      detectorRuntimeAvgMs: average(accumulator.runtimeSamples),
      detectorRuntimeP95Ms: percentile(accumulator.runtimeSamples, 0.95)
    });
  }
  return summaries;
}

function finalizeVariantSummaries(
  variantAccumulators: Map<string, VariantAccumulator>,
  traceAccumulators: Map<string, TraceAccumulator>
): VariantSummary[] {
  const traceSummaries = finalizeTraceSummaryMap(traceAccumulators);
  return [...variantAccumulators.values()].map((accumulator) => ({
    config: accumulator.config,
    key: accumulator.key,
    traceKey: accumulator.traceKey,
    traceSummary: traceSummaries.get(accumulator.traceKey) ?? null,
    aggregate: finalizeVariantAggregate({
      ...accumulator,
      traceSummary: traceSummaries.get(accumulator.traceKey) ?? null
    } as VariantAccumulator & { traceSummary: TraceSummary | null })
  }));
}

function finalizeVariantAggregate(accumulator: VariantAccumulator & { traceSummary: TraceSummary | null }): MonoAggregateMetrics {
  const traceSummary = accumulator.traceSummary ?? {
    sampleRateMode: accumulator.config.sampleRateMode,
    fftSize: accumulator.config.fftSize,
    detectorRuntimeAvgMs: 0,
    detectorRuntimeP95Ms: 0
  };
  const precision = accumulator.confirmedWindows > 0
    ? accumulator.positiveConfirmedWindows / accumulator.confirmedWindows
    : 0;
  const recall = accumulator.positiveWindows > 0
    ? accumulator.positiveConfirmedWindows / accumulator.positiveWindows
    : 0;
  return {
    dataset: 'android',
    windows: accumulator.windows,
    positiveWindows: accumulator.positiveWindows,
    negativeWindows: accumulator.negativeWindows,
    stableWindows: accumulator.stableWindows,
    transitionWindows: accumulator.transitionWindows,
    guardWindows: accumulator.guardWindows,
    confirmedWindows: accumulator.confirmedWindows,
    confirmedWindowRate: accumulator.windows > 0 ? accumulator.confirmedWindows / accumulator.windows : 0,
    tar: recall,
    strictFar: accumulator.negativeWindows > 0 ? accumulator.negativeConfirmedWindows / accumulator.negativeWindows : 0,
    noteMismatchFar: accumulator.positiveWindows > 0 ? accumulator.noteMismatchConfirmedWindows / accumulator.positiveWindows : 0,
    precision,
    recall,
    lowBandTar: accumulator.lowBandPositiveWindows > 0 ? accumulator.lowBandConfirmedWindows / accumulator.lowBandPositiveWindows : null,
    lowBandFar: accumulator.lowBandNegativeWindows > 0 ? accumulator.lowBandConfirmedWindows / accumulator.lowBandNegativeWindows : null,
    stableWindowAcceptRate: accumulator.stableWindows > 0 ? accumulator.stableAccepted / accumulator.stableWindows : null,
    transitionWindowAcceptRate: accumulator.transitionWindows > 0 ? accumulator.transitionAccepted / accumulator.transitionWindows : null,
    guardWindowFalseAcceptRate: accumulator.guardWindows > 0 ? accumulator.guardAccepted / accumulator.guardWindows : null,
    averageSupportSeconds: accumulator.windows > 0 ? accumulator.supportSecondsSum / accumulator.windows : 0,
    averageTargetHitRatio: accumulator.windows > 0 ? accumulator.targetHitRatioSum / accumulator.windows : 0,
    averageWrongNoteRatio: accumulator.windows > 0 ? accumulator.wrongNoteRatioSum / accumulator.windows : 0,
    averageConfirmationLatencyMsAvg: accumulator.confirmationLatencies.length > 0 ? average(accumulator.confirmationLatencies) : null,
    averageConfirmationLatencyMsP95: accumulator.confirmationLatencies.length > 0 ? percentile(accumulator.confirmationLatencies, 0.95) : null,
    averageConfirmationLatencyFromTargetOnsetMsAvg: accumulator.confirmationLatenciesFromOnset.length > 0 ? average(accumulator.confirmationLatenciesFromOnset) : null,
    averageConfirmationLatencyFromTargetOnsetMsP95: accumulator.confirmationLatenciesFromOnset.length > 0 ? percentile(accumulator.confirmationLatenciesFromOnset, 0.95) : null,
    firstTargetHitLatencyMsAvg: accumulator.firstTargetHitLatencies.length > 0 ? average(accumulator.firstTargetHitLatencies) : null,
    firstTargetHitLatencyMsP95: accumulator.firstTargetHitLatencies.length > 0 ? percentile(accumulator.firstTargetHitLatencies, 0.95) : null,
    firstAnyHitLatencyMsAvg: accumulator.firstAnyHitLatencies.length > 0 ? average(accumulator.firstAnyHitLatencies) : null,
    firstAnyHitLatencyMsP95: accumulator.firstAnyHitLatencies.length > 0 ? percentile(accumulator.firstAnyHitLatencies, 0.95) : null,
    noDetectFrameRatio: accumulator.totalSelectedFrameCount > 0 ? accumulator.totalNoDetectCount / accumulator.totalSelectedFrameCount : 0,
    resetCountAvg: accumulator.windows > 0 ? accumulator.resetCountSum / accumulator.windows : 0,
    detectorRuntimeAvgMs: traceSummary.detectorRuntimeAvgMs,
    detectorRuntimeP95Ms: traceSummary.detectorRuntimeP95Ms,
    validatorRuntimeAvgMs: average(accumulator.validatorRuntimeSamples),
    validatorRuntimeP95Ms: percentile(accumulator.validatorRuntimeSamples, 0.95),
    totalRuntimeAvgMs: average(accumulator.totalRuntimeSamples),
    totalRuntimeP95Ms: percentile(accumulator.totalRuntimeSamples, 0.95)
  };
}

main().catch((error) => {
  console.error('[ac14-streaming] fatal error:', error);
  process.exitCode = 1;
});

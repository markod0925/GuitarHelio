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
  DEFAULT_ANDROID_WINDOW_CONFIG,
  DEFAULT_GUITARSET_WINDOW_CONFIG,
  DEFAULT_MONO_BENCHMARK_CONFIG,
  evaluateMonoWindow,
  formatBenchmarkVariantLabel,
  noteLevelSummary,
  prepareMonoAudioForBenchmark,
  runStreamingTrace,
  type AndroidWindowConfig,
  type GuitarSetWindowConfig,
  type MonoAggregateMetrics,
  type MonoBenchmarkConfig,
  type MonoWindowResult,
  type MonoWindowSpec,
  type SampleRateMode,
  type StreamingTrace
} from './ac14_mono_streaming';
import {
  discoverWavJamsPairs,
  parseJamsNoteEventsFromFile,
  type JamsNoteEvent
} from './gameplay_validator_polyphonic';
import { DspCoreDetector } from './shared';

const OUTPUT_ROOT = 'analysis/gameplay_validator_ac14_mono';
const ANDROID_DATASET_ROOT = 'assets/session_20260403_174852';
const GUITARSET_DATASET_ROOT = 'tools/pitch-offline-bench/input/wav';

type DatasetName = 'android' | 'guitarset_solo';

type AndroidSeed = Awaited<ReturnType<typeof loadAndroidSeeds>>[number];
type GuitarSetSeed = Awaited<ReturnType<typeof loadGuitarSetSeeds>>[number];
type DatasetSeed = AndroidSeed | GuitarSetSeed;

type FileEntry = {
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
  key: string;
  config: MonoBenchmarkConfig;
  traceKey: string;
  traceSummary: TraceSummary;
  aggregate: MonoAggregateMetrics;
};

type DatasetRun = {
  dataset: DatasetName;
  windowConfig: AndroidWindowConfig | GuitarSetWindowConfig;
  variantSummaries: VariantSummary[];
  bestVariant: VariantSummary;
  detailed: {
    aggregate: MonoAggregateMetrics;
    noteSummary: ReturnType<typeof noteLevelSummary>;
    results: MonoWindowResult[];
    diagnostics: Array<Record<string, unknown>>;
  };
};

type VariantAccumulator = {
  dataset: DatasetName;
  key: string;
  config: MonoBenchmarkConfig;
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
};

type TraceAccumulator = {
  runtimeSamples: number[];
};

type CombinedRow = {
  key: string;
  config: MonoBenchmarkConfig;
  android: MonoAggregateMetrics;
  guitarset: MonoAggregateMetrics;
};

const RESUME_VERSION = 'ac14_streaming_resume_v1';

type FileSweepProgressDoc = {
  resumeVersion: string;
  dataset: DatasetName;
  fileKey: string;
  fileId: string;
  relativeFilePath: string;
  variantAccumulators: VariantAccumulator[];
  traceAccumulators: Array<[string, TraceAccumulator]>;
};

type FileDetailedProgressDoc = {
  resumeVersion: string;
  dataset: DatasetName;
  fileKey: string;
  fileId: string;
  relativeFilePath: string;
  configKey: string;
  results: MonoWindowResult[];
  diagnostics: Array<Record<string, unknown>>;
};

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const outputDir = path.join(repoRoot, OUTPUT_ROOT);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(path.join(outputDir, 'sweep'), { recursive: true });
  await fs.mkdir(path.join(outputDir, 'progress', RESUME_VERSION), { recursive: true });

  const detector = new DspCoreDetector('ac14', PitchDetectorPreset.Ac14, null);
  await detector.init();

  try {
    const sweepVariants = buildStreamingBenchmarkSweepVariants();
    const androidSeeds = await loadAndroidSeeds(repoRoot);
    const guitarsetSeeds = await loadGuitarSetSeeds(repoRoot);

    const android = await runDatasetSweep({
      dataset: 'android',
      seeds: androidSeeds,
      detector,
      windowConfig: DEFAULT_ANDROID_WINDOW_CONFIG,
      sweepVariants,
      progressRoot: path.join(outputDir, 'progress', RESUME_VERSION)
    });
    const guitarset = await runDatasetSweep({
      dataset: 'guitarset_solo',
      seeds: guitarsetSeeds,
      detector,
      windowConfig: DEFAULT_GUITARSET_WINDOW_CONFIG,
      sweepVariants,
      progressRoot: path.join(outputDir, 'progress', RESUME_VERSION)
    });

    const combinedRows = combineVariantRows(android.variantSummaries, guitarset.variantSummaries);
    const bestCombined = rankCombinedRows(combinedRows)[0] ?? null;

    const leaderboard = buildLeaderboardDoc(android, guitarset, combinedRows, bestCombined);
    await writeOutputs({
      outputDir,
      sweepVariants,
      android,
      guitarset,
      combinedRows,
      bestCombined,
      leaderboard
    });

    console.log(`[ac14-streaming] outputs: ${OUTPUT_ROOT}`);
  } finally {
    detector.dispose?.();
  }
}

async function loadAndroidSeeds(repoRoot: string): Promise<Array<{ row: Awaited<ReturnType<typeof buildDatasetRows>>[number]; midi: number }>> {
  const rows = await buildDatasetRows(path.join(repoRoot, ANDROID_DATASET_ROOT));
  if (rows.length === 0) {
    throw new Error(`No WAV files found under ${ANDROID_DATASET_ROOT}`);
  }
  return rows.map((row) => ({
    row,
    midi: midiForStringFret(row.stringId, row.fret)
  }));
}

async function loadGuitarSetSeeds(repoRoot: string): Promise<Array<{ fileId: string; wavPath: string; wavRelativePath: string; events: JamsNoteEvent[] }>> {
  const pairs = await discoverWavJamsPairs(path.join(repoRoot, GUITARSET_DATASET_ROOT));
  const soloPairs = pairs.filter((pair) => pair.subset === 'solo');
  if (soloPairs.length === 0) {
    throw new Error(`No _solo WAV/JAMS pairs found under ${GUITARSET_DATASET_ROOT}`);
  }

  const out = [];
  for (const pair of soloPairs) {
    const parsed = await parseJamsNoteEventsFromFile(pair.jamsPath);
    out.push({
      fileId: pair.fileId,
      wavPath: pair.wavPath,
      wavRelativePath: pair.wavRelativePath,
      events: parsed.events
    });
  }
  return out;
}

function describeDatasetSeed(
  dataset: DatasetName,
  seed: DatasetSeed
): { fileKey: string; fileId: string; relativeFilePath: string } {
  if (dataset === 'android') {
    const androidSeed = seed as Awaited<ReturnType<typeof loadAndroidSeeds>>[number];
    return {
      fileKey: buildProgressKey(androidSeed.row.fileId, androidSeed.row.relativeFilePath),
      fileId: androidSeed.row.fileId,
      relativeFilePath: androidSeed.row.relativeFilePath
    };
  }

  const guitarSeed = seed as Awaited<ReturnType<typeof loadGuitarSetSeeds>>[number];
  return {
    fileKey: buildProgressKey(guitarSeed.fileId, guitarSeed.wavRelativePath),
    fileId: guitarSeed.fileId,
    relativeFilePath: guitarSeed.wavRelativePath
  };
}

function buildProgressKey(fileId: string, relativeFilePath: string): string {
  return encodeURIComponent(`${fileId}::${relativeFilePath}`);
}

async function loadSweepProgressDocs(dir: string): Promise<Map<string, FileSweepProgressDoc>> {
  const docs = new Map<string, FileSweepProgressDoc>();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(dir, entry.name), 'utf8');
    const parsed = JSON.parse(raw) as FileSweepProgressDoc;
    if (parsed.resumeVersion !== RESUME_VERSION) continue;
    docs.set(parsed.fileKey, parsed);
  }
  return docs;
}

async function loadDetailedProgressDocs(dir: string): Promise<Map<string, FileDetailedProgressDoc>> {
  const docs = new Map<string, FileDetailedProgressDoc>();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(dir, entry.name), 'utf8');
    const parsed = JSON.parse(raw) as FileDetailedProgressDoc;
    if (parsed.resumeVersion !== RESUME_VERSION) continue;
    docs.set(parsed.fileKey, parsed);
  }
  return docs;
}

function applySweepProgressDoc(
  accumulators: {
    variantAccumulators: Map<string, VariantAccumulator>;
    traceAccumulators: Map<string, TraceAccumulator>;
  },
  doc: FileSweepProgressDoc
): void {
  for (const traceEntry of doc.traceAccumulators) {
    const [key, traceAccumulator] = traceEntry;
    const accumulator = accumulators.traceAccumulators.get(key) ?? { runtimeSamples: [] };
    mergeTraceAccumulator(accumulator, traceAccumulator);
    accumulators.traceAccumulators.set(key, accumulator);
  }

  for (const variantAccumulator of doc.variantAccumulators) {
    const accumulator = accumulators.variantAccumulators.get(variantAccumulator.key) ?? {
      ...variantAccumulator,
      confirmationLatencies: [],
      confirmationLatenciesFromOnset: [],
      firstTargetHitLatencies: [],
      firstAnyHitLatencies: [],
      validatorRuntimeSamples: [],
      totalRuntimeSamples: []
    };
    mergeVariantAccumulator(accumulator, variantAccumulator);
    accumulators.variantAccumulators.set(accumulator.key, accumulator);
  }
}

function mergeTraceAccumulator(target: TraceAccumulator, source: TraceAccumulator): void {
  target.runtimeSamples.push(...source.runtimeSamples);
}

function mergeVariantAccumulator(target: VariantAccumulator, source: VariantAccumulator): void {
  target.windows += source.windows;
  target.positiveWindows += source.positiveWindows;
  target.negativeWindows += source.negativeWindows;
  target.stableWindows += source.stableWindows;
  target.transitionWindows += source.transitionWindows;
  target.guardWindows += source.guardWindows;
  target.confirmedWindows += source.confirmedWindows;
  target.positiveConfirmedWindows += source.positiveConfirmedWindows;
  target.negativeConfirmedWindows += source.negativeConfirmedWindows;
  target.noteMismatchConfirmedWindows += source.noteMismatchConfirmedWindows;
  target.lowBandPositiveWindows += source.lowBandPositiveWindows;
  target.lowBandNegativeWindows += source.lowBandNegativeWindows;
  target.lowBandConfirmedWindows += source.lowBandConfirmedWindows;
  target.stableAccepted += source.stableAccepted;
  target.transitionAccepted += source.transitionAccepted;
  target.guardAccepted += source.guardAccepted;
  target.totalSelectedFrameCount += source.totalSelectedFrameCount;
  target.totalTargetHitCount += source.totalTargetHitCount;
  target.totalWrongNoteCount += source.totalWrongNoteCount;
  target.totalNoDetectCount += source.totalNoDetectCount;
  target.supportSecondsSum += source.supportSecondsSum;
  target.targetHitRatioSum += source.targetHitRatioSum;
  target.wrongNoteRatioSum += source.wrongNoteRatioSum;
  target.noDetectFrameRatioSum += source.noDetectFrameRatioSum;
  target.resetCountSum += source.resetCountSum;
  target.confirmationLatencies.push(...source.confirmationLatencies);
  target.confirmationLatenciesFromOnset.push(...source.confirmationLatenciesFromOnset);
  target.firstTargetHitLatencies.push(...source.firstTargetHitLatencies);
  target.firstAnyHitLatencies.push(...source.firstAnyHitLatencies);
  target.validatorRuntimeSamples.push(...source.validatorRuntimeSamples);
  target.totalRuntimeSamples.push(...source.totalRuntimeSamples);
}

async function writeSweepProgressDoc(dir: string, doc: FileSweepProgressDoc): Promise<void> {
  await writeJsonAtomic(path.join(dir, `${doc.fileKey}.json`), doc);
}

async function writeDetailedProgressDoc(dir: string, doc: FileDetailedProgressDoc): Promise<void> {
  await writeJsonAtomic(path.join(dir, `${doc.fileKey}.json`), doc);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

async function runDatasetSweep(input: {
  dataset: DatasetName;
  seeds: DatasetSeed[];
  detector: DspCoreDetector;
  windowConfig: AndroidWindowConfig | GuitarSetWindowConfig;
  sweepVariants: MonoBenchmarkConfig[];
  progressRoot: string;
}): Promise<DatasetRun> {
  const progressEvery = input.dataset === 'guitarset_solo' ? 1 : 8;
  const datasetProgressDir = path.join(input.progressRoot, input.dataset, 'sweep');
  await fs.mkdir(datasetProgressDir, { recursive: true });
  const traceConfigs = uniqueTraceConfigs(input.sweepVariants);
  const validationConfigs = uniqueValidationConfigs(input.sweepVariants);
  const variantAccumulators = new Map<string, VariantAccumulator>();
  const traceAccumulators = new Map<string, TraceAccumulator>();
  const existingDocs = await loadSweepProgressDocs(datasetProgressDir);

  for (const doc of existingDocs.values()) {
    applySweepProgressDoc({ variantAccumulators, traceAccumulators }, doc);
  }

  for (let index = 0; index < input.seeds.length; index += 1) {
    const seed = input.seeds[index];
    const identity = describeDatasetSeed(input.dataset, seed);
    const existingDoc = existingDocs.get(identity.fileKey);
    if (existingDoc) {
      if (index % progressEvery === 0 || index + 1 === input.seeds.length) {
        console.log(`[ac14-streaming] ${input.dataset} ${index + 1}/${input.seeds.length} skip ${existingDoc.relativeFilePath}`);
      }
      continue;
    }

    const entry = await buildFileEntry(input.dataset, seed, input.windowConfig);
    const decoded = await decodeMonoAudio(entry.filePath);
    const fileTraceAccumulators = new Map<string, TraceAccumulator>();
    const fileVariantAccumulators = new Map<string, VariantAccumulator>();

    for (const traceConfig of traceConfigs) {
      const trace = runTraceForConfig(input.detector, decoded.samples, decoded.sampleRate, traceConfig);
      updateTraceAccumulator(traceAccumulators, traceConfig, trace);
      updateTraceAccumulator(fileTraceAccumulators, traceConfig, trace);

      for (const validationConfig of validationConfigs) {
        const config = buildFullVariantConfig(traceConfig, validationConfig);
        const key = buildBenchmarkVariantKey(config);
        const traceKey = buildTraceKey(traceConfig);
        const accumulator = getOrCreateVariantAccumulator(variantAccumulators, input.dataset, config, key, traceKey);
        const fileAccumulator = getOrCreateVariantAccumulator(fileVariantAccumulators, input.dataset, config, key, traceKey);
        for (const spec of entry.windows) {
          const result = evaluateMonoWindow({ spec, observations: trace.observations, config });
          updateVariantAccumulator(accumulator, result);
          updateVariantAccumulator(fileAccumulator, result);
        }
      }
    }

    await writeSweepProgressDoc(datasetProgressDir, {
      resumeVersion: RESUME_VERSION,
      dataset: input.dataset,
      fileKey: identity.fileKey,
      fileId: entry.fileId,
      relativeFilePath: entry.relativeFilePath,
      variantAccumulators: [...fileVariantAccumulators.values()],
      traceAccumulators: [...fileTraceAccumulators.entries()]
    });

    if (index % progressEvery === 0 || index + 1 === input.seeds.length) {
      console.log(`[ac14-streaming] ${input.dataset} ${index + 1}/${input.seeds.length} ${entry.relativeFilePath}`);
    }
  }

  const traceSummaries = finalizeTraceSummaries(traceAccumulators);
  const variantSummaries = finalizeVariantSummaries(variantAccumulators, traceSummaries);
  const bestVariant = rankVariantSummaries(variantSummaries)[0];
  if (!bestVariant) {
    throw new Error(`No benchmark variants produced for ${input.dataset}`);
  }

  const detailed = await runDetailedVariant({
    dataset: input.dataset,
    seeds: input.seeds,
    detector: input.detector,
    windowConfig: input.windowConfig,
    config: bestVariant.config,
    progressRoot: input.progressRoot
  });

  return {
    dataset: input.dataset,
    windowConfig: input.windowConfig,
    variantSummaries,
    bestVariant,
    detailed
  };
}

async function buildFileEntry(
  dataset: DatasetName,
  seed: DatasetSeed,
  windowConfig: AndroidWindowConfig | GuitarSetWindowConfig
): Promise<FileEntry> {
  if (dataset === 'android') {
    const androidSeed = seed as Awaited<ReturnType<typeof loadAndroidSeeds>>[number];
    const decoded = await decodeMonoAudio(androidSeed.row.filePath);
    const durationSec = androidSeed.row.durationSec ?? decoded.samples.length / decoded.sampleRate;
    return {
      fileId: androidSeed.row.fileId,
      filePath: androidSeed.row.filePath,
      relativeFilePath: androidSeed.row.relativeFilePath,
      durationSec,
      windows: buildAndroidMonoWindows({
        datasetRow: androidSeed.row,
        midi: androidSeed.midi,
        durationSec,
        config: windowConfig as AndroidWindowConfig
      })
    };
  }

  const guitarSeed = seed as Awaited<ReturnType<typeof loadGuitarSetSeeds>>[number];
  const decoded = await decodeMonoAudio(guitarSeed.wavPath);
  const durationSec = decoded.samples.length / decoded.sampleRate;
  return {
    fileId: guitarSeed.fileId,
    filePath: guitarSeed.wavPath,
    relativeFilePath: guitarSeed.wavRelativePath,
    durationSec,
    windows: buildGuitarSetSoloWindows({
      fileId: guitarSeed.fileId,
      relativeFilePath: guitarSeed.wavRelativePath,
      durationSec,
      events: guitarSeed.events,
      config: windowConfig as GuitarSetWindowConfig
    })
  };
}

function runTraceForConfig(
  detector: DspCoreDetector,
  samples: Float32Array,
  sampleRate: number,
  config: MonoBenchmarkConfig
): StreamingTrace {
  const prepared = prepareMonoAudioForBenchmark({
    samples,
    sampleRate,
    sampleRateMode: config.sampleRateMode
  });
  return runStreamingTrace({
    detector,
    samples: prepared.samples,
    sampleRate: prepared.sampleRate,
    config: {
      ...config,
      frameSizeSamples: config.fftSize
    }
  });
}

async function runDetailedVariant(input: {
  dataset: DatasetName;
  seeds: DatasetSeed[];
  detector: DspCoreDetector;
  windowConfig: AndroidWindowConfig | GuitarSetWindowConfig;
  config: MonoBenchmarkConfig;
  progressRoot: string;
}): Promise<DatasetRun['detailed']> {
  const results: MonoWindowResult[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const progressEvery = input.dataset === 'guitarset_solo' ? 1 : 8;
  const configKey = buildBenchmarkVariantKey(input.config);
  const datasetProgressDir = path.join(input.progressRoot, input.dataset, 'detailed', configKey);
  await fs.mkdir(datasetProgressDir, { recursive: true });
  const existingDocs = await loadDetailedProgressDocs(datasetProgressDir);

  for (let index = 0; index < input.seeds.length; index += 1) {
    const seed = input.seeds[index];
    const identity = describeDatasetSeed(input.dataset, seed);
    const existingDoc = existingDocs.get(identity.fileKey);
    if (existingDoc) {
      results.push(...existingDoc.results);
      diagnostics.push(...existingDoc.diagnostics);
      if (index % progressEvery === 0 || index + 1 === input.seeds.length) {
        console.log(`[ac14-streaming] ${input.dataset} detailed ${index + 1}/${input.seeds.length} skip ${existingDoc.relativeFilePath}`);
      }
      continue;
    }

    const entry = await buildFileEntry(input.dataset, seed, input.windowConfig);
    const decoded = await decodeMonoAudio(entry.filePath);
    const trace = runTraceForConfig(input.detector, decoded.samples, decoded.sampleRate, input.config);
    const fileResults: MonoWindowResult[] = [];
    const fileDiagnostics: Array<Record<string, unknown>> = [];

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
      const compacted = compactResult(result);
      diagnostics.push(compacted);
      fileResults.push(result);
      fileDiagnostics.push(compacted);
    }

    await writeDetailedProgressDoc(datasetProgressDir, {
      resumeVersion: RESUME_VERSION,
      dataset: input.dataset,
      fileKey: identity.fileKey,
      fileId: entry.fileId,
      relativeFilePath: entry.relativeFilePath,
      configKey,
      results: fileResults,
      diagnostics: fileDiagnostics
    });

    if (index % progressEvery === 0 || index + 1 === input.seeds.length) {
      console.log(`[ac14-streaming] ${input.dataset} detailed ${index + 1}/${input.seeds.length} ${entry.relativeFilePath}`);
    }
  }

  return {
    aggregate: aggregateMonoResults(results),
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
  accumulator.runtimeSamples.push(...trace.observations.map((observation) => observation.runtimeMs));
  accumulators.set(key, accumulator);
}

function getOrCreateVariantAccumulator(
  accumulators: Map<string, VariantAccumulator>,
  dataset: DatasetName,
  config: MonoBenchmarkConfig,
  key: string,
  traceKey: string
): VariantAccumulator {
  const existing = accumulators.get(key);
  if (existing) return existing;
  const created: VariantAccumulator = {
    dataset,
    key,
    config,
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
    totalRuntimeSamples: []
  };
  accumulators.set(key, created);
  return created;
}

function updateVariantAccumulator(accumulator: VariantAccumulator, result: MonoWindowResult): void {
  accumulator.windows += 1;
  if (result.expectedAccept) accumulator.positiveWindows += 1;
  else accumulator.negativeWindows += 1;
  if (result.windowKind === 'stable') accumulator.stableWindows += 1;
  if (result.windowKind === 'transition') accumulator.transitionWindows += 1;
  if (result.windowKind === 'guard') accumulator.guardWindows += 1;
  if (result.accept) {
    accumulator.confirmedWindows += 1;
    if (result.expectedAccept) accumulator.positiveConfirmedWindows += 1;
    else accumulator.negativeConfirmedWindows += 1;
  }
  if (result.noteMismatch && result.accept && result.expectedAccept) {
    accumulator.noteMismatchConfirmedWindows += 1;
  }
  if (result.sourceBand === 'low') {
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
  if (result.evidence.confirmationLatencyMs !== null) accumulator.confirmationLatencies.push(result.evidence.confirmationLatencyMs);
  if (result.evidence.confirmationLatencyFromTargetOnsetMs !== null) accumulator.confirmationLatenciesFromOnset.push(result.evidence.confirmationLatencyFromTargetOnsetMs);
  if (result.evidence.firstTargetHitLatencyMs !== null) accumulator.firstTargetHitLatencies.push(result.evidence.firstTargetHitLatencyMs);
  if (result.evidence.firstAnyHitLatencyMs !== null) accumulator.firstAnyHitLatencies.push(result.evidence.firstAnyHitLatencyMs);
  accumulator.validatorRuntimeSamples.push(result.validatorRuntimeMs);
  accumulator.totalRuntimeSamples.push(result.totalRuntimeMs);
}

function finalizeTraceSummaries(accumulators: Map<string, TraceAccumulator>): Map<string, TraceSummary> {
  const out = new Map<string, TraceSummary>();
  for (const [key, accumulator] of accumulators.entries()) {
    const [sampleRateMode, fftLabel] = key.split('|');
    out.set(key, {
      sampleRateMode: sampleRateMode as SampleRateMode,
      fftSize: Number(fftLabel.replace(/^fft/, '')) as 2048 | 4096,
      detectorRuntimeAvgMs: average(accumulator.runtimeSamples),
      detectorRuntimeP95Ms: percentile(accumulator.runtimeSamples, 0.95)
    });
  }
  return out;
}

function finalizeVariantSummaries(
  accumulators: Map<string, VariantAccumulator>,
  traceSummaries: Map<string, TraceSummary>
): VariantSummary[] {
  return [...accumulators.values()].map((accumulator) => {
    const traceSummary = traceSummaries.get(accumulator.traceKey);
    if (!traceSummary) {
      throw new Error(`Missing trace summary for ${accumulator.traceKey}`);
    }
    return {
      key: accumulator.key,
      config: accumulator.config,
      traceKey: accumulator.traceKey,
      traceSummary,
      aggregate: finalizeVariantAggregate(accumulator, traceSummary)
    };
  });
}

function finalizeVariantAggregate(accumulator: VariantAccumulator, traceSummary: TraceSummary): MonoAggregateMetrics {
  return {
    dataset: accumulator.dataset,
    windows: accumulator.windows,
    positiveWindows: accumulator.positiveWindows,
    negativeWindows: accumulator.negativeWindows,
    stableWindows: accumulator.stableWindows,
    transitionWindows: accumulator.transitionWindows,
    guardWindows: accumulator.guardWindows,
    confirmedWindows: accumulator.confirmedWindows,
    confirmedWindowRate: accumulator.windows > 0 ? accumulator.confirmedWindows / accumulator.windows : 0,
    tar: accumulator.positiveWindows > 0 ? accumulator.positiveConfirmedWindows / accumulator.positiveWindows : 0,
    strictFar: accumulator.negativeWindows > 0 ? accumulator.negativeConfirmedWindows / accumulator.negativeWindows : 0,
    noteMismatchFar: accumulator.positiveWindows > 0 ? accumulator.noteMismatchConfirmedWindows / accumulator.positiveWindows : 0,
    precision: accumulator.confirmedWindows > 0 ? accumulator.positiveConfirmedWindows / accumulator.confirmedWindows : 0,
    recall: accumulator.positiveWindows > 0 ? accumulator.positiveConfirmedWindows / accumulator.positiveWindows : 0,
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

function combineVariantRows(android: VariantSummary[], guitarset: VariantSummary[]): CombinedRow[] {
  const guitarByKey = new Map(guitarset.map((row) => [row.key, row]));
  const rows: CombinedRow[] = [];
  for (const row of android) {
    const guitar = guitarByKey.get(row.key);
    if (!guitar) continue;
    rows.push({
      key: row.key,
      config: row.config,
      android: row.aggregate,
      guitarset: guitar.aggregate
    });
  }
  return rows;
}

function rankVariantSummaries(summaries: VariantSummary[]): VariantSummary[] {
  return [...summaries].sort((left, right) => {
    const a = left.aggregate;
    const b = right.aggregate;
    const first = compareNumbers(b.tar, a.tar);
    if (first !== 0) return first;
    const second = compareNumbers(a.noteMismatchFar, b.noteMismatchFar);
    if (second !== 0) return second;
    const third = compareNumbers(a.strictFar, b.strictFar);
    if (third !== 0) return third;
    const fourth = compareNumbers(a.lowBandFar ?? Number.POSITIVE_INFINITY, b.lowBandFar ?? Number.POSITIVE_INFINITY);
    if (fourth !== 0) return fourth;
    const fifth = compareNumbers(a.totalRuntimeAvgMs, b.totalRuntimeAvgMs);
    if (fifth !== 0) return fifth;
    const sixth = compareNumbers(a.validatorRuntimeAvgMs, b.validatorRuntimeAvgMs);
    if (sixth !== 0) return sixth;
    const seventh = compareNumbers(left.config.requiredConsecutiveFrames, right.config.requiredConsecutiveFrames);
    if (seventh !== 0) return seventh;
    const eighth = compareNumbers(left.config.fftSize, right.config.fftSize);
    if (eighth !== 0) return eighth;
    const ninth = compareSampleRatePreference(left.config.sampleRateMode, right.config.sampleRateMode);
    if (ninth !== 0) return ninth;
    return left.key.localeCompare(right.key);
  });
}

function rankCombinedRows(rows: CombinedRow[]): CombinedRow[] {
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

function buildLeaderboardDoc(android: DatasetRun, guitarset: DatasetRun, combinedRows: CombinedRow[], bestCombined: CombinedRow | null): Record<string, unknown> {
  return {
    generatedAtIso: new Date().toISOString(),
    android: {
      bestVariant: summarizeVariant(android.bestVariant),
      leaderboard: rankVariantSummaries(android.variantSummaries).slice(0, 10).map(summarizeVariant)
    },
    guitarset_solo: {
      bestVariant: summarizeVariant(guitarset.bestVariant),
      leaderboard: rankVariantSummaries(guitarset.variantSummaries).slice(0, 10).map(summarizeVariant)
    },
    combined: {
      bestVariant: bestCombined
        ? {
            key: bestCombined.key,
            config: bestCombined.config,
            android: bestCombined.android,
            guitarset: bestCombined.guitarset
          }
        : null,
      leaderboard: rankCombinedRows(combinedRows).slice(0, 10).map((row) => ({
        key: row.key,
        config: row.config,
        android: row.android,
        guitarset: row.guitarset
      }))
    }
  };
}

async function writeOutputs(input: {
  outputDir: string;
  sweepVariants: MonoBenchmarkConfig[];
  android: DatasetRun;
  guitarset: DatasetRun;
  combinedRows: CombinedRow[];
  bestCombined: CombinedRow | null;
  leaderboard: Record<string, unknown>;
}): Promise<void> {
  const generatedAtIso = new Date().toISOString();
  await fs.writeFile(path.join(input.outputDir, 'android_results.json'), `${JSON.stringify(buildDetailedDoc('android', ANDROID_DATASET_ROOT, generatedAtIso, input.android), null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'guitarset_solo_results.json'), `${JSON.stringify(buildDetailedDoc('guitarset_solo', GUITARSET_DATASET_ROOT, generatedAtIso, input.guitarset), null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'android_results.csv'), `${buildCsv(input.android.detailed.results)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'guitarset_solo_results.csv'), `${buildCsv(input.guitarset.detailed.results)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'android_diagnostics.json'), `${JSON.stringify(input.android.detailed.diagnostics, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'guitarset_solo_diagnostics.json'), `${JSON.stringify(input.guitarset.detailed.diagnostics, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'audit.md'), buildAuditMarkdown(input.android, input.guitarset, input.sweepVariants), 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'android_summary.md'), buildDatasetSummaryMarkdown('Android mono-note takes', input.android), 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'guitarset_solo_summary.md'), buildDatasetSummaryMarkdown('GuitarSet _solo', input.guitarset), 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'runtime_report.md'), buildRuntimeMarkdown(input.android, input.guitarset), 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'final_recommendation.md'), buildFinalRecommendationMarkdown(input.android, input.guitarset, input.bestCombined), 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'window_config.json'), `${JSON.stringify({
    androidWindowConfig: DEFAULT_ANDROID_WINDOW_CONFIG,
    guitarsetWindowConfig: DEFAULT_GUITARSET_WINDOW_CONFIG,
    sweepAxes: {
      pitchToleranceCents: [30, 100, 300],
      requiredConsecutiveFrames: [2, 3],
      fftSizes: [2048, 4096],
      sampleRateModes: ['force_48000', 'force_44100']
    },
    bestConfig: input.bestCombined?.config ?? null
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'sweep', 'leaderboard.json'), `${JSON.stringify(input.leaderboard, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'sweep', 'best_config.json'), `${JSON.stringify(input.bestCombined?.config ?? null, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'sweep', 'leaderboard.md'), buildLeaderboardMarkdown(input.android, input.guitarset, input.combinedRows, input.bestCombined), 'utf8');
}

function buildDetailedDoc(dataset: DatasetName, datasetRoot: string, generatedAtIso: string, run: DatasetRun): Record<string, unknown> {
  return {
    generatedAtIso,
    dataset,
    datasetRoot,
    bestVariant: run.bestVariant,
    aggregate: run.detailed.aggregate,
    noteSummary: run.detailed.noteSummary,
    results: run.detailed.results.map(compactResult),
    diagnostics: run.detailed.diagnostics
  };
}

function buildDatasetSummaryMarkdown(title: string, run: DatasetRun): string {
  const aggregate = run.detailed.aggregate;
  return [
    `# ${title}`,
    '',
    `- Best config: ${formatBenchmarkVariantLabel(run.bestVariant.config)}`,
    `- Windows: ${aggregate.windows}`,
    `- Positive windows: ${aggregate.positiveWindows}`,
    `- Negative windows: ${aggregate.negativeWindows}`,
    `- Confirmed windows: ${aggregate.confirmedWindows}`,
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| TAR | ${formatPct(aggregate.tar)} |`,
    `| Strict FAR | ${formatPct(aggregate.strictFar)} |`,
    `| Note-mismatch FAR | ${formatPct(aggregate.noteMismatchFar)} |`,
    `| Precision | ${formatPct(aggregate.precision)} |`,
    `| Recall | ${formatPct(aggregate.recall)} |`,
    `| Confirmed window rate | ${formatPct(aggregate.confirmedWindowRate)} |`,
    `| Detector runtime avg (ms) | ${formatNumber(aggregate.detectorRuntimeAvgMs, 4)} |`,
    `| Detector runtime p95 (ms) | ${formatNumber(aggregate.detectorRuntimeP95Ms, 4)} |`,
    `| Validator runtime avg (ms) | ${formatNumber(aggregate.validatorRuntimeAvgMs, 4)} |`,
    `| Validator runtime p95 (ms) | ${formatNumber(aggregate.validatorRuntimeP95Ms, 4)} |`,
    `| End-to-end avg (ms) | ${formatNumber(aggregate.totalRuntimeAvgMs, 4)} |`,
    `| End-to-end p95 (ms) | ${formatNumber(aggregate.totalRuntimeP95Ms, 4)} |`,
    ''
  ].join('\n');
}

function buildRuntimeMarkdown(android: DatasetRun, guitarset: DatasetRun): string {
  return [
    '# Runtime Report',
    '',
    '- Detector runtime is measured per streaming frame.',
    '- Validator runtime is measured per window evaluation.',
    '- End-to-end runtime is measured per window and includes detector slice plus validator overhead.',
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
  ].join('\n');
}

function buildFinalRecommendationMarkdown(
  android: DatasetRun,
  guitarset: DatasetRun,
  bestCombined: CombinedRow | null
): string {
  const bestConfig = bestCombined?.config ?? null;
  return [
    '# ac14 Gameplay Mono Fallback Recommendation',
    '',
    '## Benchmark Contract',
    '',
    `- Reference frame size: ${DEFAULT_MONO_BENCHMARK_CONFIG.frameSizeSamples} samples`,
    `- Reference hop size: ${DEFAULT_MONO_BENCHMARK_CONFIG.hopSizeSamples} samples`,
    '- Validation windows are defined in seconds and evaluated frame-by-frame using frame midpoints.',
    '- Pitch matches are computed in cents from the detected frequency against the expected note.',
    '- Confirmation requires consecutive good frames inside the active validation window.',
    '- 48 kHz and 44.1 kHz are both forced-resample scenarios in the sweep.',
    '- 2048 and 4096 sample analysis windows are compared directly.',
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
    bestConfig ? `- Recommended config: **${formatBenchmarkVariantLabel(bestConfig)}**.` : '- Recommended config: **none**.',
    bestConfig?.fftSize === 2048
      ? '- 2048 is the more practical gameplay option because it lowers analysis latency without changing the hop cadence.'
      : '- 4096 only makes sense if the accuracy gain is large enough to justify the extra latency.',
    '- TAR lower than FAR can still be reasonable here because the positive and negative window counts are not symmetric and the benchmark is intentionally measuring gameplay validation behavior, not a balanced binary classifier. The key question is whether the streaming semantics match gameplay, not whether TAR and FAR are numerically close.',
    android.detailed.aggregate.tar >= android.detailed.aggregate.strictFar
      ? '- Android data is at least directionally viable for a monophonic fallback under faithful streaming semantics.'
      : '- Android data is still too weak for a clean gameplay fallback decision.',
    ''
  ].join('\n');
}

function buildLeaderboardMarkdown(
  android: DatasetRun,
  guitarset: DatasetRun,
  combinedRows: CombinedRow[],
  bestCombined: CombinedRow | null
): string {
  const lines: string[] = [
    '# ac14 Streaming Sweep Leaderboard',
    '',
    '## Android Leaderboard',
    '',
    '| Rank | Config | TAR | Strict FAR | Note FAR | Low FAR | Runtime avg (ms) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |'
  ];
  rankVariantSummaries(android.variantSummaries).slice(0, 10).forEach((row, index) => {
    lines.push(`| ${index + 1} | ${formatBenchmarkVariantLabel(row.config)} | ${formatPct(row.aggregate.tar)} | ${formatPct(row.aggregate.strictFar)} | ${formatPct(row.aggregate.noteMismatchFar)} | ${formatNullable(row.aggregate.lowBandFar, 3)} | ${formatNumber(row.aggregate.totalRuntimeAvgMs, 4)} |`);
  });

  lines.push(
    '',
    '## GuitarSet _solo Leaderboard',
    '',
    '| Rank | Config | Recall | Strict FAR | Note FAR | Runtime avg (ms) |',
    '| --- | --- | ---: | ---: | ---: | ---: |'
  );
  rankVariantSummaries(guitarset.variantSummaries).slice(0, 10).forEach((row, index) => {
    lines.push(`| ${index + 1} | ${formatBenchmarkVariantLabel(row.config)} | ${formatPct(row.aggregate.recall)} | ${formatPct(row.aggregate.strictFar)} | ${formatPct(row.aggregate.noteMismatchFar)} | ${formatNumber(row.aggregate.totalRuntimeAvgMs, 4)} |`);
  });

  lines.push(
    '',
    '## Combined Leaderboard',
    '',
    '| Rank | Config | Android TAR | Android strict FAR | Android note FAR | Guitar recall | Guitar strict FAR | Runtime avg (ms) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'
  );
  rankCombinedRows(combinedRows).slice(0, 10).forEach((row, index) => {
    lines.push(`| ${index + 1} | ${formatBenchmarkVariantLabel(row.config)} | ${formatPct(row.android.tar)} | ${formatPct(row.android.strictFar)} | ${formatPct(row.android.noteMismatchFar)} | ${formatPct(row.guitarset.recall)} | ${formatPct(row.guitarset.strictFar)} | ${formatNumber(row.android.totalRuntimeAvgMs + row.guitarset.totalRuntimeAvgMs, 4)} |`);
  });

  lines.push('', '## Recommended Variant', '', bestCombined ? `- ${formatBenchmarkVariantLabel(bestCombined.config)}` : '- none', '');
  return lines.join('\n');
}

function buildAuditMarkdown(
  android: DatasetRun,
  guitarset: DatasetRun,
  sweepVariants: MonoBenchmarkConfig[]
): string {
  return [
    '# ac14 Streaming Benchmark Audit',
    '',
    '## Reused',
    '',
    '- Android mono-note take discovery still uses `buildDatasetRows`.',
    '- GuitarSet `_solo` discovery still uses `discoverWavJamsPairs` plus JAMS parsing.',
    '- AC14 still runs through the existing DSP core preset; the detector is not redesigned.',
    '',
    '## Replaced',
    '',
    '- The old probe-spacing benchmark is bypassed for the streaming sweep.',
    '- Acceptance now happens frame-by-frame inside second-based validation windows.',
    '- Pitch tolerance, consecutive confirmation, and confirmation latency are explicit benchmark parameters.',
    '',
    '## Sweep Axes',
    '',
    `- Variants evaluated: ${sweepVariants.length}`,
    '- Pitch tolerance: 30c, 100c, 300c',
    '- Consecutive frames: 2, 3',
    '- FFT size: 2048, 4096',
    '- Sample rate: 48 kHz and 44.1 kHz forced-resample scenarios',
    '',
    '## Dataset Separation',
    '',
    '- Android and GuitarSet _solo stay separate until the final recommendation stage.',
    '',
    '## Current Bests',
    '',
    `- Android best: ${formatBenchmarkVariantLabel(android.bestVariant.config)}`,
    `- GuitarSet _solo best: ${formatBenchmarkVariantLabel(guitarset.bestVariant.config)}`,
    ''
  ].join('\n');
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

function summarizeVariant(variant: VariantSummary): Record<string, unknown> {
  return {
    key: variant.key,
    config: variant.config,
    traceKey: variant.traceKey,
    traceSummary: variant.traceSummary,
    aggregate: variant.aggregate
  };
}

function formatNumber(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
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

function buildTraceKey(config: MonoBenchmarkConfig): string {
  return `${config.sampleRateMode}|fft${config.fftSize}`;
}

function buildValidationKey(config: MonoBenchmarkConfig): string {
  return `tol${config.pitchToleranceCents}|c${config.requiredConsecutiveFrames}`;
}

function uniqueTraceConfigs(variants: MonoBenchmarkConfig[]): MonoBenchmarkConfig[] {
  const seen = new Map<string, MonoBenchmarkConfig>();
  for (const variant of variants) {
    const key = buildTraceKey(variant);
    if (!seen.has(key)) {
      seen.set(key, {
        frameSizeSamples: variant.fftSize,
        hopSizeSamples: variant.hopSizeSamples,
        pitchToleranceCents: DEFAULT_ANDROID_WINDOW_CONFIG.attackStartSec > 0 ? 100 : 100,
        requiredConsecutiveFrames: 2,
        fftSize: variant.fftSize,
        sampleRateMode: variant.sampleRateMode
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

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.max(0, Math.min(1, q));
  const position = clamped * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

main().catch((error) => {
  console.error('[ac14-streaming] fatal error:', error);
  process.exitCode = 1;
});

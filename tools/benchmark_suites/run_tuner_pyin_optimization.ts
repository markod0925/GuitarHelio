#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { midiForStringFret } from '../../src/guitar/tuning';
import {
  DATASET_ROOT,
  WINDOWS_DATASET_ROOT,
  type DatasetRow,
  type PyinRuntimeTuning,
  type PyinTrace,
  average,
  buildDatasetRows,
  centsBetweenFrequencies,
  csvEscape,
  decodeMonoAudio,
  escapeXml,
  finiteNumber,
  formatCsvValue,
  formatNullable,
  formatPct,
  linearScale,
  median,
  percentile,
  resolvePyinCliPath,
  roundNullable,
  roundNumber,
  runPyinTraceForFile,
  standardDeviation,
  stringGroup,
  svgHeader
} from './shared';

type PolicyType = 'raw' | 'hold_last' | 'hold_last_median';

type PolicyConfig = {
  id: string;
  label: string;
  type: PolicyType;
  holdMs?: number;
  medianWindow?: number;
};

type CandidateConfig = {
  id: string;
  shortLabel: string;
  description: string;
  tuning: PyinRuntimeTuning;
};

type FrameObservation = {
  timestampSec: number;
  accepted: boolean;
  pitchHz: number | null;
  midi: number | null;
  confidence: number;
  runtimeMs: number;
  processingTimeMs: number | null;
  callbackLatencyMs: number | null;
};

type FileMetricRow = {
  candidateId: string;
  policyId: string;
  fileId: string;
  relativeFilePath: string;
  stringId: number;
  fret: number;
  take: number;
  stringBand: 'low' | 'mid' | 'high';
  durationSec: number;
  totalFrames: number;
  detectedFrames: number;
  noDetectionFrames: number;
  accurate10Frames: number;
  accurate20Frames: number;
  accurate50Frames: number;
  octaveErrorFrames: number;
  medianAbsCentsError: number | null;
  medianSignedCentsError: number | null;
  jitterMedianAbsDeltaCents: number | null;
  timeToLockMs: number | null;
  sustainStdCents: number | null;
  sustainMedianAbsCents: number | null;
  runtimeAvgMs: number;
  runtimeP95Ms: number;
  processingAvgMs: number | null;
  processingP95Ms: number | null;
  callbackLatencyMedianMs: number | null;
};

type AggregateMetrics = {
  candidateId: string;
  policyId: string;
  fileCount: number;
  totalFrames: number;
  detectedFrames: number;
  pitchAccuracy10Cents: number;
  pitchAccuracy20Cents: number;
  pitchAccuracy50Cents: number;
  noDetectionRate: number;
  octaveErrorRate: number;
  medianAbsCentsError: number | null;
  medianSignedCentsError: number | null;
  medianJitterAbsDeltaCents: number | null;
  medianTimeToLockMs: number | null;
  medianSustainStdCents: number | null;
  medianSustainAbsCents: number | null;
  runtimeAvgMs: number;
  runtimeP95Ms: number;
  processingAvgMs: number | null;
  processingP95Ms: number | null;
  callbackLatencyMedianMs: number | null;
};

type CandidateTraceFileStats = {
  durationSec: number;
  emittedEvents: number;
  emittedEventsPerSecond: number;
  voicedRate: number;
  unvoicedRate: number;
  medianEventIntervalMs: number | null;
  runtimeCallCount: number;
  runtimeCallsPerSecond: number;
  meanWallTimePerRuntimeCallMs: number | null;
  wallRealtimeFactor: number | null;
};

type CandidateTraceStatsAggregate = {
  candidateId: string;
  fileCount: number;
  emittedEventsPerSecondMean: number;
  voicedRateMean: number;
  unvoicedRateMean: number;
  medianEventIntervalMs: number | null;
  runtimeCallsPerSecondMean: number;
  meanWallTimePerRuntimeCallMs: number | null;
  wallRealtimeFactorMean: number | null;
};

type BaselineAggregate = {
  algorithm: string;
  fileCount: number;
  totalFrames: number;
  detectedFrames: number;
  pitchAccuracy10Cents: number;
  pitchAccuracy20Cents: number;
  pitchAccuracy50Cents: number;
  noDetectionRate: number;
  octaveErrorRate: number;
  medianAbsCentsError: number | null;
  medianSignedCentsError: number | null;
  medianJitterAbsDeltaCents: number | null;
  medianTimeToLockMs: number | null;
  medianSustainStdCents: number | null;
  medianSustainAbsCents: number | null;
  runtimeAvgMs: number;
  runtimeP95Ms: number;
};

const OUTPUT_ROOT = 'analysis/tuner_pyin_optimization';
const LOCK_TOLERANCE_CENTS = 20;
const LOCK_CONSECUTIVE_FRAMES = 3;

const CANDIDATES: CandidateConfig[] = [
  {
    id: 'default_b4096',
    shortLabel: 'b4096 default',
    description: 'Current-style default profile with block=4096 and pyin defaults.',
    tuning: {
      sampleRate: 48_000,
      blockSize: 4096,
      callbackSize: 4096
    }
  },
  {
    id: 'default_b2048',
    shortLabel: 'b2048 default',
    description: 'Reduced block size to 2048 while keeping pyin defaults.',
    tuning: {
      sampleRate: 48_000,
      blockSize: 2048,
      callbackSize: 512
    }
  },
  {
    id: 'default_b1024',
    shortLabel: 'b1024 default',
    description: 'Reduced block size to 1024 while keeping pyin defaults.',
    tuning: {
      sampleRate: 48_000,
      blockSize: 1024,
      callbackSize: 256
    }
  },
  {
    id: 'f2048_h512_b1024',
    shortLabel: 'b1024 f2048 h512',
    description: 'Tuner-oriented overlap with explicit frame=2048, hop=512.',
    tuning: {
      sampleRate: 48_000,
      blockSize: 1024,
      callbackSize: 256,
      pyin: {
        frameLength: 2048,
        hopLength: 512,
        fminHz: 82.40689,
        fmaxHz: 1200
      }
    }
  },
  {
    id: 'f3072_h512_b1024',
    shortLabel: 'b1024 f3072 h512',
    description: 'Longer analysis window for low-string robustness, overlap hop=512.',
    tuning: {
      sampleRate: 48_000,
      blockSize: 1024,
      callbackSize: 256,
      pyin: {
        frameLength: 3072,
        hopLength: 512,
        fminHz: 82.40689,
        fmaxHz: 1200
      }
    }
  },
  {
    id: 'f2048_h512_b1024_lowfmin',
    shortLabel: 'b1024 f2048 h512 lowfmin',
    description: 'frame=2048 hop=512 with wider low-end range (fmin=70Hz).',
    tuning: {
      sampleRate: 48_000,
      blockSize: 1024,
      callbackSize: 256,
      pyin: {
        frameLength: 2048,
        hopLength: 512,
        fminHz: 70,
        fmaxHz: 1200
      }
    }
  },
  {
    id: 'f2048_h512_b1024_res02',
    shortLabel: 'b1024 f2048 h512 r0.2',
    description: 'frame=2048 hop=512 with coarser pyin resolution=0.2 for speed.',
    tuning: {
      sampleRate: 48_000,
      blockSize: 1024,
      callbackSize: 256,
      pyin: {
        frameLength: 2048,
        hopLength: 512,
        fminHz: 82.40689,
        fmaxHz: 1200,
        resolution: 0.2
      }
    }
  }
];

const POLICIES: PolicyConfig[] = [
  { id: 'raw', label: 'RAW', type: 'raw' },
  { id: 'hold_120ms', label: 'Hold last 120ms', type: 'hold_last', holdMs: 120 },
  { id: 'hold_240ms', label: 'Hold last 240ms', type: 'hold_last', holdMs: 240 },
  { id: 'hold_120ms_median3', label: 'Hold 120ms + median3', type: 'hold_last_median', holdMs: 120, medianWindow: 3 }
];

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const datasetDir = path.resolve(repoRoot, DATASET_ROOT);
  const outputDir = path.resolve(repoRoot, OUTPUT_ROOT);
  const cacheRoot = path.join(outputDir, '.pyin_cache');
  const plotsDir = path.join(outputDir, 'plots');
  await fs.mkdir(cacheRoot, { recursive: true });
  await fs.mkdir(plotsDir, { recursive: true });

  const baselinePath = path.resolve(repoRoot, 'analysis/tuner_benchmark/results.json');
  const baselineDoc = JSON.parse(await fs.readFile(baselinePath, 'utf8')) as {
    aggregates: Record<string, BaselineAggregate>;
    aggregatesByStringBand: Record<string, { low: BaselineAggregate; high: BaselineAggregate }>;
  };
  const ac14Baseline = baselineDoc.aggregates.ac14;
  const ac14LowHigh = baselineDoc.aggregatesByStringBand.ac14;

  const datasetRows = await buildDatasetRows(datasetDir);
  if (datasetRows.length <= 0) {
    throw new Error(`No WAV files found under ${datasetDir}`);
  }

  const pyinCliPath = await resolvePyinCliPath(repoRoot);
  const durations = new Map<string, number>();

  const fileRows: FileMetricRow[] = [];
  const traceStatsByCandidate = new Map<string, CandidateTraceFileStats[]>();

  for (const candidate of CANDIDATES) {
    const candidateCacheDir = path.join(cacheRoot, candidate.id);
    await fs.mkdir(candidateCacheDir, { recursive: true });
    traceStatsByCandidate.set(candidate.id, []);

    for (let index = 0; index < datasetRows.length; index += 1) {
      const row = datasetRows[index];
      console.log(`[pyin-opt] ${candidate.id} ${index + 1}/${datasetRows.length} ${row.relativeFilePath}`);

      const trace = await runPyinTraceForFile({
        filePath: row.filePath,
        fileId: row.fileId,
        cliPath: pyinCliPath,
        outputDir: candidateCacheDir,
        tuning: {
          ...candidate.tuning,
          disableFallbackCache: true
        }
      });

      const durationSec = await resolveDurationSec(row, trace, durations);
      const targetMidi = midiForStringFret(row.stringId, row.fret);
      const targetHz = midiToHz(targetMidi);

      const rawFrames = buildPyinFrameObservations(trace, durationSec);
      traceStatsByCandidate.get(candidate.id)?.push(summarizeTraceFileStats(trace, rawFrames, durationSec));

      for (const policy of POLICIES) {
        const policyFrames = applyTunerPolicy(rawFrames, policy);
        fileRows.push(summarizeFileRow(candidate.id, policy.id, row, durationSec, targetHz, policyFrames));
      }
    }
  }

  const aggregates: AggregateMetrics[] = [];
  const aggregatesByBand: Array<AggregateMetrics & { stringBand: 'low' | 'high' }> = [];
  for (const candidate of CANDIDATES) {
    for (const policy of POLICIES) {
      const rows = fileRows.filter((row) => row.candidateId === candidate.id && row.policyId === policy.id);
      const agg = aggregateRows(candidate.id, policy.id, rows);
      aggregates.push(agg);

      const lowAgg = aggregateRows(candidate.id, policy.id, rows.filter((row) => row.stringBand === 'low'));
      const highAgg = aggregateRows(candidate.id, policy.id, rows.filter((row) => row.stringBand === 'high'));
      aggregatesByBand.push({ ...lowAgg, stringBand: 'low' });
      aggregatesByBand.push({ ...highAgg, stringBand: 'high' });
    }
  }

  const traceAggregates = CANDIDATES.map((candidate) => {
    const rows = traceStatsByCandidate.get(candidate.id) ?? [];
    return aggregateTraceStats(candidate.id, rows);
  });

  const rawAggregates = aggregates
    .filter((row) => row.policyId === 'raw')
    .sort(compareAggregatesForTuner);
  const smoothedAggregates = aggregates
    .filter((row) => row.policyId !== 'raw')
    .sort(compareAggregatesForTuner);
  const bestRaw = rawAggregates[0] ?? null;
  const bestSmoothed = smoothedAggregates[0] ?? null;

  const bestPolicyByCandidate = CANDIDATES.map((candidate) => {
    const candidateRows = aggregates
      .filter((row) => row.candidateId === candidate.id)
      .sort(compareAggregatesForTuner);
    return {
      candidateId: candidate.id,
      bestPolicyId: candidateRows[0]?.policyId ?? 'raw',
      ranking: candidateRows.map((item) => item.policyId)
    };
  });

  await writeResults({
    outputDir,
    fileRows,
    aggregates,
    aggregatesByBand,
    traceAggregates,
    ac14Baseline,
    ac14LowHigh,
    bestRaw,
    bestSmoothed,
    bestPolicyByCandidate
  });
  await writeCandidateConfigs(outputDir);
  await writePlots(plotsDir, rawAggregates, aggregatesByBand, ac14Baseline);
  await writeSummary({
    outputDir,
    rawAggregates,
    aggregates,
    aggregatesByBand,
    traceAggregates,
    ac14Baseline,
    ac14LowHigh,
    bestRaw,
    bestSmoothed
  });

  console.log(`Outputs: ${OUTPUT_ROOT}`);
  console.log(`Candidates: ${CANDIDATES.length}`);
  console.log(`Policies: ${POLICIES.length}`);
  console.log(`Files analyzed: ${datasetRows.length}`);
}

async function resolveDurationSec(row: DatasetRow, trace: PyinTrace, cache: Map<string, number>): Promise<number> {
  if (row.durationSec !== null && Number.isFinite(row.durationSec) && row.durationSec > 0) {
    return row.durationSec;
  }
  const fromTrace = trace.frames[trace.frames.length - 1]?.captureTimeSec;
  if (fromTrace && Number.isFinite(fromTrace) && fromTrace > 0) {
    return fromTrace;
  }
  const cached = cache.get(row.filePath);
  if (cached !== undefined) return cached;
  const decoded = await decodeMonoAudio(row.filePath);
  const duration = decoded.samples.length / decoded.sampleRate;
  cache.set(row.filePath, duration);
  return duration;
}

function buildPyinFrameObservations(trace: PyinTrace, durationSec: number): FrameObservation[] {
  if (trace.frames.length <= 0) {
    return [
      {
        timestampSec: Math.max(0, durationSec * 0.5),
        accepted: false,
        pitchHz: null,
        midi: null,
        confidence: 0,
        runtimeMs: trace.wallTimeMs,
        processingTimeMs: null,
        callbackLatencyMs: null
      }
    ];
  }

  const runtimeFallbackMs = trace.frames.length > 0 ? trace.wallTimeMs / trace.frames.length : trace.wallTimeMs;
  return trace.frames.map((frame) => {
    const accepted = frame.pitchHz !== null && frame.midiEstimate !== null;
    return {
      timestampSec: frame.captureTimeSec,
      accepted,
      pitchHz: frame.pitchHz,
      midi: frame.midiEstimate,
      confidence: frame.confidence ?? 0,
      runtimeMs: frame.processingTimeMs ?? runtimeFallbackMs,
      processingTimeMs: frame.processingTimeMs,
      callbackLatencyMs: frame.callbackToResultLatencyMs
    };
  });
}

function applyTunerPolicy(frames: FrameObservation[], policy: PolicyConfig): FrameObservation[] {
  if (policy.type === 'raw') {
    return frames.map((frame) => ({ ...frame }));
  }

  const holdSec = Math.max(0, (policy.holdMs ?? 0) / 1000);
  const recentPitch: number[] = [];
  let lastAccepted: FrameObservation | null = null;
  const out: FrameObservation[] = [];

  for (const frame of frames) {
    if (frame.accepted && frame.pitchHz !== null) {
      let pitchHz = frame.pitchHz;
      let midi = frame.midi;
      if (policy.type === 'hold_last_median') {
        recentPitch.push(frame.pitchHz);
        const window = Math.max(1, policy.medianWindow ?? 3);
        while (recentPitch.length > window) recentPitch.shift();
        const smoothed = median(recentPitch);
        if (smoothed !== null && Number.isFinite(smoothed) && smoothed > 0) {
          pitchHz = smoothed;
          midi = hzToMidi(smoothed);
        }
      }
      const acceptedFrame: FrameObservation = {
        ...frame,
        accepted: true,
        pitchHz,
        midi
      };
      lastAccepted = acceptedFrame;
      out.push(acceptedFrame);
      continue;
    }

    if (lastAccepted && frame.timestampSec - lastAccepted.timestampSec <= holdSec) {
      out.push({
        ...frame,
        accepted: true,
        pitchHz: lastAccepted.pitchHz,
        midi: lastAccepted.midi,
        confidence: Math.max(lastAccepted.confidence * 0.85, frame.confidence)
      });
      continue;
    }

    out.push({ ...frame, accepted: false, pitchHz: null, midi: null });
  }

  return out;
}

function summarizeTraceFileStats(trace: PyinTrace, rawFrames: FrameObservation[], durationSec: number): CandidateTraceFileStats {
  const emittedEvents = rawFrames.length;
  const voiced = rawFrames.filter((frame) => frame.accepted).length;
  const emittedEventsPerSecond = durationSec > 0 ? emittedEvents / durationSec : 0;
  const voicedRate = emittedEvents > 0 ? voiced / emittedEvents : 0;
  const intervalsMs: number[] = [];
  for (let index = 1; index < rawFrames.length; index += 1) {
    intervalsMs.push((rawFrames[index].timestampSec - rawFrames[index - 1].timestampSec) * 1000);
  }
  const runtimeCallsPerSecond = durationSec > 0 ? trace.runtimeCallCount / durationSec : 0;
  const wallRealtimeFactor = trace.wallTimeMs > 0 ? (durationSec * 1000) / trace.wallTimeMs : null;

  return {
    durationSec,
    emittedEvents,
    emittedEventsPerSecond,
    voicedRate,
    unvoicedRate: emittedEvents > 0 ? 1 - voicedRate : 1,
    medianEventIntervalMs: median(intervalsMs),
    runtimeCallCount: trace.runtimeCallCount,
    runtimeCallsPerSecond,
    meanWallTimePerRuntimeCallMs: trace.meanWallTimePerRuntimeCallMs,
    wallRealtimeFactor
  };
}

function aggregateTraceStats(candidateId: string, rows: CandidateTraceFileStats[]): CandidateTraceStatsAggregate {
  return {
    candidateId,
    fileCount: rows.length,
    emittedEventsPerSecondMean: roundNumber(average(rows.map((row) => row.emittedEventsPerSecond)), 6),
    voicedRateMean: roundNumber(average(rows.map((row) => row.voicedRate)), 6),
    unvoicedRateMean: roundNumber(average(rows.map((row) => row.unvoicedRate)), 6),
    medianEventIntervalMs: roundNullable(median(rows.map((row) => row.medianEventIntervalMs).filter((value): value is number => value !== null)), 3),
    runtimeCallsPerSecondMean: roundNumber(average(rows.map((row) => row.runtimeCallsPerSecond)), 6),
    meanWallTimePerRuntimeCallMs: roundNullable(median(rows.map((row) => row.meanWallTimePerRuntimeCallMs).filter((value): value is number => value !== null)), 6),
    wallRealtimeFactorMean: roundNullable(median(rows.map((row) => row.wallRealtimeFactor).filter((value): value is number => value !== null)), 6)
  };
}

function summarizeFileRow(
  candidateId: string,
  policyId: string,
  row: DatasetRow,
  durationSec: number,
  targetHz: number,
  frames: FrameObservation[]
): FileMetricRow {
  const totalFrames = frames.length;
  const detected = frames.filter((frame) => frame.accepted && frame.pitchHz !== null);
  const detectedFrames = detected.length;
  const noDetectionFrames = totalFrames - detectedFrames;

  const cents = detected
    .map((frame) => centsBetweenFrequencies(frame.pitchHz!, targetHz))
    .filter((value) => Number.isFinite(value));
  const absCents = cents.map((value) => Math.abs(value));

  const accurate10Frames = absCents.filter((value) => value <= 10).length;
  const accurate20Frames = absCents.filter((value) => value <= 20).length;
  const accurate50Frames = absCents.filter((value) => value <= 50).length;
  const octaveErrorFrames = absCents.filter((value) => Math.abs(value - 1200) <= 100).length;

  const jitterMedianAbsDeltaCents = computeJitter(cents);
  const timeToLockMs = computeTimeToLock(frames, targetHz);
  const sustainRows = detected.filter((frame) => frame.timestampSec >= durationSec * 0.5);
  const sustainAbsCents = sustainRows.map((frame) => Math.abs(centsBetweenFrequencies(frame.pitchHz!, targetHz)));
  const sustainSignedCents = sustainRows.map((frame) => centsBetweenFrequencies(frame.pitchHz!, targetHz));

  const runtimeSamples = frames.map((frame) => frame.runtimeMs);
  const processingSamples = frames
    .map((frame) => frame.processingTimeMs)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const callbackLatencySamples = frames
    .map((frame) => frame.callbackLatencyMs)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  return {
    candidateId,
    policyId,
    fileId: row.fileId,
    relativeFilePath: row.relativeFilePath,
    stringId: row.stringId,
    fret: row.fret,
    take: row.take,
    stringBand: stringGroup(row.stringId),
    durationSec: roundNumber(durationSec, 6),
    totalFrames,
    detectedFrames,
    noDetectionFrames,
    accurate10Frames,
    accurate20Frames,
    accurate50Frames,
    octaveErrorFrames,
    medianAbsCentsError: roundNullable(median(absCents), 3),
    medianSignedCentsError: roundNullable(median(cents), 3),
    jitterMedianAbsDeltaCents: roundNullable(jitterMedianAbsDeltaCents, 3),
    timeToLockMs: roundNullable(timeToLockMs, 3),
    sustainStdCents: roundNullable(standardDeviation(sustainSignedCents), 3),
    sustainMedianAbsCents: roundNullable(median(sustainAbsCents), 3),
    runtimeAvgMs: roundNumber(average(runtimeSamples), 6),
    runtimeP95Ms: roundNullable(percentile(runtimeSamples, 0.95), 6) ?? 0,
    processingAvgMs: roundNullable(averageOrNull(processingSamples), 6),
    processingP95Ms: roundNullable(percentile(processingSamples, 0.95), 6),
    callbackLatencyMedianMs: roundNullable(median(callbackLatencySamples), 6)
  };
}

function computeJitter(cents: number[]): number | null {
  if (cents.length < 2) return null;
  const deltas: number[] = [];
  for (let index = 1; index < cents.length; index += 1) {
    deltas.push(Math.abs(cents[index] - cents[index - 1]));
  }
  return median(deltas);
}

function computeTimeToLock(frames: FrameObservation[], targetHz: number): number | null {
  let streak = 0;
  for (const frame of frames) {
    if (!frame.accepted || frame.pitchHz === null) {
      streak = 0;
      continue;
    }
    const absCents = Math.abs(centsBetweenFrequencies(frame.pitchHz, targetHz));
    if (absCents <= LOCK_TOLERANCE_CENTS) {
      streak += 1;
      if (streak >= LOCK_CONSECUTIVE_FRAMES) {
        return frame.timestampSec * 1000;
      }
    } else {
      streak = 0;
    }
  }
  return null;
}

function aggregateRows(candidateId: string, policyId: string, rows: FileMetricRow[]): AggregateMetrics {
  const totalFrames = rows.reduce((sum, row) => sum + row.totalFrames, 0);
  const detectedFrames = rows.reduce((sum, row) => sum + row.detectedFrames, 0);
  const accurate10Frames = rows.reduce((sum, row) => sum + row.accurate10Frames, 0);
  const accurate20Frames = rows.reduce((sum, row) => sum + row.accurate20Frames, 0);
  const accurate50Frames = rows.reduce((sum, row) => sum + row.accurate50Frames, 0);
  const noDetectionFrames = rows.reduce((sum, row) => sum + row.noDetectionFrames, 0);
  const octaveErrorFrames = rows.reduce((sum, row) => sum + row.octaveErrorFrames, 0);

  const runtimeSamples = rows.map((row) => row.runtimeAvgMs);
  const processingSamples = rows.map((row) => row.processingAvgMs).filter((value): value is number => value !== null);
  const callbackLatencySamples = rows.map((row) => row.callbackLatencyMedianMs).filter((value): value is number => value !== null);

  return {
    candidateId,
    policyId,
    fileCount: rows.length,
    totalFrames,
    detectedFrames,
    pitchAccuracy10Cents: totalFrames > 0 ? accurate10Frames / totalFrames : 0,
    pitchAccuracy20Cents: totalFrames > 0 ? accurate20Frames / totalFrames : 0,
    pitchAccuracy50Cents: totalFrames > 0 ? accurate50Frames / totalFrames : 0,
    noDetectionRate: totalFrames > 0 ? noDetectionFrames / totalFrames : 0,
    octaveErrorRate: totalFrames > 0 ? octaveErrorFrames / totalFrames : 0,
    medianAbsCentsError: roundNullable(median(rows.map((row) => row.medianAbsCentsError).filter((value): value is number => value !== null)), 3),
    medianSignedCentsError: roundNullable(median(rows.map((row) => row.medianSignedCentsError).filter((value): value is number => value !== null)), 3),
    medianJitterAbsDeltaCents: roundNullable(median(rows.map((row) => row.jitterMedianAbsDeltaCents).filter((value): value is number => value !== null)), 3),
    medianTimeToLockMs: roundNullable(median(rows.map((row) => row.timeToLockMs).filter((value): value is number => value !== null)), 3),
    medianSustainStdCents: roundNullable(median(rows.map((row) => row.sustainStdCents).filter((value): value is number => value !== null)), 3),
    medianSustainAbsCents: roundNullable(median(rows.map((row) => row.sustainMedianAbsCents).filter((value): value is number => value !== null)), 3),
    runtimeAvgMs: roundNumber(average(runtimeSamples), 6),
    runtimeP95Ms: roundNullable(percentile(rows.map((row) => row.runtimeP95Ms), 0.95), 6) ?? 0,
    processingAvgMs: roundNullable(median(processingSamples), 6),
    processingP95Ms: roundNullable(percentile(processingSamples, 0.95), 6),
    callbackLatencyMedianMs: roundNullable(median(callbackLatencySamples), 6)
  };
}

function compareAggregatesForTuner(left: AggregateMetrics, right: AggregateMetrics): number {
  return (
    left.noDetectionRate - right.noDetectionRate ||
    nullHigh(left.medianTimeToLockMs) - nullHigh(right.medianTimeToLockMs) ||
    left.octaveErrorRate - right.octaveErrorRate ||
    nullHigh(left.medianAbsCentsError) - nullHigh(right.medianAbsCentsError) ||
    left.runtimeP95Ms - right.runtimeP95Ms ||
    left.runtimeAvgMs - right.runtimeAvgMs ||
    left.candidateId.localeCompare(right.candidateId)
  );
}

function nullHigh(value: number | null): number {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

async function writeCandidateConfigs(outputDir: string): Promise<void> {
  const doc = {
    generatedAtIso: new Date().toISOString(),
    candidates: CANDIDATES,
    policies: POLICIES
  };
  await fs.writeFile(path.join(outputDir, 'candidate_configurations.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

async function writeResults(input: {
  outputDir: string;
  fileRows: FileMetricRow[];
  aggregates: AggregateMetrics[];
  aggregatesByBand: Array<AggregateMetrics & { stringBand: 'low' | 'high' }>;
  traceAggregates: CandidateTraceStatsAggregate[];
  ac14Baseline: BaselineAggregate;
  ac14LowHigh: { low: BaselineAggregate; high: BaselineAggregate };
  bestRaw: AggregateMetrics | null;
  bestSmoothed: AggregateMetrics | null;
  bestPolicyByCandidate: Array<{ candidateId: string; bestPolicyId: string; ranking: string[] }>;
}): Promise<void> {
  const doc = {
    generatedAtIso: new Date().toISOString(),
    suite: 'tuner_pyin_optimization',
    datasetPath: DATASET_ROOT,
    datasetPathWindows: WINDOWS_DATASET_ROOT,
    rawOnly: true,
    lockConfig: {
      lockToleranceCents: LOCK_TOLERANCE_CENTS,
      lockConsecutiveFrames: LOCK_CONSECUTIVE_FRAMES
    },
    baselineAc14: {
      aggregate: input.ac14Baseline,
      byStringBand: input.ac14LowHigh
    },
    candidates: CANDIDATES,
    policies: POLICIES,
    bestRaw: input.bestRaw,
    bestSmoothed: input.bestSmoothed,
    bestPolicyByCandidate: input.bestPolicyByCandidate,
    traceAggregates: input.traceAggregates,
    aggregates: input.aggregates,
    aggregatesByBand: input.aggregatesByBand,
    rows: input.fileRows
  };

  await fs.writeFile(path.join(input.outputDir, 'results.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(input.outputDir, 'results.csv'), `${buildAggregateCsv(input.aggregates, input.aggregatesByBand)}\n`, 'utf8');
}

function buildAggregateCsv(
  aggregates: AggregateMetrics[],
  aggregatesByBand: Array<AggregateMetrics & { stringBand: 'low' | 'high' }>
): string {
  const header = [
    'candidate_id',
    'policy_id',
    'string_band',
    'file_count',
    'total_frames',
    'detected_frames',
    'accuracy_10',
    'accuracy_20',
    'accuracy_50',
    'no_detect_rate',
    'octave_error_rate',
    'median_abs_cents',
    'median_signed_cents',
    'median_jitter_abs_delta_cents',
    'median_time_to_lock_ms',
    'median_sustain_std_cents',
    'median_sustain_abs_cents',
    'runtime_avg_ms',
    'runtime_p95_ms',
    'processing_avg_ms',
    'processing_p95_ms',
    'callback_latency_median_ms'
  ];

  const lines = [header.join(',')];
  const pushRow = (row: AggregateMetrics, stringBand: string) => {
    lines.push([
      row.candidateId,
      row.policyId,
      stringBand,
      row.fileCount,
      row.totalFrames,
      row.detectedFrames,
      row.pitchAccuracy10Cents,
      row.pitchAccuracy20Cents,
      row.pitchAccuracy50Cents,
      row.noDetectionRate,
      row.octaveErrorRate,
      row.medianAbsCentsError,
      row.medianSignedCentsError,
      row.medianJitterAbsDeltaCents,
      row.medianTimeToLockMs,
      row.medianSustainStdCents,
      row.medianSustainAbsCents,
      row.runtimeAvgMs,
      row.runtimeP95Ms,
      row.processingAvgMs,
      row.processingP95Ms,
      row.callbackLatencyMedianMs
    ].map((value) => csvEscape(formatCsvValue(value))).join(','));
  };

  for (const row of aggregates) pushRow(row, 'all');
  for (const row of aggregatesByBand) pushRow(row, row.stringBand);
  return lines.join('\n');
}

async function writePlots(
  plotsDir: string,
  rawAggregates: AggregateMetrics[],
  aggregatesByBand: Array<AggregateMetrics & { stringBand: 'low' | 'high' }>,
  ac14Baseline: BaselineAggregate
): Promise<void> {
  const candidateById = new Map(CANDIDATES.map((candidate) => [candidate.id, candidate]));
  const sorted = [...rawAggregates].sort(compareAggregatesForTuner);

  await fs.writeFile(
    path.join(plotsDir, 'no_detection_rate_vs_configuration.svg'),
    buildSingleMetricPlot(
      'No-Detection Rate by Configuration (RAW)',
      sorted.map((row) => ({ label: candidateById.get(row.candidateId)?.shortLabel ?? row.candidateId, value: row.noDetectionRate })),
      { baseline: ac14Baseline.noDetectionRate, format: (value) => formatPct(value), lowerIsBetter: true }
    ),
    'utf8'
  );

  await fs.writeFile(
    path.join(plotsDir, 'time_to_lock_vs_configuration.svg'),
    buildSingleMetricPlot(
      'Median Time-to-Lock by Configuration (RAW)',
      sorted.map((row) => ({ label: candidateById.get(row.candidateId)?.shortLabel ?? row.candidateId, value: row.medianTimeToLockMs ?? 0 })),
      { baseline: ac14Baseline.medianTimeToLockMs ?? 0, format: (value) => `${value.toFixed(0)} ms`, lowerIsBetter: true }
    ),
    'utf8'
  );

  await fs.writeFile(
    path.join(plotsDir, 'runtime_avg_p95_vs_configuration.svg'),
    buildDualMetricPlot(
      'Runtime Avg/P95 by Configuration (RAW)',
      sorted.map((row) => ({
        label: candidateById.get(row.candidateId)?.shortLabel ?? row.candidateId,
        first: row.runtimeAvgMs,
        second: row.runtimeP95Ms
      })),
      { firstLabel: 'avg', secondLabel: 'p95', format: (value) => `${value.toFixed(2)} ms` }
    ),
    'utf8'
  );

  await fs.writeFile(
    path.join(plotsDir, 'accuracy_20_50_vs_configuration.svg'),
    buildDualMetricPlot(
      'Accuracy ±20c / ±50c by Configuration (RAW)',
      sorted.map((row) => ({
        label: candidateById.get(row.candidateId)?.shortLabel ?? row.candidateId,
        first: row.pitchAccuracy20Cents,
        second: row.pitchAccuracy50Cents
      })),
      { firstLabel: '±20c', secondLabel: '±50c', format: (value) => formatPct(value) }
    ),
    'utf8'
  );

  const lowHighRows = sorted.map((row) => {
    const low = aggregatesByBand.find((item) => item.candidateId === row.candidateId && item.policyId === 'raw' && item.stringBand === 'low');
    const high = aggregatesByBand.find((item) => item.candidateId === row.candidateId && item.policyId === 'raw' && item.stringBand === 'high');
    return {
      label: candidateById.get(row.candidateId)?.shortLabel ?? row.candidateId,
      first: low?.pitchAccuracy50Cents ?? 0,
      second: high?.pitchAccuracy50Cents ?? 0
    };
  });

  await fs.writeFile(
    path.join(plotsDir, 'low_high_string_accuracy_by_configuration.svg'),
    buildDualMetricPlot(
      'Low vs High String ±50c Accuracy (RAW)',
      lowHighRows,
      { firstLabel: 'low strings (5-6)', secondLabel: 'high strings (1-2)', format: (value) => formatPct(value) }
    ),
    'utf8'
  );

  await fs.writeFile(
    path.join(plotsDir, 'octave_error_rate_by_configuration.svg'),
    buildSingleMetricPlot(
      'Octave Error Rate by Configuration (RAW)',
      sorted.map((row) => ({ label: candidateById.get(row.candidateId)?.shortLabel ?? row.candidateId, value: row.octaveErrorRate })),
      { baseline: ac14Baseline.octaveErrorRate, format: (value) => formatPct(value), lowerIsBetter: true }
    ),
    'utf8'
  );

  await fs.writeFile(
    path.join(plotsDir, 'tradeoff_no_detect_vs_accuracy50.svg'),
    buildTradeoffScatterPlot(
      'Tradeoff: No-Detect vs ±50c Accuracy (RAW)',
      sorted.map((row, index) => ({
        label: candidateById.get(row.candidateId)?.shortLabel ?? row.candidateId,
        x: row.noDetectionRate,
        y: row.pitchAccuracy50Cents,
        color: colorByIndex(index)
      })),
      { xLabel: 'no-detect rate (lower better)', yLabel: '±50c accuracy (higher better)' }
    ),
    'utf8'
  );
}

async function writeSummary(input: {
  outputDir: string;
  rawAggregates: AggregateMetrics[];
  aggregates: AggregateMetrics[];
  aggregatesByBand: Array<AggregateMetrics & { stringBand: 'low' | 'high' }>;
  traceAggregates: CandidateTraceStatsAggregate[];
  ac14Baseline: BaselineAggregate;
  ac14LowHigh: { low: BaselineAggregate; high: BaselineAggregate };
  bestRaw: AggregateMetrics | null;
  bestSmoothed: AggregateMetrics | null;
}): Promise<void> {
  const candidateMap = new Map(CANDIDATES.map((candidate) => [candidate.id, candidate]));
  const bestRawLabel = input.bestRaw ? candidateMap.get(input.bestRaw.candidateId)?.shortLabel ?? input.bestRaw.candidateId : 'n/a';
  const bestSmoothedLabel = input.bestSmoothed ? `${candidateMap.get(input.bestSmoothed.candidateId)?.shortLabel ?? input.bestSmoothed.candidateId} + ${input.bestSmoothed.policyId}` : 'n/a';

  const defaultTrace = input.traceAggregates.find((row) => row.candidateId === 'default_b4096');
  const bestRawLow = input.bestRaw
    ? input.aggregatesByBand.find((row) => row.candidateId === input.bestRaw!.candidateId && row.policyId === input.bestRaw!.policyId && row.stringBand === 'low')
    : null;
  const bestRawHigh = input.bestRaw
    ? input.aggregatesByBand.find((row) => row.candidateId === input.bestRaw!.candidateId && row.policyId === input.bestRaw!.policyId && row.stringBand === 'high')
    : null;

  const bestVsAc14 = input.bestRaw
    ? {
        noDetectDelta: input.bestRaw.noDetectionRate - input.ac14Baseline.noDetectionRate,
        lockDeltaMs: (input.bestRaw.medianTimeToLockMs ?? 0) - (input.ac14Baseline.medianTimeToLockMs ?? 0),
        octaveDelta: input.bestRaw.octaveErrorRate - input.ac14Baseline.octaveErrorRate,
        centsDelta: (input.bestRaw.medianAbsCentsError ?? 0) - (input.ac14Baseline.medianAbsCentsError ?? 0),
        runtimeP95DeltaMs: input.bestRaw.runtimeP95Ms - input.ac14Baseline.runtimeP95Ms
      }
    : null;

  const keepAc14 = !input.bestRaw || input.bestRaw.noDetectionRate > input.ac14Baseline.noDetectionRate * 1.15;
  const recommendation = keepAc14
    ? 'Keep `ac14` as current Tuner production default, continue `pyin` optimization.'
    : 'Switch Tuner to `pyin` candidate with the best RAW profile.';

  const content = [
    '# Tuner pYIN Optimization Summary',
    '',
    `- Dataset: \`${DATASET_ROOT}\``,
    `- Candidates tested: ${CANDIDATES.length}`,
    `- Policies tested: ${POLICIES.map((policy) => `\`${policy.id}\``).join(', ')}`,
    `- Baseline reference: \`ac14\` from \`analysis/tuner_benchmark/results.json\``,
    '',
    '## 1) What is causing current pYIN weakness in Tuner?',
    '',
    `- Current/default profile uses large cadence (block=4096 at 48k => ~85.3ms per runtime call) and sparse event emission.`,
    `- Default trace diagnostics show emitted event cadence around ${formatNullable(defaultTrace?.emittedEventsPerSecondMean ?? null, 2, ' evt/s')} with median event interval ${formatNullable(defaultTrace?.medianEventIntervalMs ?? null, 1, ' ms')}.`,
    `- Unvoiced decisions remain high in default mode (mean unvoiced rate ${formatPct(defaultTrace?.unvoicedRateMean ?? 0)}), which drives no-detect and resets lock streaks.`,
    `- With sparse/intermittent voiced frames, lock criterion (3 consecutive frames within ±20c) is reached late or missed.`,
    '',
    '## 2) Which configuration is best for Tuner?',
    '',
    `- Best RAW configuration: **${bestRawLabel}** (${input.bestRaw?.candidateId ?? 'n/a'}).`,
    `- Best smoothed output policy result: **${bestSmoothedLabel}**.`,
    input.bestRaw
      ? `- Best RAW metrics: ±20c ${formatPct(input.bestRaw.pitchAccuracy20Cents)}, ±50c ${formatPct(input.bestRaw.pitchAccuracy50Cents)}, no-detect ${formatPct(input.bestRaw.noDetectionRate)}, octave-error ${formatPct(input.bestRaw.octaveErrorRate)}, lock ${formatNullable(input.bestRaw.medianTimeToLockMs, 1, ' ms')}, runtime avg/p95 ${input.bestRaw.runtimeAvgMs.toFixed(3)} / ${input.bestRaw.runtimeP95Ms.toFixed(3)} ms.`
      : '- Best RAW metrics: n/a',
    bestRawLow && bestRawHigh
      ? `- Best RAW low/high ±50c: low ${formatPct(bestRawLow.pitchAccuracy50Cents)} vs high ${formatPct(bestRawHigh.pitchAccuracy50Cents)}.`
      : '- Best RAW low/high ±50c: n/a',
    '',
    '## 3) Does best pYIN now beat ac14 for Tuner?',
    '',
    bestVsAc14
      ? `- Compared to ac14: no-detect ${formatPct(bestVsAc14.noDetectDelta, true)}, lock ${bestVsAc14.lockDeltaMs >= 0 ? '+' : ''}${bestVsAc14.lockDeltaMs.toFixed(1)} ms, octave-error ${formatPct(bestVsAc14.octaveDelta, true)}, median abs cents ${bestVsAc14.centsDelta >= 0 ? '+' : ''}${bestVsAc14.centsDelta.toFixed(2)}c, runtime p95 ${bestVsAc14.runtimeP95DeltaMs >= 0 ? '+' : ''}${bestVsAc14.runtimeP95DeltaMs.toFixed(3)} ms.`
      : '- Comparison unavailable.',
    keepAc14
      ? '- Verdict: best tested pYIN profile does not yet clear ac14 on continuity/lock enough for replacement.'
      : '- Verdict: best tested pYIN profile is a viable ac14 replacement for Tuner.',
    '',
    '## 4) If not yet, what still blocks replacement?',
    '',
    keepAc14
      ? '- Main blocker remains continuity: no-detect and lock speed are still weaker than ac14 under RAW output.'
      : '- No major blocker found in this dataset; confirm on-device and noisy-room conditions before rollout.',
    '',
    '## 5) Main remaining blocker category',
    '',
    keepAc14
      ? '- Combination of no-detect + lock speed (with secondary runtime burden at aggressive cadences).'
      : '- Runtime validation and cross-device stability checks are the remaining risks.',
    '',
    '## Recommendation',
    '',
    `- ${recommendation}`,
    '- Keep lightweight tuner output policy (`hold_last_120ms` with short median window) as an optional display-layer enhancement; report RAW and smoothed separately.',
    '- Optional next step: test experimental hybrid (`pyin` primary + `ac14` fallback when unvoiced) in a separate appendix benchmark.',
    ''
  ].join('\n');

  await fs.writeFile(path.join(input.outputDir, 'summary.md'), `${content}\n`, 'utf8');
}

function buildSingleMetricPlot(
  title: string,
  entries: Array<{ label: string; value: number }>,
  options: { baseline: number; format: (value: number) => string; lowerIsBetter: boolean }
): string {
  const width = 1240;
  const rowHeight = 30;
  const marginTop = 70;
  const marginBottom = 36;
  const labelX = 20;
  const barX = 330;
  const rightPadding = 40;
  const innerWidth = width - barX - rightPadding;
  const height = marginTop + entries.length * rowHeight + marginBottom;
  const maxValue = Math.max(1e-6, options.baseline, ...entries.map((entry) => entry.value));

  const lines = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  lines.push(`<text x="20" y="34" fill="#f8fafc" font-size="22" font-family="Arial, sans-serif">${escapeXml(title)}</text>`);
  lines.push(`<text x="20" y="56" fill="#94a3b8" font-size="12" font-family="Arial, sans-serif">Baseline (ac14): ${escapeXml(options.format(options.baseline))} · ${options.lowerIsBetter ? 'lower is better' : 'higher is better'}</text>`);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const y = marginTop + index * rowHeight;
    const ratio = Math.max(0, entry.value) / maxValue;
    const barWidth = Math.max(0, Math.min(innerWidth, ratio * innerWidth));
    lines.push(`<text x="${labelX}" y="${y + 18}" fill="#cbd5e1" font-size="12" font-family="Arial, sans-serif">${escapeXml(entry.label)}</text>`);
    lines.push(`<rect x="${barX}" y="${y + 6}" width="${innerWidth}" height="12" fill="#1f2937" />`);
    lines.push(`<rect x="${barX}" y="${y + 6}" width="${barWidth.toFixed(2)}" height="12" fill="#a78bfa" />`);
    lines.push(`<text x="${barX + innerWidth + 8}" y="${y + 16}" fill="#e2e8f0" font-size="11" font-family="Arial, sans-serif">${escapeXml(options.format(entry.value))}</text>`);
  }

  const baselineY = marginTop - 8;
  const baselineX = barX + (Math.max(0, options.baseline) / maxValue) * innerWidth;
  lines.push(`<line x1="${baselineX.toFixed(2)}" y1="${baselineY}" x2="${baselineX.toFixed(2)}" y2="${(height - marginBottom + 8).toFixed(2)}" stroke="#f59e0b" stroke-dasharray="4 4" />`);
  lines.push('</svg>');
  return lines.join('\n');
}

function buildDualMetricPlot(
  title: string,
  entries: Array<{ label: string; first: number; second: number }>,
  options: { firstLabel: string; secondLabel: string; format: (value: number) => string }
): string {
  const width = 1260;
  const rowHeight = 36;
  const marginTop = 78;
  const marginBottom = 40;
  const labelX = 20;
  const barX = 360;
  const rightPadding = 44;
  const innerWidth = width - barX - rightPadding;
  const height = marginTop + entries.length * rowHeight + marginBottom;
  const maxValue = Math.max(1e-6, ...entries.flatMap((entry) => [entry.first, entry.second]));

  const lines = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  lines.push(`<text x="20" y="34" fill="#f8fafc" font-size="22" font-family="Arial, sans-serif">${escapeXml(title)}</text>`);
  lines.push(`<text x="20" y="58" fill="#94a3b8" font-size="12" font-family="Arial, sans-serif">${escapeXml(options.firstLabel)}=#60a5fa · ${escapeXml(options.secondLabel)}=#f472b6</text>`);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const y = marginTop + index * rowHeight;
    const w1 = (Math.max(0, entry.first) / maxValue) * innerWidth;
    const w2 = (Math.max(0, entry.second) / maxValue) * innerWidth;
    lines.push(`<text x="${labelX}" y="${y + 20}" fill="#cbd5e1" font-size="12" font-family="Arial, sans-serif">${escapeXml(entry.label)}</text>`);
    lines.push(`<rect x="${barX}" y="${y + 6}" width="${innerWidth}" height="9" fill="#1f2937" />`);
    lines.push(`<rect x="${barX}" y="${y + 20}" width="${innerWidth}" height="9" fill="#1f2937" />`);
    lines.push(`<rect x="${barX}" y="${y + 6}" width="${w1.toFixed(2)}" height="9" fill="#60a5fa" />`);
    lines.push(`<rect x="${barX}" y="${y + 20}" width="${w2.toFixed(2)}" height="9" fill="#f472b6" />`);
    lines.push(`<text x="${barX + innerWidth + 8}" y="${y + 14}" fill="#dbeafe" font-size="11" font-family="Arial, sans-serif">${escapeXml(options.format(entry.first))}</text>`);
    lines.push(`<text x="${barX + innerWidth + 8}" y="${y + 28}" fill="#fce7f3" font-size="11" font-family="Arial, sans-serif">${escapeXml(options.format(entry.second))}</text>`);
  }

  lines.push('</svg>');
  return lines.join('\n');
}

function buildTradeoffScatterPlot(
  title: string,
  points: Array<{ label: string; x: number; y: number; color: string }>,
  options: { xLabel: string; yLabel: string }
): string {
  const width = 980;
  const height = 620;
  const margin = { left: 90, right: 40, top: 70, bottom: 90 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const xMax = Math.max(0.0001, ...points.map((point) => point.x)) * 1.1;
  const yMax = Math.max(0.0001, ...points.map((point) => point.y)) * 1.1;
  const x = linearScale(0, xMax, margin.left, margin.left + innerWidth);
  const y = linearScale(0, yMax, margin.top + innerHeight, margin.top);

  const lines = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  lines.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="22" font-family="Arial, sans-serif">${escapeXml(title)}</text>`);
  lines.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#334155" />`);
  lines.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#334155" />`);
  lines.push(`<text x="${width / 2}" y="${height - 24}" text-anchor="middle" fill="#94a3b8" font-size="12" font-family="Arial, sans-serif">${escapeXml(options.xLabel)}</text>`);
  lines.push(`<text x="18" y="${height / 2}" transform="rotate(-90 18 ${height / 2})" text-anchor="middle" fill="#94a3b8" font-size="12" font-family="Arial, sans-serif">${escapeXml(options.yLabel)}</text>`);

  for (const point of points) {
    const px = x(point.x);
    const py = y(point.y);
    lines.push(`<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="5" fill="${point.color}" />`);
    lines.push(`<text x="${(px + 8).toFixed(2)}" y="${(py - 6).toFixed(2)}" fill="#e2e8f0" font-size="11" font-family="Arial, sans-serif">${escapeXml(point.label)}</text>`);
  }

  lines.push('</svg>');
  return lines.join('\n');
}

function colorByIndex(index: number): string {
  const palette = ['#60a5fa', '#f472b6', '#34d399', '#f59e0b', '#a78bfa', '#22d3ee', '#f87171', '#84cc16', '#c084fc'];
  return palette[index % palette.length];
}

function averageOrNull(values: number[]): number | null {
  if (values.length <= 0) return null;
  return average(values);
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function hzToMidi(hz: number): number {
  return 69 + (12 * Math.log2(hz / 440));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

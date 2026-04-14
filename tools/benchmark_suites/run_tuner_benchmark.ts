#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { FeatureExtractionService } from '../../src/audio/FeatureExtractionService';
import { PitchDetectorPreset } from '../../src/audio/dsp-core/gh_dsp_core.js';
import { midiForStringFret } from '../../src/guitar/tuning';
import {
  DATASET_ROOT,
  WINDOWS_DATASET_ROOT,
  FRAME_SIZE,
  HOP_SIZE,
  DspCoreDetector,
  average,
  bandScale,
  buildDatasetRows,
  buildFrameStartsFullCoverage,
  buildLegend,
  buildRejectReason,
  centsBetweenFrequencies,
  colorForAlgorithm,
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
  readFrame,
  resolvePyinCliPath,
  roundNullable,
  roundNumber,
  runPyinTraceForFile,
  sanitizeFileSegment,
  standardDeviation,
  stringGroup,
  svgHeader
} from './shared';

type AlgorithmName = 'ac14' | 'pyin';

type FrameObservation = {
  timestampSec: number;
  accepted: boolean;
  pitchHz: number | null;
  midi: number | null;
  confidence: number;
  runtimeMs: number;
  rejectReason: string | null;
};

type FileAlgorithmRow = {
  algorithm: AlgorithmName;
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
};

type AggregateRow = {
  algorithm: AlgorithmName;
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

const OUTPUT_ROOT = 'analysis/tuner_benchmark';
const ALGORITHMS: AlgorithmName[] = ['ac14', 'pyin'];
const PYIN_MAX_FRAMES_PER_FILE = 48;
const LOCK_TOLERANCE_CENTS = 20;
const LOCK_CONSECUTIVE_FRAMES = 3;

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const datasetDir = path.resolve(repoRoot, DATASET_ROOT);
  const outputDir = path.resolve(repoRoot, OUTPUT_ROOT);
  const plotsDir = path.join(outputDir, 'plots');
  const pyinCacheDir = path.join(outputDir, '.pyin_cache');
  await fs.mkdir(plotsDir, { recursive: true });
  await fs.mkdir(pyinCacheDir, { recursive: true });

  const datasetRows = await buildDatasetRows(datasetDir);
  if (datasetRows.length <= 0) {
    throw new Error(`No WAV files found under ${datasetDir}`);
  }

  const pyinCliPath = await resolvePyinCliPath(repoRoot);
  const ac14Detector = new DspCoreDetector('ac14', PitchDetectorPreset.Ac14);
  await ac14Detector.init();

  const fileRows: FileAlgorithmRow[] = [];

  try {
    for (let index = 0; index < datasetRows.length; index += 1) {
      const row = datasetRows[index];
      console.log(`[tuner] ${index + 1}/${datasetRows.length} ${row.relativeFilePath}`);
      const decoded = await decodeMonoAudio(row.filePath);
      const targetMidi = midiForStringFret(row.stringId, row.fret);
      const targetHz = 440 * Math.pow(2, (targetMidi - 69) / 12);
      const durationSec = decoded.samples.length / decoded.sampleRate;

      const ac14Frames = evaluateAc14Frames(ac14Detector, decoded.samples, decoded.sampleRate, durationSec);
      fileRows.push(summarizeFileRow('ac14', row, durationSec, targetHz, ac14Frames));

      const pyinTrace = await runPyinTraceForFile({
        filePath: row.filePath,
        fileId: row.fileId,
        cliPath: pyinCliPath,
        outputDir: pyinCacheDir
      });
      const pyinFrames = buildPyinFrames(pyinTrace, durationSec);
      fileRows.push(summarizeFileRow('pyin', row, durationSec, targetHz, pyinFrames));
    }
  } finally {
    ac14Detector.dispose?.();
  }

  const aggregates = Object.fromEntries(
    ALGORITHMS.map((algorithm) => [algorithm, aggregateRows(fileRows.filter((row) => row.algorithm === algorithm))])
  ) as Record<AlgorithmName, AggregateRow>;

  const aggregatesByStringBand = Object.fromEntries(
    ALGORITHMS.map((algorithm) => [
      algorithm,
      {
        low: aggregateRows(fileRows.filter((row) => row.algorithm === algorithm && row.stringBand === 'low')),
        high: aggregateRows(fileRows.filter((row) => row.algorithm === algorithm && row.stringBand === 'high'))
      }
    ])
  ) as Record<AlgorithmName, { low: AggregateRow; high: AggregateRow }>;

  await writeResults(outputDir, fileRows, aggregates, aggregatesByStringBand);
  await writePlots(plotsDir, fileRows, aggregates, aggregatesByStringBand);
  await writeSummary(outputDir, datasetRows.length, aggregates, aggregatesByStringBand);

  console.log(`Outputs: ${OUTPUT_ROOT}`);
  console.log(`Algorithms: ${ALGORITHMS.join(', ')}`);
  console.log(`Files analyzed: ${datasetRows.length}`);
}

function evaluateAc14Frames(
  detector: DspCoreDetector,
  samples: Float32Array,
  sampleRate: number,
  durationSec: number
): FrameObservation[] {
  detector.reset();
  const featureService = new FeatureExtractionService(FRAME_SIZE);
  const starts = buildFrameStartsFullCoverage(samples.length, FRAME_SIZE, HOP_SIZE);
  const out: FrameObservation[] = [];
  for (let frameIndex = 0; frameIndex < starts.length; frameIndex += 1) {
    const start = starts[frameIndex];
    const frame = readFrame(samples, start, FRAME_SIZE);
    const features = featureService.extractFeatures(frame, sampleRate, null, null);
    const context = {
      timestampMs: (start / sampleRate) * 1000,
      frameIndex,
      sampleRate,
      rawFrame: frame,
      processedFrame: frame,
      analysisWindowId: frameIndex,
      optionalFeatures: features
    };
    const startedAt = performance.now();
    const result = detector.processFrame(context);
    const runtimeMs = performance.now() - startedAt;
    out.push({
      timestampSec: (start / sampleRate),
      accepted: result.accepted && finiteNumber(result.pitchHz) !== null,
      pitchHz: finiteNumber(result.pitchHz),
      midi: finiteNumber(result.midi),
      confidence: finiteNumber(result.confidence) ?? 0,
      runtimeMs,
      rejectReason: result.rejectReason ?? (result.accepted ? null : buildRejectReason(features.metrics.rmsDbfs))
    });
  }

  if (out.length <= 0) {
    out.push({
      timestampSec: Math.max(0, durationSec * 0.5),
      accepted: false,
      pitchHz: null,
      midi: null,
      confidence: 0,
      runtimeMs: 0,
      rejectReason: 'no_frames'
    });
  }
  return out;
}

function buildPyinFrames(trace: Awaited<ReturnType<typeof runPyinTraceForFile>>, durationSec: number): FrameObservation[] {
  const selected = sampleEvenly(trace.frames, PYIN_MAX_FRAMES_PER_FILE);
  if (selected.length <= 0) {
    return [{
      timestampSec: Math.max(0, durationSec * 0.5),
      accepted: false,
      pitchHz: null,
      midi: null,
      confidence: 0,
      runtimeMs: trace.runDurationMs,
      rejectReason: 'pyin_no_event'
    }];
  }
  const perFrameRuntimeMs = trace.runDurationMs / Math.max(1, selected.length);
  return selected.map((frame) => ({
    timestampSec: frame.captureTimeSec,
    accepted: frame.pitchHz !== null && frame.midiEstimate !== null,
    pitchHz: frame.pitchHz,
    midi: frame.midiEstimate,
    confidence: frame.confidence ?? 0,
    runtimeMs: perFrameRuntimeMs,
    rejectReason: frame.pitchHz !== null && frame.midiEstimate !== null ? null : (frame.reason ?? 'pyin_unvoiced')
  }));
}

function summarizeFileRow(
  algorithm: AlgorithmName,
  row: { fileId: string; relativeFilePath: string; stringId: number; fret: number; take: number },
  durationSec: number,
  targetHz: number,
  frames: FrameObservation[]
): FileAlgorithmRow {
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

  return {
    algorithm,
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
    runtimeP95Ms: roundNullable(percentile(runtimeSamples, 0.95), 6) ?? 0
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

function aggregateRows(rows: FileAlgorithmRow[]): AggregateRow {
  const totalFrames = rows.reduce((sum, row) => sum + row.totalFrames, 0);
  const detectedFrames = rows.reduce((sum, row) => sum + row.detectedFrames, 0);
  const accurate10Frames = rows.reduce((sum, row) => sum + row.accurate10Frames, 0);
  const accurate20Frames = rows.reduce((sum, row) => sum + row.accurate20Frames, 0);
  const accurate50Frames = rows.reduce((sum, row) => sum + row.accurate50Frames, 0);
  const noDetectionFrames = rows.reduce((sum, row) => sum + row.noDetectionFrames, 0);
  const octaveErrorFrames = rows.reduce((sum, row) => sum + row.octaveErrorFrames, 0);

  const runtimeSamples = rows.map((row) => row.runtimeAvgMs);

  return {
    algorithm: rows[0]?.algorithm ?? 'ac14',
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
    runtimeP95Ms: roundNullable(percentile(rows.map((row) => row.runtimeP95Ms), 0.95), 6) ?? 0
  };
}

async function writeResults(
  outputDir: string,
  fileRows: FileAlgorithmRow[],
  aggregates: Record<AlgorithmName, AggregateRow>,
  aggregatesByStringBand: Record<AlgorithmName, { low: AggregateRow; high: AggregateRow }>
): Promise<void> {
  const doc = {
    generatedAtIso: new Date().toISOString(),
    suite: 'tuner',
    datasetPath: DATASET_ROOT,
    datasetPathWindows: WINDOWS_DATASET_ROOT,
    rawOnly: true,
    algorithms: ALGORITHMS,
    frameConfig: {
      frameSize: FRAME_SIZE,
      hopSize: HOP_SIZE,
      lockToleranceCents: LOCK_TOLERANCE_CENTS,
      lockConsecutiveFrames: LOCK_CONSECUTIVE_FRAMES
    },
    notes: [
      'This suite approximates continuous tuner behavior using frame-level analysis on isolated takes.',
      'pYIN runtime is measured as end-to-end CLI processing time divided by emitted frames (coarse offline estimate).'
    ],
    aggregates,
    aggregatesByStringBand,
    rows: fileRows
  };
  await fs.writeFile(path.join(outputDir, 'results.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'results.csv'), `${buildCsv(fileRows)}\n`, 'utf8');
}

function buildCsv(rows: FileAlgorithmRow[]): string {
  const header = [
    'algorithm',
    'file_id',
    'relative_file_path',
    'string',
    'fret',
    'take',
    'string_band',
    'duration_sec',
    'total_frames',
    'detected_frames',
    'no_detection_frames',
    'accurate_10_frames',
    'accurate_20_frames',
    'accurate_50_frames',
    'octave_error_frames',
    'median_abs_cents_error',
    'median_signed_cents_error',
    'jitter_median_abs_delta_cents',
    'time_to_lock_ms',
    'sustain_std_cents',
    'sustain_median_abs_cents',
    'runtime_avg_ms',
    'runtime_p95_ms'
  ];
  const out = [header.join(',')];
  for (const row of rows) {
    out.push([
      row.algorithm,
      row.fileId,
      row.relativeFilePath,
      row.stringId,
      row.fret,
      row.take,
      row.stringBand,
      row.durationSec,
      row.totalFrames,
      row.detectedFrames,
      row.noDetectionFrames,
      row.accurate10Frames,
      row.accurate20Frames,
      row.accurate50Frames,
      row.octaveErrorFrames,
      row.medianAbsCentsError,
      row.medianSignedCentsError,
      row.jitterMedianAbsDeltaCents,
      row.timeToLockMs,
      row.sustainStdCents,
      row.sustainMedianAbsCents,
      row.runtimeAvgMs,
      row.runtimeP95Ms
    ].map((value) => csvEscape(formatCsvValue(value))).join(','));
  }
  return out.join('\n');
}

async function writePlots(
  plotsDir: string,
  fileRows: FileAlgorithmRow[],
  aggregates: Record<AlgorithmName, AggregateRow>,
  aggregatesByStringBand: Record<AlgorithmName, { low: AggregateRow; high: AggregateRow }>
): Promise<void> {
  await fs.writeFile(path.join(plotsDir, 'pitch_accuracy_by_algorithm.svg'), buildAccuracyPlot(aggregates), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'cents_error_distribution.svg'), buildCentsDistributionPlot(aggregates), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'jitter_and_sustain_stability.svg'), buildJitterStabilityPlot(aggregates), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'low_vs_high_string_performance.svg'), buildLowHighPlot(aggregatesByStringBand), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'time_to_lock.svg'), buildTimeToLockPlot(aggregates), 'utf8');

  for (const algorithm of ALGORITHMS) {
    const rows = fileRows.filter((row) => row.algorithm === algorithm);
    await fs.writeFile(
      path.join(plotsDir, `lock_by_string_${sanitizeFileSegment(algorithm)}.svg`),
      buildLockByStringPlot(rows, algorithm),
      'utf8'
    );
  }
}

function buildAccuracyPlot(aggregates: Record<AlgorithmName, AggregateRow>): string {
  const width = 980;
  const height = 560;
  const margin = { left: 80, right: 28, top: 58, bottom: 88 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const groupScale = bandScale(ALGORITHMS, margin.left, margin.left + innerWidth, 0.25);
  const subScale = bandScale(['±10c', '±20c', '±50c'], 0, groupScale.bandWidth, 0.15);
  const y = linearScale(0, 1, margin.top + innerHeight, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Tuner Accuracy by Tolerance (RAW)</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#475569" />`);

  for (const algorithm of ALGORITHMS) {
    const agg = aggregates[algorithm];
    const x0 = groupScale.positionForValue(algorithm) ?? margin.left;
    const values = [
      { label: '±10c', value: agg.pitchAccuracy10Cents },
      { label: '±20c', value: agg.pitchAccuracy20Cents },
      { label: '±50c', value: agg.pitchAccuracy50Cents }
    ];
    values.forEach((entry) => {
      const sx = subScale.positionForValue(entry.label) ?? 0;
      const top = y(entry.value);
      const h = margin.top + innerHeight - top;
      elements.push(`<rect x="${(x0 + sx).toFixed(2)}" y="${top.toFixed(2)}" width="${(subScale.bandWidth - 2).toFixed(2)}" height="${h.toFixed(2)}" fill="${colorForAlgorithm(algorithm)}" fill-opacity="0.85" />`);
      elements.push(`<text x="${(x0 + sx + subScale.bandWidth / 2).toFixed(2)}" y="${(top - 6).toFixed(2)}" fill="#cbd5e1" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${formatPct(entry.value)}</text>`);
    });
    elements.push(`<text x="${(x0 + groupScale.bandWidth / 2).toFixed(2)}" y="${height - 24}" fill="#94a3b8" font-size="12" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(algorithm)}</text>`);
  }

  elements.push(...buildLegend([
    { label: '±10c', color: '#93c5fd' },
    { label: '±20c', color: '#60a5fa' },
    { label: '±50c', color: '#2563eb' }
  ], width - 210, 88));

  elements.push('</svg>');
  return elements.join('\n');
}

function buildCentsDistributionPlot(aggregates: Record<AlgorithmName, AggregateRow>): string {
  return buildSimpleMetricBarPlot(
    'Median Absolute Cents Error (Detected Frames)',
    ALGORITHMS.map((algorithm) => ({ label: algorithm, value: aggregates[algorithm].medianAbsCentsError ?? 0, color: colorForAlgorithm(algorithm), text: formatNullable(aggregates[algorithm].medianAbsCentsError, 1, 'c') })),
    false,
    'c'
  );
}

function buildJitterStabilityPlot(aggregates: Record<AlgorithmName, AggregateRow>): string {
  const width = 980;
  const height = 560;
  const margin = { left: 80, right: 28, top: 58, bottom: 88 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const groupScale = bandScale(ALGORITHMS, margin.left, margin.left + innerWidth, 0.3);
  const subScale = bandScale(['jitter', 'sustain_std'], 0, groupScale.bandWidth, 0.2);
  const values = ALGORITHMS.flatMap((algorithm) => [
    aggregates[algorithm].medianJitterAbsDeltaCents ?? 0,
    aggregates[algorithm].medianSustainStdCents ?? 0
  ]);
  const maxValue = Math.max(1, ...values);
  const y = linearScale(0, maxValue * 1.2, margin.top + innerHeight, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Jitter and Sustain Stability (Lower Is Better)</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#475569" />`);

  for (const algorithm of ALGORITHMS) {
    const x0 = groupScale.positionForValue(algorithm) ?? margin.left;
    const items = [
      { key: 'jitter', value: aggregates[algorithm].medianJitterAbsDeltaCents ?? 0, color: colorForAlgorithm(algorithm) },
      { key: 'sustain_std', value: aggregates[algorithm].medianSustainStdCents ?? 0, color: '#fbbf24' }
    ];
    for (const item of items) {
      const sx = subScale.positionForValue(item.key) ?? 0;
      const top = y(item.value);
      const h = margin.top + innerHeight - top;
      elements.push(`<rect x="${(x0 + sx).toFixed(2)}" y="${top.toFixed(2)}" width="${(subScale.bandWidth - 2).toFixed(2)}" height="${h.toFixed(2)}" fill="${item.color}" fill-opacity="0.88" />`);
      elements.push(`<text x="${(x0 + sx + subScale.bandWidth / 2).toFixed(2)}" y="${(top - 6).toFixed(2)}" fill="#cbd5e1" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${item.value.toFixed(1)}c</text>`);
    }
    elements.push(`<text x="${(x0 + groupScale.bandWidth / 2).toFixed(2)}" y="${height - 24}" fill="#94a3b8" font-size="12" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(algorithm)}</text>`);
  }

  elements.push(...buildLegend([
    { label: 'Median jitter Δc', color: '#60a5fa' },
    { label: 'Sustain std c', color: '#fbbf24' }
  ], width - 200, 88));
  elements.push('</svg>');
  return elements.join('\n');
}

function buildLowHighPlot(aggregatesByStringBand: Record<AlgorithmName, { low: AggregateRow; high: AggregateRow }>): string {
  const width = 980;
  const height = 560;
  const margin = { left: 80, right: 28, top: 58, bottom: 88 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const groupScale = bandScale(ALGORITHMS, margin.left, margin.left + innerWidth, 0.3);
  const subScale = bandScale(['low', 'high'], 0, groupScale.bandWidth, 0.2);
  const y = linearScale(0, 1, margin.top + innerHeight, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Low vs High String Accuracy (±50c)</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#475569" />`);

  for (const algorithm of ALGORITHMS) {
    const x0 = groupScale.positionForValue(algorithm) ?? margin.left;
    const low = aggregatesByStringBand[algorithm].low.pitchAccuracy50Cents;
    const high = aggregatesByStringBand[algorithm].high.pitchAccuracy50Cents;
    const values = [
      { label: 'low', value: low, color: '#22d3ee' },
      { label: 'high', value: high, color: '#f97316' }
    ];
    for (const value of values) {
      const sx = subScale.positionForValue(value.label) ?? 0;
      const top = y(value.value);
      const h = margin.top + innerHeight - top;
      elements.push(`<rect x="${(x0 + sx).toFixed(2)}" y="${top.toFixed(2)}" width="${(subScale.bandWidth - 2).toFixed(2)}" height="${h.toFixed(2)}" fill="${value.color}" fill-opacity="0.88" />`);
      elements.push(`<text x="${(x0 + sx + subScale.bandWidth / 2).toFixed(2)}" y="${(top - 6).toFixed(2)}" fill="#cbd5e1" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${formatPct(value.value)}</text>`);
    }
    elements.push(`<text x="${(x0 + groupScale.bandWidth / 2).toFixed(2)}" y="${height - 24}" fill="#94a3b8" font-size="12" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(algorithm)}</text>`);
  }

  elements.push(...buildLegend([
    { label: 'Low strings (5-6)', color: '#22d3ee' },
    { label: 'High strings (1-2)', color: '#f97316' }
  ], width - 220, 88));
  elements.push('</svg>');
  return elements.join('\n');
}

function buildTimeToLockPlot(aggregates: Record<AlgorithmName, AggregateRow>): string {
  return buildSimpleMetricBarPlot(
    'Median Time-to-Lock (ms, Lower Is Better)',
    ALGORITHMS.map((algorithm) => ({
      label: algorithm,
      value: aggregates[algorithm].medianTimeToLockMs ?? 0,
      color: colorForAlgorithm(algorithm),
      text: formatNullable(aggregates[algorithm].medianTimeToLockMs, 1, 'ms')
    })),
    false,
    'ms'
  );
}

function buildLockByStringPlot(rows: FileAlgorithmRow[], algorithm: AlgorithmName): string {
  const width = 940;
  const height = 460;
  const margin = { left: 80, right: 24, top: 50, bottom: 70 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const byString = new Map<number, number[]>();
  for (const row of rows) {
    const list = byString.get(row.stringId) ?? [];
    if (row.timeToLockMs !== null) list.push(row.timeToLockMs);
    byString.set(row.stringId, list);
  }
  const strings = [...byString.keys()].sort((a, b) => b - a);
  const values = strings.map((stringId) => median(byString.get(stringId) ?? []) ?? 0);
  const maxValue = Math.max(1, ...values);

  const x = bandScale(strings.map((value) => String(value)), margin.left, margin.left + innerWidth, 0.25);
  const y = linearScale(0, maxValue * 1.2, margin.top + innerHeight, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="30" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Time-to-lock by string: ${algorithm}</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#475569" />`);

  for (const stringId of strings) {
    const value = median(byString.get(stringId) ?? []) ?? 0;
    const x0 = x.positionForValue(String(stringId)) ?? margin.left;
    const top = y(value);
    const h = margin.top + innerHeight - top;
    elements.push(`<rect x="${x0.toFixed(2)}" y="${top.toFixed(2)}" width="${(x.bandWidth - 2).toFixed(2)}" height="${h.toFixed(2)}" fill="${colorForAlgorithm(algorithm)}" fill-opacity="0.85" />`);
    elements.push(`<text x="${(x0 + x.bandWidth / 2).toFixed(2)}" y="${(height - 18).toFixed(2)}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">S${stringId}</text>`);
  }

  elements.push('</svg>');
  return elements.join('\n');
}

function buildSimpleMetricBarPlot(
  title: string,
  values: Array<{ label: string; value: number; color: string; text: string }>,
  isPercent: boolean,
  unit: string
): string {
  const width = 920;
  const height = 460;
  const margin = { left: 80, right: 24, top: 50, bottom: 70 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const x = bandScale(values.map((value) => value.label), margin.left, margin.left + innerWidth, 0.3);
  const maxValue = isPercent ? 1 : Math.max(1, ...values.map((value) => value.value));
  const y = linearScale(0, maxValue * 1.15, margin.top + innerHeight, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="30" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">${escapeXml(title)}</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#475569" />`);

  for (const value of values) {
    const x0 = x.positionForValue(value.label) ?? margin.left;
    const top = y(value.value);
    const h = margin.top + innerHeight - top;
    elements.push(`<rect x="${x0.toFixed(2)}" y="${top.toFixed(2)}" width="${(x.bandWidth - 2).toFixed(2)}" height="${h.toFixed(2)}" fill="${value.color}" fill-opacity="0.85" />`);
    elements.push(`<text x="${(x0 + x.bandWidth / 2).toFixed(2)}" y="${(top - 6).toFixed(2)}" fill="#cbd5e1" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(value.text)}</text>`);
    elements.push(`<text x="${(x0 + x.bandWidth / 2).toFixed(2)}" y="${(height - 18).toFixed(2)}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(value.label)}</text>`);
  }

  elements.push(`<text x="${width - 10}" y="${margin.top + 16}" fill="#64748b" font-size="11" text-anchor="end" font-family="Arial, sans-serif">${escapeXml(unit)}</text>`);
  elements.push('</svg>');
  return elements.join('\n');
}

async function writeSummary(
  outputDir: string,
  datasetFileCount: number,
  aggregates: Record<AlgorithmName, AggregateRow>,
  aggregatesByStringBand: Record<AlgorithmName, { low: AggregateRow; high: AggregateRow }>
): Promise<void> {
  const ac14 = aggregates.ac14;
  const pyin = aggregates.pyin;

  const qualityBetter =
    pyin.pitchAccuracy50Cents > ac14.pitchAccuracy50Cents &&
    (pyin.medianAbsCentsError ?? Number.POSITIVE_INFINITY) <= (ac14.medianAbsCentsError ?? Number.POSITIVE_INFINITY) &&
    (pyin.medianJitterAbsDeltaCents ?? Number.POSITIVE_INFINITY) <= (ac14.medianJitterAbsDeltaCents ?? Number.POSITIVE_INFINITY);

  const runtimeFeasible = pyin.runtimeP95Ms <= 20;

  const summary = [
    '# Tuner Benchmark Suite',
    '',
    '## Scope',
    '',
    '- Task: monophonic continuous pitch tracking for tuner behavior.',
    '- Algorithms: `ac14`, `pyin`.',
    '- Input policy: RAW only (no HPF/LPF headline variants).',
    '- Dataset path: `' + WINDOWS_DATASET_ROOT + '`.',
    `- WAV files analyzed: ${datasetFileCount}.`,
    '- Approximation note: this is an offline take-based approximation of live continuous tuning using frame-level tracking over each take.',
    '',
    '## Main Metrics',
    '',
    '| Algorithm | ±10c | ±20c | ±50c | Median Abs Cents | No-Detect | Octave Error | Jitter Δc | Time-to-lock | Sustain Std (c) | Runtime avg / p95 (ms) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...ALGORITHMS.map((algorithm) => {
      const agg = aggregates[algorithm];
      return `| ${algorithm} | ${formatPct(agg.pitchAccuracy10Cents)} | ${formatPct(agg.pitchAccuracy20Cents)} | ${formatPct(agg.pitchAccuracy50Cents)} | ${formatNullable(agg.medianAbsCentsError, 2, 'c')} | ${formatPct(agg.noDetectionRate)} | ${formatPct(agg.octaveErrorRate)} | ${formatNullable(agg.medianJitterAbsDeltaCents, 2, 'c')} | ${formatNullable(agg.medianTimeToLockMs, 1, ' ms')} | ${formatNullable(agg.medianSustainStdCents, 2, 'c')} | ${agg.runtimeAvgMs.toFixed(3)} / ${agg.runtimeP95Ms.toFixed(3)} |`;
    }),
    '',
    '## Low vs High Strings (±50c)',
    '',
    '| Algorithm | Low strings (5-6) | High strings (1-2) |',
    '| --- | ---: | ---: |',
    ...ALGORITHMS.map((algorithm) =>
      `| ${algorithm} | ${formatPct(aggregatesByStringBand[algorithm].low.pitchAccuracy50Cents)} | ${formatPct(aggregatesByStringBand[algorithm].high.pitchAccuracy50Cents)} |`
    ),
    '',
    '## Candidate Assessment',
    '',
    `- Quality verdict vs current tuner baseline (` + '`ac14`' + `): ${qualityBetter ? '`pyin` looks quality-competitive or better on this dataset.' : '`pyin` is not yet a clear quality replacement for `ac14` on this dataset.'}`,
    `- Runtime feasibility verdict: ${runtimeFeasible ? '`pyin` appears runtime-feasible for low-latency tuner integration under this offline benchmark.' : '`pyin` needs runtime optimization/validation before claiming low-latency tuner feasibility.'}`,
    `- Separation note: this suite only answers tuner questions and must not be merged into cross-task detector rankings.`,
    '',
    '## Output Files',
    '',
    '- `results.json`',
    '- `results.csv`',
    '- `summary.md`',
    '- `plots/`',
    ''
  ].join('\n');

  await fs.writeFile(path.join(outputDir, 'summary.md'), summary, 'utf8');
}

function sampleEvenly<T>(values: T[], limit: number): T[] {
  if (values.length <= limit) return values;
  if (limit <= 0) return [];
  const out: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const ratio = limit === 1 ? 0.5 : index / (limit - 1);
    const selectedIndex = Math.min(values.length - 1, Math.round(ratio * (values.length - 1)));
    out.push(values[selectedIndex]);
  }
  return out;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

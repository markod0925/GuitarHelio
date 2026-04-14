#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildFftPlan,
  computeMagnitudeSpectrum,
  computePeak,
  computeRms,
  computeTopSpectralPeaks,
  fillWindowKernel
} from '../../src/audio/debugSignalProcessing';
import { FeatureExtractionService } from '../../src/audio/FeatureExtractionService';
import { PitchDetectorPreset } from '../../src/audio/dsp-core/gh_dsp_core.js';
import { buildPracticeSpectralRuntimeModel } from '../../src/audio/spectralRuntimeModel';
import { midiForStringFret } from '../../src/guitar/tuning';
import { midiToNoteName } from '../../src/ui/song-select/utils/songSelectUtils';
import {
  DATASET_ROOT,
  WINDOWS_DATASET_ROOT,
  FRAME_SIZE,
  DspCoreDetector,
  average,
  bandScale,
  buildDatasetRows,
  buildEvenlySpacedFrameStarts,
  buildLegend,
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
  mostCommon,
  mostCommonNumber,
  percentile,
  readFrame,
  roundNullable,
  roundNumber,
  sanitizeFileSegment,
  standardDeviation,
  stringGroup,
  svgHeader
} from './shared';

type AlgorithmName = 'spectral_game_runtime_unified_v3' | 'FRETNET';

type TimeWindowSpec = {
  id: 'full_take' | 'center_window' | 'sustain_window' | 'onset_skipped_window';
  label: string;
  kind: 'full' | 'center' | 'sustain' | 'offset';
  durationSec: number | null;
  startOffsetSec: number;
  targetFrames: number;
};

type SegmentFeature = {
  rms: number;
  fundTo2HarmRatioDb: number;
  lowToMidRatio: number;
};

type DiagnosticRow = {
  fileId: string;
  relativeFilePath: string;
  stringId: number;
  fret: number;
  take: number;
  stringBand: 'low' | 'mid' | 'high';
  algorithm: AlgorithmName;
  timeWindow: TimeWindowSpec['id'];
  windowStartSec: number;
  windowEndSec: number;
  sampleRate: number;
  durationSec: number;
  groundTruthMidi: number;
  groundTruthNote: string;
  groundTruthHz: number;
  predictedMidi: number | null;
  predictedNote: string | null;
  predictedHz: number | null;
  predictedString: number | null;
  predictedFret: number | null;
  confidence: number | null;
  acceptedFrameCount: number;
  totalFrameCount: number;
  noDetection: boolean;
  noteCorrect: boolean;
  pitchAccurate50: boolean;
  stringCorrect: boolean | null;
  fretCorrect: boolean | null;
  octaveError: boolean;
  harmonicError: boolean;
  errorType: 'correct' | 'no_detection' | 'octave_error' | 'harmonic_error' | 'near_miss' | 'large_error';
  centsError: number | null;
  absCentsError: number | null;
  runtimeAvgMs: number;
  runtimeP95Ms: number;
  fullRms: number;
  fullFundTo2HarmRatioDb: number;
  fullLowToMidRatio: number;
};

type AggregateMetrics = {
  algorithm: AlgorithmName;
  count: number;
  noteAccuracy: number;
  pitchAccuracy50Cents: number;
  stringAccuracy: number | null;
  fretAccuracy: number | null;
  noDetectionRate: number;
  octaveErrorRate: number;
  harmonicErrorRate: number;
  medianAbsCentsError: number | null;
  medianSignedCentsError: number | null;
  runtimeAvgMs: number;
  runtimeP95Ms: number;
};

type TakeConsistencyRow = {
  algorithm: AlgorithmName;
  stringId: number;
  fret: number;
  takeCount: number;
  noteAccuracy: number;
  stdCentsError: number | null;
  noDetectionCount: number;
  unstableScore: number;
};

const OUTPUT_ROOT = 'analysis/practice_benchmark';
const ALGORITHMS: AlgorithmName[] = ['spectral_game_runtime_unified_v3', 'FRETNET'];

const TIME_WINDOWS: TimeWindowSpec[] = [
  { id: 'full_take', label: 'Full take', kind: 'full', durationSec: null, startOffsetSec: 0, targetFrames: 18 },
  { id: 'center_window', label: 'Center 450 ms', kind: 'center', durationSec: 0.45, startOffsetSec: 0, targetFrames: 8 },
  { id: 'sustain_window', label: 'Sustain 750 ms', kind: 'sustain', durationSec: 0.75, startOffsetSec: 0, targetFrames: 12 },
  { id: 'onset_skipped_window', label: 'Onset skipped', kind: 'offset', durationSec: 0.55, startOffsetSec: 0.2, targetFrames: 9 }
];

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const datasetDir = path.resolve(repoRoot, DATASET_ROOT);
  const outputDir = path.resolve(repoRoot, OUTPUT_ROOT);
  const plotsDir = path.join(outputDir, 'plots');
  await fs.mkdir(plotsDir, { recursive: true });

  const datasetRows = await buildDatasetRows(datasetDir);
  if (datasetRows.length <= 0) {
    throw new Error(`No WAV files found under ${datasetDir}`);
  }

  const spectralModelJson = JSON.stringify(buildPracticeSpectralRuntimeModel(12));
  const detectors = [
    new DspCoreDetector('spectral_game_runtime_unified_v3', PitchDetectorPreset.SpectralGameRuntimeUnifiedV3, spectralModelJson),
    new DspCoreDetector('FRETNET', PitchDetectorPreset.Fretnet, spectralModelJson)
  ];

  for (const detector of detectors) {
    await detector.init();
  }

  const rows: DiagnosticRow[] = [];

  try {
    for (let index = 0; index < datasetRows.length; index += 1) {
      const row = datasetRows[index];
      console.log(`[practice] ${index + 1}/${datasetRows.length} ${row.relativeFilePath}`);
      const decoded = await decodeMonoAudio(row.filePath);
      const groundTruthMidi = midiForStringFret(row.stringId, row.fret);
      const groundTruthHz = 440 * Math.pow(2, (groundTruthMidi - 69) / 12);
      const fullFeature = computeSegmentFeature(decoded.samples, decoded.sampleRate, groundTruthHz);

      for (const windowSpec of TIME_WINDOWS) {
        const bounds = resolveWindowBounds(decoded.samples.length, decoded.sampleRate, windowSpec);
        const segment = decoded.samples.slice(bounds.startSample, bounds.endSample);
        const starts = buildEvenlySpacedFrameStarts(segment.length, windowSpec.targetFrames, FRAME_SIZE);

        for (const detector of detectors) {
          detector.reset();
          const featureService = new FeatureExtractionService(FRAME_SIZE);
          const frameResults: Array<{ result: ReturnType<typeof detector.processFrame>; runtimeMs: number }> = [];

          for (let frameIndex = 0; frameIndex < starts.length; frameIndex += 1) {
            const start = starts[frameIndex];
            const frame = readFrame(segment, start, FRAME_SIZE);
            const features = featureService.extractFeatures(frame, decoded.sampleRate, null, null);
            const context = {
              timestampMs: ((bounds.startSample + start) / decoded.sampleRate) * 1000,
              frameIndex,
              sampleRate: decoded.sampleRate,
              rawFrame: frame,
              processedFrame: frame,
              analysisWindowId: frameIndex,
              optionalFeatures: features
            };
            const startedAt = performance.now();
            const result = detector.processFrame(context);
            const runtimeMs = performance.now() - startedAt;
            frameResults.push({ result, runtimeMs });
          }

          rows.push(summarizeRow({
            row,
            algorithm: detector.name as AlgorithmName,
            windowSpec,
            bounds,
            sampleRate: decoded.sampleRate,
            durationSec: decoded.samples.length / decoded.sampleRate,
            groundTruthMidi,
            groundTruthHz,
            frameResults,
            fullFeature
          }));
        }
      }
    }
  } finally {
    detectors.forEach((detector) => detector.dispose?.());
  }

  const fullRows = rows.filter((row) => row.timeWindow === 'full_take');
  const aggregates = Object.fromEntries(ALGORITHMS.map((algorithm) => [algorithm, aggregate(fullRows.filter((row) => row.algorithm === algorithm))])) as Record<AlgorithmName, AggregateMetrics>;
  const lowMidHigh = Object.fromEntries(ALGORITHMS.map((algorithm) => [
    algorithm,
    {
      low: aggregate(fullRows.filter((row) => row.algorithm === algorithm && row.stringBand === 'low')),
      mid: aggregate(fullRows.filter((row) => row.algorithm === algorithm && row.stringBand === 'mid')),
      high: aggregate(fullRows.filter((row) => row.algorithm === algorithm && row.stringBand === 'high'))
    }
  ])) as Record<AlgorithmName, { low: AggregateMetrics; mid: AggregateMetrics; high: AggregateMetrics }>;

  const takeConsistencyRows = buildTakeConsistencyRows(fullRows);

  await writeResults(outputDir, rows, aggregates, lowMidHigh, takeConsistencyRows);
  await writePlots(plotsDir, rows, aggregates, lowMidHigh, takeConsistencyRows);
  await writeSummary(outputDir, datasetRows.length, rows, aggregates, lowMidHigh, takeConsistencyRows);

  console.log(`Outputs: ${OUTPUT_ROOT}`);
}

function summarizeRow(input: {
  row: { fileId: string; relativeFilePath: string; stringId: number; fret: number; take: number };
  algorithm: AlgorithmName;
  windowSpec: TimeWindowSpec;
  bounds: { startSample: number; endSample: number };
  sampleRate: number;
  durationSec: number;
  groundTruthMidi: number;
  groundTruthHz: number;
  frameResults: Array<{ result: { accepted: boolean; pitchHz?: number; midi?: number; confidence?: number; stringId?: number | null; fret?: number | null }; runtimeMs: number }>;
  fullFeature: SegmentFeature;
}): DiagnosticRow {
  const accepted = input.frameResults
    .map((entry) => entry.result)
    .filter((result) => result.accepted && finiteNumber(result.pitchHz) !== null);
  const predictedHz = median(accepted.map((result) => finiteNumber(result.pitchHz)!).filter((value): value is number => value !== null));
  const predictedMidi = median(accepted.map((result) => finiteNumber(result.midi)).filter((value): value is number => value !== null));
  const predictedString = mostCommonNumber(accepted.map((result) => result.stringId ?? null));
  const predictedFret = mostCommonNumber(accepted.map((result) => result.fret ?? null));
  const confidence = median(accepted.map((result) => finiteNumber(result.confidence)).filter((value): value is number => value !== null));

  const centsError = predictedHz === null ? null : centsBetweenFrequencies(predictedHz, input.groundTruthHz);
  const absCentsError = centsError === null ? null : Math.abs(centsError);

  const noteCorrect = predictedMidi !== null && Math.round(predictedMidi) === input.groundTruthMidi;
  const pitchAccurate50 = absCentsError !== null && absCentsError <= 50;
  const stringCorrect = predictedString === null ? null : predictedString === input.row.stringId;
  const fretCorrect = predictedFret === null ? null : predictedFret === input.row.fret;

  const octaveError = absCentsError !== null && Math.abs(absCentsError - 1200) <= 120;
  const harmonicError = centsError !== null && [1902, -1902, 2400, -2400, 2786, -2786].some((target) => Math.abs(centsError - target) <= 140);

  const errorType: DiagnosticRow['errorType'] =
    predictedHz === null
      ? 'no_detection'
      : pitchAccurate50
      ? 'correct'
      : octaveError
      ? 'octave_error'
      : harmonicError
      ? 'harmonic_error'
      : absCentsError !== null && absCentsError <= 150
      ? 'near_miss'
      : 'large_error';

  return {
    fileId: input.row.fileId,
    relativeFilePath: input.row.relativeFilePath,
    stringId: input.row.stringId,
    fret: input.row.fret,
    take: input.row.take,
    stringBand: stringGroup(input.row.stringId),
    algorithm: input.algorithm,
    timeWindow: input.windowSpec.id,
    windowStartSec: roundNumber(input.bounds.startSample / input.sampleRate, 6),
    windowEndSec: roundNumber(input.bounds.endSample / input.sampleRate, 6),
    sampleRate: input.sampleRate,
    durationSec: roundNumber(input.durationSec, 6),
    groundTruthMidi: input.groundTruthMidi,
    groundTruthNote: midiToNoteName(input.groundTruthMidi),
    groundTruthHz: roundNumber(input.groundTruthHz, 6),
    predictedMidi: roundNullable(predictedMidi, 6),
    predictedNote: predictedMidi === null ? null : midiToNoteName(Math.round(predictedMidi)),
    predictedHz: roundNullable(predictedHz, 6),
    predictedString,
    predictedFret,
    confidence: roundNullable(confidence, 6),
    acceptedFrameCount: accepted.length,
    totalFrameCount: input.frameResults.length,
    noDetection: predictedHz === null,
    noteCorrect,
    pitchAccurate50,
    stringCorrect,
    fretCorrect,
    octaveError,
    harmonicError,
    errorType,
    centsError: roundNullable(centsError, 3),
    absCentsError: roundNullable(absCentsError, 3),
    runtimeAvgMs: roundNumber(average(input.frameResults.map((entry) => entry.runtimeMs)), 6),
    runtimeP95Ms: roundNullable(percentile(input.frameResults.map((entry) => entry.runtimeMs), 0.95), 6) ?? 0,
    fullRms: roundNumber(input.fullFeature.rms, 8),
    fullFundTo2HarmRatioDb: roundNumber(input.fullFeature.fundTo2HarmRatioDb, 3),
    fullLowToMidRatio: roundNumber(input.fullFeature.lowToMidRatio, 6)
  };
}

function aggregate(rows: DiagnosticRow[]): AggregateMetrics {
  const count = rows.length;
  const stringRows = rows.filter((row) => row.stringCorrect !== null);
  const fretRows = rows.filter((row) => row.fretCorrect !== null);
  return {
    algorithm: rows[0]?.algorithm ?? 'spectral_game_runtime_unified_v3',
    count,
    noteAccuracy: count > 0 ? rows.filter((row) => row.noteCorrect).length / count : 0,
    pitchAccuracy50Cents: count > 0 ? rows.filter((row) => row.pitchAccurate50).length / count : 0,
    stringAccuracy: stringRows.length > 0 ? stringRows.filter((row) => row.stringCorrect).length / stringRows.length : null,
    fretAccuracy: fretRows.length > 0 ? fretRows.filter((row) => row.fretCorrect).length / fretRows.length : null,
    noDetectionRate: count > 0 ? rows.filter((row) => row.noDetection).length / count : 0,
    octaveErrorRate: count > 0 ? rows.filter((row) => row.octaveError).length / count : 0,
    harmonicErrorRate: count > 0 ? rows.filter((row) => row.harmonicError).length / count : 0,
    medianAbsCentsError: roundNullable(median(rows.map((row) => row.absCentsError).filter((value): value is number => value !== null)), 3),
    medianSignedCentsError: roundNullable(median(rows.map((row) => row.centsError).filter((value): value is number => value !== null)), 3),
    runtimeAvgMs: roundNumber(average(rows.map((row) => row.runtimeAvgMs)), 6),
    runtimeP95Ms: roundNullable(percentile(rows.map((row) => row.runtimeP95Ms), 0.95), 6) ?? 0
  };
}

function buildTakeConsistencyRows(rows: DiagnosticRow[]): TakeConsistencyRow[] {
  const grouped = new Map<string, DiagnosticRow[]>();
  for (const row of rows) {
    const key = `${row.algorithm}:${row.stringId}:${row.fret}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }

  const out: TakeConsistencyRow[] = [];
  for (const [key, groupRows] of grouped.entries()) {
    const [algorithm, stringIdText, fretText] = key.split(':');
    const cents = groupRows.map((row) => row.centsError).filter((value): value is number => value !== null);
    const noteAccuracy = groupRows.filter((row) => row.noteCorrect).length / Math.max(1, groupRows.length);
    const noDetectionCount = groupRows.filter((row) => row.noDetection).length;
    const std = standardDeviation(cents);
    const unstableScore =
      (std ?? 200) / 100 +
      (1 - noteAccuracy) +
      (noDetectionCount / Math.max(1, groupRows.length));

    out.push({
      algorithm: algorithm as AlgorithmName,
      stringId: Number(stringIdText),
      fret: Number(fretText),
      takeCount: groupRows.length,
      noteAccuracy: roundNumber(noteAccuracy, 6),
      stdCentsError: roundNullable(std, 3),
      noDetectionCount,
      unstableScore: roundNumber(unstableScore, 6)
    });
  }

  return out.sort((left, right) =>
    left.algorithm.localeCompare(right.algorithm) ||
    right.stringId - left.stringId ||
    left.fret - right.fret
  );
}

async function writeResults(
  outputDir: string,
  rows: DiagnosticRow[],
  aggregates: Record<AlgorithmName, AggregateMetrics>,
  lowMidHigh: Record<AlgorithmName, { low: AggregateMetrics; mid: AggregateMetrics; high: AggregateMetrics }>,
  takeConsistencyRows: TakeConsistencyRow[]
): Promise<void> {
  const doc = {
    generatedAtIso: new Date().toISOString(),
    suite: 'practice',
    datasetPath: DATASET_ROOT,
    datasetPathWindows: WINDOWS_DATASET_ROOT,
    rawOnly: true,
    algorithms: ALGORITHMS,
    timeWindows: TIME_WINDOWS,
    aggregates,
    lowMidHigh,
    takeConsistency: takeConsistencyRows,
    rows
  };

  await fs.writeFile(path.join(outputDir, 'results.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'results.csv'), `${buildCsv(rows)}\n`, 'utf8');
}

function buildCsv(rows: DiagnosticRow[]): string {
  const header = [
    'file_id',
    'relative_file_path',
    'string',
    'fret',
    'take',
    'string_band',
    'algorithm',
    'time_window',
    'window_start_sec',
    'window_end_sec',
    'ground_truth_midi',
    'ground_truth_note',
    'ground_truth_hz',
    'predicted_midi',
    'predicted_note',
    'predicted_hz',
    'predicted_string',
    'predicted_fret',
    'confidence',
    'accepted_frame_count',
    'total_frame_count',
    'no_detection',
    'note_correct',
    'pitch_accurate_50',
    'string_correct',
    'fret_correct',
    'octave_error',
    'harmonic_error',
    'error_type',
    'cents_error',
    'abs_cents_error',
    'runtime_avg_ms',
    'runtime_p95_ms',
    'full_rms',
    'full_fund_to_2harm_ratio_db',
    'full_low_to_mid_ratio'
  ];
  const out = [header.join(',')];
  for (const row of rows) {
    out.push([
      row.fileId,
      row.relativeFilePath,
      row.stringId,
      row.fret,
      row.take,
      row.stringBand,
      row.algorithm,
      row.timeWindow,
      row.windowStartSec,
      row.windowEndSec,
      row.groundTruthMidi,
      row.groundTruthNote,
      row.groundTruthHz,
      row.predictedMidi,
      row.predictedNote,
      row.predictedHz,
      row.predictedString,
      row.predictedFret,
      row.confidence,
      row.acceptedFrameCount,
      row.totalFrameCount,
      row.noDetection,
      row.noteCorrect,
      row.pitchAccurate50,
      row.stringCorrect,
      row.fretCorrect,
      row.octaveError,
      row.harmonicError,
      row.errorType,
      row.centsError,
      row.absCentsError,
      row.runtimeAvgMs,
      row.runtimeP95Ms,
      row.fullRms,
      row.fullFundTo2HarmRatioDb,
      row.fullLowToMidRatio
    ].map((value) => csvEscape(formatCsvValue(value))).join(','));
  }
  return out.join('\n');
}

async function writePlots(
  plotsDir: string,
  rows: DiagnosticRow[],
  aggregates: Record<AlgorithmName, AggregateMetrics>,
  lowMidHigh: Record<AlgorithmName, { low: AggregateMetrics; mid: AggregateMetrics; high: AggregateMetrics }>,
  takeConsistencyRows: TakeConsistencyRow[]
): Promise<void> {
  const fullRows = rows.filter((row) => row.timeWindow === 'full_take');
  await fs.writeFile(path.join(plotsDir, 'accuracy_by_algorithm.svg'), buildAccuracyPlot(aggregates), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'median_cents_error_by_algorithm.svg'), buildMedianCentsPlot(aggregates), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'error_type_distribution.svg'), buildErrorTypeDistributionPlot(fullRows), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'low_mid_high_accuracy.svg'), buildLowMidHighPlot(lowMidHigh), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'take_consistency.svg'), buildTakeConsistencyPlot(takeConsistencyRows), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'failure_rate_vs_frequency.svg'), buildFailureVsFrequencyPlot(fullRows), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'accuracy_by_time_window.svg'), buildAccuracyByWindowPlot(rows), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'runtime_comparison.svg'), buildRuntimePlot(aggregates), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'f0_vs_h2_ratio.svg'), buildFundamentalRatioScatter(fullRows), 'utf8');
}

function buildAccuracyPlot(aggregates: Record<AlgorithmName, AggregateMetrics>): string {
  const width = 980;
  const height = 560;
  const margin = { left: 80, right: 28, top: 58, bottom: 90 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const groupScale = bandScale(ALGORITHMS, margin.left, margin.left + innerWidth, 0.25);
  const subScale = bandScale(['note', 'string', 'fret'], 0, groupScale.bandWidth, 0.15);
  const y = linearScale(0, 1, margin.top + innerHeight, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Practice Accuracy by Algorithm (RAW/full_take)</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#475569" />`);

  for (const algorithm of ALGORITHMS) {
    const agg = aggregates[algorithm];
    const x0 = groupScale.positionForValue(algorithm) ?? margin.left;
    const values = [
      { key: 'note', value: agg.noteAccuracy },
      { key: 'string', value: agg.stringAccuracy ?? 0 },
      { key: 'fret', value: agg.fretAccuracy ?? 0 }
    ];
    for (const value of values) {
      const sx = subScale.positionForValue(value.key) ?? 0;
      const top = y(value.value);
      const h = margin.top + innerHeight - top;
      elements.push(`<rect x="${(x0 + sx).toFixed(2)}" y="${top.toFixed(2)}" width="${(subScale.bandWidth - 2).toFixed(2)}" height="${h.toFixed(2)}" fill="${colorForAlgorithm(algorithm)}" fill-opacity="0.86" />`);
      elements.push(`<text x="${(x0 + sx + subScale.bandWidth / 2).toFixed(2)}" y="${(top - 6).toFixed(2)}" fill="#cbd5e1" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${formatPct(value.value)}</text>`);
    }
    elements.push(`<text x="${(x0 + groupScale.bandWidth / 2).toFixed(2)}" y="${height - 24}" fill="#94a3b8" font-size="12" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(algorithm)}</text>`);
  }

  elements.push('</svg>');
  return elements.join('\n');
}

function buildMedianCentsPlot(aggregates: Record<AlgorithmName, AggregateMetrics>): string {
  return buildSimpleMetricPlot(
    'Median Abs Cents Error (RAW/full_take)',
    ALGORITHMS.map((algorithm) => ({
      label: algorithm,
      value: aggregates[algorithm].medianAbsCentsError ?? 0,
      color: colorForAlgorithm(algorithm),
      text: formatNullable(aggregates[algorithm].medianAbsCentsError, 1, 'c')
    })),
    'c'
  );
}

function buildRuntimePlot(aggregates: Record<AlgorithmName, AggregateMetrics>): string {
  return buildSimpleMetricPlot(
    'Runtime avg (ms) per window inference',
    ALGORITHMS.map((algorithm) => ({
      label: algorithm,
      value: aggregates[algorithm].runtimeAvgMs,
      color: colorForAlgorithm(algorithm),
      text: `${aggregates[algorithm].runtimeAvgMs.toFixed(3)} ms`
    })),
    'ms'
  );
}

function buildSimpleMetricPlot(
  title: string,
  values: Array<{ label: string; value: number; color: string; text: string }>,
  unit: string
): string {
  const width = 920;
  const height = 460;
  const margin = { left: 80, right: 28, top: 58, bottom: 72 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const x = bandScale(values.map((value) => value.label), margin.left, margin.left + innerWidth, 0.28);
  const maxValue = Math.max(1, ...values.map((value) => value.value));
  const y = linearScale(0, maxValue * 1.15, margin.top + innerHeight, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">${escapeXml(title)}</text>`);
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

  elements.push(`<text x="${width - 10}" y="${margin.top + 14}" fill="#64748b" font-size="11" text-anchor="end" font-family="Arial, sans-serif">${escapeXml(unit)}</text>`);
  elements.push('</svg>');
  return elements.join('\n');
}

function buildErrorTypeDistributionPlot(rows: DiagnosticRow[]): string {
  const errorTypes: Array<{ key: DiagnosticRow['errorType']; color: string }> = [
    { key: 'correct', color: '#22c55e' },
    { key: 'octave_error', color: '#38bdf8' },
    { key: 'harmonic_error', color: '#f59e0b' },
    { key: 'near_miss', color: '#eab308' },
    { key: 'large_error', color: '#f97316' },
    { key: 'no_detection', color: '#f43f5e' }
  ];

  const width = 980;
  const height = 540;
  const margin = { left: 80, right: 28, top: 58, bottom: 78 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const x = bandScale(ALGORITHMS, margin.left, margin.left + innerWidth, 0.35);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Error Type Distribution (RAW/full_take)</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);

  for (const algorithm of ALGORITHMS) {
    const algorithmRows = rows.filter((row) => row.algorithm === algorithm);
    const x0 = x.positionForValue(algorithm) ?? margin.left;
    let currentTop = margin.top + innerHeight;
    for (const errorType of errorTypes) {
      const ratio = algorithmRows.length > 0
        ? algorithmRows.filter((row) => row.errorType === errorType.key).length / algorithmRows.length
        : 0;
      const h = ratio * innerHeight;
      currentTop -= h;
      elements.push(`<rect x="${x0.toFixed(2)}" y="${currentTop.toFixed(2)}" width="${(x.bandWidth - 2).toFixed(2)}" height="${h.toFixed(2)}" fill="${errorType.color}" />`);
    }
    elements.push(`<text x="${(x0 + x.bandWidth / 2).toFixed(2)}" y="${height - 20}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(algorithm)}</text>`);
  }

  elements.push(...buildLegend(errorTypes.map((item) => ({ label: item.key, color: item.color })), width - 230, 90));
  elements.push('</svg>');
  return elements.join('\n');
}

function buildLowMidHighPlot(lowMidHigh: Record<AlgorithmName, { low: AggregateMetrics; mid: AggregateMetrics; high: AggregateMetrics }>): string {
  const width = 980;
  const height = 560;
  const margin = { left: 80, right: 28, top: 58, bottom: 88 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const groupScale = bandScale(['low', 'mid', 'high'], margin.left, margin.left + innerWidth, 0.25);
  const subScale = bandScale(ALGORITHMS, 0, groupScale.bandWidth, 0.2);
  const y = linearScale(0, 1, margin.top + innerHeight, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Low/Mid/High String Note Accuracy</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);

  const groups: Array<'low' | 'mid' | 'high'> = ['low', 'mid', 'high'];
  for (const group of groups) {
    const x0 = groupScale.positionForValue(group) ?? margin.left;
    for (const algorithm of ALGORITHMS) {
      const sx = subScale.positionForValue(algorithm) ?? 0;
      const value = lowMidHigh[algorithm][group].noteAccuracy;
      const top = y(value);
      const h = margin.top + innerHeight - top;
      elements.push(`<rect x="${(x0 + sx).toFixed(2)}" y="${top.toFixed(2)}" width="${(subScale.bandWidth - 2).toFixed(2)}" height="${h.toFixed(2)}" fill="${colorForAlgorithm(algorithm)}" fill-opacity="0.86" />`);
      elements.push(`<text x="${(x0 + sx + subScale.bandWidth / 2).toFixed(2)}" y="${(top - 6).toFixed(2)}" fill="#cbd5e1" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${formatPct(value)}</text>`);
    }
    elements.push(`<text x="${(x0 + groupScale.bandWidth / 2).toFixed(2)}" y="${height - 24}" fill="#94a3b8" font-size="12" text-anchor="middle" font-family="Arial, sans-serif">${group}</text>`);
  }

  elements.push(...buildLegend(ALGORITHMS.map((algorithm) => ({ label: algorithm, color: colorForAlgorithm(algorithm) })), width - 240, 92));
  elements.push('</svg>');
  return elements.join('\n');
}

function buildTakeConsistencyPlot(rows: TakeConsistencyRow[]): string {
  const topRows = [...rows]
    .sort((left, right) => right.unstableScore - left.unstableScore)
    .slice(0, 16);

  const width = 1040;
  const height = 560;
  const margin = { left: 160, right: 28, top: 58, bottom: 42 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const y = bandScale(topRows.map((row) => `${row.algorithm}:s${row.stringId}f${row.fret}`), margin.top, margin.top + innerHeight, 0.2);
  const maxValue = Math.max(1, ...topRows.map((row) => row.unstableScore));
  const x = linearScale(0, maxValue * 1.1, margin.left, margin.left + innerWidth);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Most Unstable Take Groups (Higher = Worse)</text>`);

  topRows.forEach((row) => {
    const key = `${row.algorithm}:s${row.stringId}f${row.fret}`;
    const y0 = y.positionForValue(key) ?? margin.top;
    const barWidth = x(row.unstableScore) - margin.left;
    elements.push(`<rect x="${margin.left}" y="${y0.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${(y.bandWidth - 2).toFixed(2)}" fill="${colorForAlgorithm(row.algorithm)}" fill-opacity="0.86" />`);
    elements.push(`<text x="${margin.left - 8}" y="${(y0 + y.bandWidth / 2).toFixed(2)}" fill="#94a3b8" font-size="11" text-anchor="end" dominant-baseline="middle" font-family="Arial, sans-serif">${escapeXml(key)}</text>`);
    elements.push(`<text x="${(margin.left + barWidth + 6).toFixed(2)}" y="${(y0 + y.bandWidth / 2).toFixed(2)}" fill="#cbd5e1" font-size="11" dominant-baseline="middle" font-family="Arial, sans-serif">${row.unstableScore.toFixed(2)}</text>`);
  });

  elements.push('</svg>');
  return elements.join('\n');
}

function buildFailureVsFrequencyPlot(rows: DiagnosticRow[]): string {
  const frequencies = [...new Set(rows.map((row) => row.groundTruthHz))].sort((left, right) => left - right);
  const width = 980;
  const height = 460;
  const margin = { left: 80, right: 28, top: 58, bottom: 72 };

  const x = linearScale(Math.min(...frequencies), Math.max(...frequencies), margin.left, width - margin.right);
  const y = linearScale(0, 1, height - margin.bottom, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Failure Rate vs Frequency (RAW/full_take)</text>`);
  elements.push(`<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#475569" />`);

  for (const algorithm of ALGORITHMS) {
    const path: string[] = [];
    for (const frequency of frequencies) {
      const bucket = rows.filter((row) => row.algorithm === algorithm && row.groundTruthHz === frequency);
      const failureRate = bucket.length > 0 ? bucket.filter((row) => !row.noteCorrect).length / bucket.length : 0;
      path.push(`${path.length === 0 ? 'M' : 'L'} ${x(frequency).toFixed(2)} ${y(failureRate).toFixed(2)}`);
    }
    elements.push(`<path d="${path.join(' ')}" fill="none" stroke="${colorForAlgorithm(algorithm)}" stroke-width="2.4" />`);
  }

  elements.push(...buildLegend(ALGORITHMS.map((algorithm) => ({ label: algorithm, color: colorForAlgorithm(algorithm) })), width - 230, 92));
  elements.push('</svg>');
  return elements.join('\n');
}

function buildAccuracyByWindowPlot(rows: DiagnosticRow[]): string {
  const width = 1060;
  const height = 560;
  const margin = { left: 80, right: 28, top: 58, bottom: 90 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const windows = TIME_WINDOWS.map((window) => window.id);
  const groupScale = bandScale(windows, margin.left, margin.left + innerWidth, 0.25);
  const subScale = bandScale(ALGORITHMS, 0, groupScale.bandWidth, 0.18);
  const y = linearScale(0, 1, margin.top + innerHeight, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Note Accuracy by Time Window</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);

  for (const windowId of windows) {
    const x0 = groupScale.positionForValue(windowId) ?? margin.left;
    for (const algorithm of ALGORITHMS) {
      const sx = subScale.positionForValue(algorithm) ?? 0;
      const bucket = rows.filter((row) => row.timeWindow === windowId && row.algorithm === algorithm);
      const value = bucket.length > 0 ? bucket.filter((row) => row.noteCorrect).length / bucket.length : 0;
      const top = y(value);
      const h = margin.top + innerHeight - top;
      elements.push(`<rect x="${(x0 + sx).toFixed(2)}" y="${top.toFixed(2)}" width="${(subScale.bandWidth - 2).toFixed(2)}" height="${h.toFixed(2)}" fill="${colorForAlgorithm(algorithm)}" fill-opacity="0.86" />`);
      elements.push(`<text x="${(x0 + sx + subScale.bandWidth / 2).toFixed(2)}" y="${(top - 6).toFixed(2)}" fill="#cbd5e1" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${formatPct(value)}</text>`);
    }
    elements.push(`<text x="${(x0 + groupScale.bandWidth / 2).toFixed(2)}" y="${height - 22}" fill="#94a3b8" font-size="10" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(windowId)}</text>`);
  }

  elements.push(...buildLegend(ALGORITHMS.map((algorithm) => ({ label: algorithm, color: colorForAlgorithm(algorithm) })), width - 230, 90));
  elements.push('</svg>');
  return elements.join('\n');
}

function buildFundamentalRatioScatter(rows: DiagnosticRow[]): string {
  const width = 980;
  const height = 480;
  const margin = { left: 80, right: 28, top: 58, bottom: 70 };
  const innerWidth = width - margin.left - margin.right;
  const xMin = Math.min(...rows.map((row) => row.fullFundTo2HarmRatioDb));
  const xMax = Math.max(...rows.map((row) => row.fullFundTo2HarmRatioDb));
  const x = linearScale(xMin, xMax === xMin ? xMin + 1 : xMax, margin.left, margin.left + innerWidth);
  const y = linearScale(0, 1, height - margin.bottom, margin.top);

  const elements = [svgHeader(width, height), '<rect width="100%" height="100%" fill="#08111f" />'];
  elements.push(`<text x="${margin.left}" y="34" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Fundamental/2nd Harmonic Ratio vs Correctness</text>`);
  elements.push(`<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#475569" />`);

  for (const row of rows) {
    const py = y(row.noteCorrect ? 1 : 0) + ((hashString(`${row.fileId}:${row.algorithm}`) % 9) - 4);
    elements.push(`<circle cx="${x(row.fullFundTo2HarmRatioDb).toFixed(2)}" cy="${py.toFixed(2)}" r="4.2" fill="${colorForAlgorithm(row.algorithm)}" fill-opacity="0.86" />`);
  }

  elements.push(...buildLegend(ALGORITHMS.map((algorithm) => ({ label: algorithm, color: colorForAlgorithm(algorithm) })), width - 230, 90));
  elements.push('</svg>');
  return elements.join('\n');
}

async function writeSummary(
  outputDir: string,
  datasetFileCount: number,
  rows: DiagnosticRow[],
  aggregates: Record<AlgorithmName, AggregateMetrics>,
  lowMidHigh: Record<AlgorithmName, { low: AggregateMetrics; mid: AggregateMetrics; high: AggregateMetrics }>,
  takeConsistencyRows: TakeConsistencyRow[]
): Promise<void> {
  const fullRows = rows.filter((row) => row.timeWindow === 'full_take');
  const qualityWinner = [...ALGORITHMS].sort((left, right) =>
    aggregates[right].noteAccuracy - aggregates[left].noteAccuracy ||
    aggregates[right].pitchAccuracy50Cents - aggregates[left].pitchAccuracy50Cents
  )[0];

  const deployabilityWinner = [...ALGORITHMS].sort((left, right) =>
    aggregates[left].runtimeAvgMs - aggregates[right].runtimeAvgMs ||
    aggregates[right].noteAccuracy - aggregates[left].noteAccuracy
  )[0];

  const lowNoteFailures = fullRows
    .filter((row) => row.stringId >= 5 && !row.noteCorrect)
    .sort((left, right) => (right.absCentsError ?? 0) - (left.absCentsError ?? 0))
    .slice(0, 10);

  const unstableTop = [...takeConsistencyRows]
    .sort((left, right) => right.unstableScore - left.unstableScore)
    .slice(0, 10);

  const summary = [
    '# Practice Benchmark Suite',
    '',
    '## Scope',
    '',
    '- Task: note/string/fret recognition for Practice feedback.',
    '- Algorithms: `spectral_game_runtime_unified_v3`, `FRETNET`.',
    '- Input policy: RAW only headline metrics.',
    '- Dataset path: `' + WINDOWS_DATASET_ROOT + '`.',
    `- WAV files analyzed: ${datasetFileCount}.`,
    '',
    '## Main Metrics (RAW/full_take)',
    '',
    '| Algorithm | Note Acc | Pitch Acc (±50c) | String Acc | Fret Acc | No-Detect | Octave Err | Harmonic Err | Median Abs Cents | Runtime avg / p95 (ms) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...ALGORITHMS.map((algorithm) => {
      const agg = aggregates[algorithm];
      return `| ${algorithm} | ${formatPct(agg.noteAccuracy)} | ${formatPct(agg.pitchAccuracy50Cents)} | ${formatNullable(agg.stringAccuracy, 1, '%')} | ${formatNullable(agg.fretAccuracy, 1, '%')} | ${formatPct(agg.noDetectionRate)} | ${formatPct(agg.octaveErrorRate)} | ${formatPct(agg.harmonicErrorRate)} | ${formatNullable(agg.medianAbsCentsError, 2, 'c')} | ${agg.runtimeAvgMs.toFixed(3)} / ${agg.runtimeP95Ms.toFixed(3)} |`;
    }),
    '',
    '## Low/Mid/High String Note Accuracy',
    '',
    '| Algorithm | Low | Mid | High |',
    '| --- | ---: | ---: | ---: |',
    ...ALGORITHMS.map((algorithm) =>
      `| ${algorithm} | ${formatPct(lowMidHigh[algorithm].low.noteAccuracy)} | ${formatPct(lowMidHigh[algorithm].mid.noteAccuracy)} | ${formatPct(lowMidHigh[algorithm].high.noteAccuracy)} |`
    ),
    '',
    '## Quality vs Deployability',
    '',
    `- Quality winner (recognition): ${qualityWinner}.`,
    `- Deployability winner (runtime-weighted): ${deployabilityWinner}.`,
    `- FRETNET runtime note: avg ${aggregates.FRETNET.runtimeAvgMs.toFixed(3)} ms per analyzed frame window in this offline run; Android integration needs dedicated on-device profiling before shipping decisions.`,
    '',
    '## Low-Note Failures (Top examples)',
    '',
    '| Algorithm | File | String/Fret | Error Type | Abs Cents |',
    '| --- | --- | --- | --- | ---: |',
    ...lowNoteFailures.map((row) => `| ${row.algorithm} | ${row.fileId} | s${row.stringId}f${row.fret} | ${row.errorType} | ${formatNullable(row.absCentsError, 1, 'c')} |`),
    '',
    '## Unstable Takes (Top)',
    '',
    '| Algorithm | String | Fret | Note Acc | Std Cents | No-Detect | Unstable Score |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...unstableTop.map((row) => `| ${row.algorithm} | ${row.stringId} | ${row.fret} | ${formatPct(row.noteAccuracy)} | ${formatNullable(row.stdCentsError, 2, 'c')} | ${row.noDetectionCount} | ${row.unstableScore.toFixed(2)} |`),
    '',
    '## Interpretation Notes',
    '',
    '- This suite is Practice-specific and must not be mixed with Tuner or Gameplay validator rankings.',
    '- Time-window sensitivity is included as diagnostics; full_take remains the headline view for this suite.',
    '- Fundamental-vs-harmonic diagnostics are retained to investigate low-note confusion behavior.',
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

function resolveWindowBounds(
  sampleCount: number,
  sampleRate: number,
  spec: TimeWindowSpec
): { startSample: number; endSample: number } {
  const durationSec = sampleCount / sampleRate;
  if (spec.kind === 'full' || spec.durationSec === null) {
    return { startSample: 0, endSample: sampleCount };
  }
  if (spec.kind === 'center') {
    const duration = Math.min(durationSec, spec.durationSec);
    const startSec = Math.max(0, durationSec / 2 - duration / 2);
    return toSampleBounds(startSec, duration, sampleRate, sampleCount);
  }
  if (spec.kind === 'offset') {
    const startSec = Math.min(Math.max(0, spec.startOffsetSec), Math.max(0, durationSec - 0.1));
    const duration = Math.min(spec.durationSec, Math.max(0.1, durationSec - startSec));
    return toSampleBounds(startSec, duration, sampleRate, sampleCount);
  }
  const sustainStartSec = Math.min(Math.max(0.45, durationSec * 0.55), Math.max(0, durationSec - 0.1));
  const duration = Math.min(spec.durationSec ?? durationSec, Math.max(0.1, durationSec - sustainStartSec));
  return toSampleBounds(sustainStartSec, duration, sampleRate, sampleCount);
}

function toSampleBounds(startSec: number, durationSec: number, sampleRate: number, sampleCount: number): { startSample: number; endSample: number } {
  const startSample = Math.max(0, Math.min(sampleCount - 1, Math.round(startSec * sampleRate)));
  const endSample = Math.max(startSample + 1, Math.min(sampleCount, startSample + Math.max(FRAME_SIZE, Math.round(durationSec * sampleRate))));
  return { startSample, endSample };
}

function computeSegmentFeature(samples: Float32Array, sampleRate: number, expectedFrequencyHz: number): SegmentFeature {
  const rms = computeRms(samples);
  const { powerSpectrum, fftSize } = buildAverageSpectrum(samples, sampleRate);
  const fundBandwidthHz = Math.max(6, expectedFrequencyHz * 0.08);
  const harmonic2BandwidthHz = Math.max(8, expectedFrequencyHz * 0.1);
  const fundEnergy = bandEnergy(powerSpectrum, sampleRate, fftSize, expectedFrequencyHz - fundBandwidthHz, expectedFrequencyHz + fundBandwidthHz);
  const harmonic2Energy = bandEnergy(powerSpectrum, sampleRate, fftSize, expectedFrequencyHz * 2 - harmonic2BandwidthHz, expectedFrequencyHz * 2 + harmonic2BandwidthHz);
  const low80120 = bandEnergy(powerSpectrum, sampleRate, fftSize, 80, 120);
  const mid120250 = bandEnergy(powerSpectrum, sampleRate, fftSize, 120, 250);

  return {
    rms,
    fundTo2HarmRatioDb: 10 * Math.log10(Math.max(fundEnergy, 1e-12) / Math.max(harmonic2Energy, 1e-12)),
    lowToMidRatio: low80120 / Math.max(mid120250, 1e-12)
  };
}

function buildAverageSpectrum(samples: Float32Array, sampleRate: number): { powerSpectrum: Float32Array; fftSize: number } {
  const fftSize = 8192;
  const hopSize = 2048;
  const plan = buildFftPlan(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const magnitude = new Float32Array(fftSize / 2 + 1);
  const window = fillWindowKernel(new Float32Array(fftSize), 'hann');
  const power = new Float32Array(fftSize / 2 + 1);
  const starts = buildSpectrumFrameStarts(samples.length, fftSize, hopSize);

  for (const start of starts) {
    const frame = new Float32Array(fftSize);
    const available = Math.min(fftSize, Math.max(0, samples.length - start));
    if (available > 0) {
      frame.set(samples.subarray(start, start + available));
    }
    for (let i = 0; i < fftSize; i += 1) {
      frame[i] *= window[i];
    }
    computeMagnitudeSpectrum(frame, fftSize, plan, re, im, magnitude);
    for (let i = 0; i < power.length; i += 1) {
      power[i] += magnitude[i] * magnitude[i];
    }
  }

  const frameCount = Math.max(1, starts.length);
  for (let i = 0; i < power.length; i += 1) {
    power[i] /= frameCount;
  }

  return { powerSpectrum: power, fftSize };
}

function buildSpectrumFrameStarts(sampleCount: number, frameSize: number, hopSize: number): number[] {
  if (sampleCount <= frameSize) return [0];
  const starts: number[] = [];
  for (let start = 0; start <= sampleCount - frameSize; start += hopSize) {
    starts.push(start);
  }
  if (starts[starts.length - 1] !== sampleCount - frameSize) {
    starts.push(sampleCount - frameSize);
  }
  return starts;
}

function bandEnergy(spectrum: ArrayLike<number>, sampleRate: number, fftSize: number, minHz: number, maxHz: number): number {
  const start = Math.max(0, Math.floor((Math.max(0, minHz) * fftSize) / sampleRate));
  const end = Math.min(spectrum.length - 1, Math.ceil((Math.max(0, maxHz) * fftSize) / sampleRate));
  let total = 0;
  for (let i = start; i <= end; i += 1) {
    total += spectrum[i] ?? 0;
  }
  return total;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

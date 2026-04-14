#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import decodeAudio from 'audio-decode';
import { AudioPreprocessService } from '../../src/audio/AudioPreprocessService';
import {
  buildFftPlan,
  computeMagnitudeSpectrum,
  computePeak,
  computeRms,
  computeTopSpectralPeaks,
  fillWindowKernel
} from '../../src/audio/debugSignalProcessing';
import { FeatureExtractionService } from '../../src/audio/FeatureExtractionService';
import initDspCore, { GhDspCore, PitchDetectorPreset } from '../../src/audio/dsp-core/gh_dsp_core.js';
import { buildPracticeSpectralRuntimeModel } from '../../src/audio/spectralRuntimeModel';
import { midiForStringFret, STANDARD_TUNING } from '../../src/guitar/tuning';
import { MASPAdapter } from '../../src/pitch/adapters/MASPAdapter';
import type { AudioFrameContext, PitchDetectorResult } from '../../src/pitch/types';
import { midiToHz, midiToNoteName } from '../../src/ui/song-select/utils/songSelectUtils';

const execFile = promisify(execFileCb);

type DatasetRow = {
  fileId: string;
  filePath: string;
  relativeFilePath: string;
  stringId: number;
  fret: number;
  take: number;
  durationSec: number | null;
  sampleRate: number | null;
  sampleCount: number | null;
  manifestOrder: number | null;
};

type DatasetManifestTake = {
  order?: number;
  stringId?: number;
  fret?: number;
  take?: number;
  relativePath?: string;
  durationSec?: number | null;
  sampleRate?: number | null;
  sampleCount?: number | null;
};

type DatasetManifest = {
  audioFormat?: {
    sampleRate?: number | null;
    channels?: number | null;
    encoding?: string | null;
    bitsPerSample?: number | null;
    blockSize?: number | null;
    callbackFrames?: number | null;
    notes?: string | null;
  };
  takes?: DatasetManifestTake[];
};

type DetectorRunner = {
  name: string;
  init: () => Promise<void> | void;
  reset: () => void;
  processFrame: (input: AudioFrameContext) => PitchDetectorResult;
  dispose?: () => void;
};

type SegmentFeature = {
  segmentId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  sampleCount: number;
  rms: number;
  peakAbs: number;
  crestFactor: number;
  mean: number;
  dcOffset: number;
  energy_20_50_hz: number;
  energy_50_90_hz: number;
  energy_80_120_hz: number;
  energy_120_250_hz: number;
  energy_250_500_hz: number;
  energy_500_1000_hz: number;
  energy_1000_2000_hz: number;
  low_to_mid_ratio: number;
  spectral_tilt_80_120_vs_500_1000_db: number;
  fund_energy: number;
  harmonic2_energy: number;
  harmonic3_energy: number;
  fund_to_2harm_ratio: number;
  fund_to_2harm_ratio_db: number;
  fund_to_3harm_ratio: number;
  fund_to_3harm_ratio_db: number;
  second_harmonic_stronger_than_fundamental: boolean;
  third_harmonic_stronger_than_fundamental: boolean;
  topPeakHz: number | null;
  topPeak2Hz: number | null;
};

type TakeFeaturesRow = {
  fileId: string;
  relativeFilePath: string;
  stringId: number;
  fret: number;
  take: number;
  groundTruthMidi: number;
  groundTruthNote: string;
  groundTruthFrequencyHz: number;
  durationSec: number;
  sampleRate: number;
  sampleCount: number;
  segments: Record<string, SegmentFeature>;
};

type DiagnosticRow = {
  fileId: string;
  relativeFilePath: string;
  stringId: number;
  fret: number;
  take: number;
  sampleRate: number;
  sampleCount: number;
  durationSec: number;
  groundTruthMidi: number;
  groundTruthNote: string;
  groundTruthFrequencyHz: number;
  algorithm: string;
  frontend: string;
  timeWindowVariant: string;
  windowStartSec: number;
  windowEndSec: number;
  windowDurationSec: number;
  predictionHz: number | null;
  predictionMidi: number | null;
  predictionNote: string | null;
  confidence: number | null;
  acceptedFrameCount: number;
  totalFrameCount: number;
  acceptedFrameRate: number;
  noDetection: boolean;
  invalidOutput: boolean;
  dominantRejectReason: string | null;
  dominantDebugResampleMode: string | null;
  centsError: number | null;
  absCentsError: number | null;
  classifiedErrorType: string;
  isSuccess: boolean;
  isFailure: boolean;
  full_rms: number;
  full_peak_abs: number;
  full_low_to_mid_ratio: number;
  full_fund_to_2harm_ratio_db: number;
  full_fund_to_3harm_ratio_db: number;
  full_second_harmonic_stronger: boolean;
  window_rms: number;
  window_peak_abs: number;
  window_low_to_mid_ratio: number;
  window_fund_to_2harm_ratio_db: number;
  window_fund_to_3harm_ratio_db: number;
  window_second_harmonic_stronger: boolean;
};

type AggregateMetrics = {
  count: number;
  pitchAccuracy50Cents: number;
  medianAbsCentsError: number | null;
  medianSignedCentsError: number | null;
  noDetectionRate: number;
  invalidOutputRate: number;
  octaveUpRate: number;
  octaveDownRate: number;
  harmonicRelatedRate: number;
  nearMissRate: number;
  largeErrorRate: number;
  medianAcceptedFrameRate: number | null;
};

type CorrelationSummary = {
  pearson_success: number | null;
  pearson_abs_cents: number | null;
};

type BaselineSnapshot = {
  sourcePath: string | null;
  rawAggregates: Record<string, AggregateMetrics>;
  legacyHpfAggregates: Record<string, AggregateMetrics>;
};

type HpfAudit = {
  representativeFileId: string;
  representativeRelativePath: string;
  representativeStartSec: number;
  sampleRate: number;
  theoreticalGainAtE2Db: number;
  theoreticalGainAtA2Db: number;
  theoreticalGainAtE3Db: number;
  medianLowStringFundGainDb: number;
  medianLowStringSecondHarmGainDb: number;
  medianFrameDifferenceRms: number;
  note: string;
};

type MaspAudit = {
  observedSampleRates: number[];
  dominantResampleModes: Record<string, number>;
  sourceFrameSamples: number;
  strictFrameSamples: number;
  sourceDurationMsAt48k: number;
  interpretedDurationMsAt22050: number;
  durationStretchFactorAt48k: number;
  effectiveFrequencyScaleFactorAt48k: number;
  rawFullTakeAccuracy: number | null;
  rawFullTakeMedianSignedCents: number | null;
  dominantErrorTypes: Record<string, number>;
  note: string;
};

type PyinAudit = {
  cliPath: string;
  runCount: number;
  observedInputSampleRates: number[];
  observedRuntimeSampleRates: number[];
  anyResampledInput: boolean;
  configuredBlockSize: number;
  configuredCallbackSize: number;
  configuredHopSize: number;
  inferredFrameLength: number;
  fminHz: number;
  fmaxHz: number;
  unvoicedRepresentation: string;
  noDetectionBehavior: string;
  rawFullTakeAccuracy: number | null;
  rawLowStringAccuracy: number | null;
  rawLowStringNoDetectionRate: number | null;
  rawLowStringMedianSignedCents: number | null;
  note: string;
};

type DatasetIntegrityReport = {
  expectedFileCount: number;
  discoveredWavCount: number;
  parsedPatternCount: number;
  invalidNamedFiles: string[];
  duplicateCombos: Array<{ stringId: number; fret: number; take: number; files: string[] }>;
  missingCombos: Array<{ stringId: number; fret: number; take: number }>;
  corruptedFiles: Array<{ relativeFilePath: string; error: string }>;
};

type TakeConsistencyRow = {
  algorithm: string;
  stringId: number;
  fret: number;
  takeCount: number;
  meanCentsError: number | null;
  stdCentsError: number | null;
  consistencyRate: number;
  sameNoteAgreementRate: number | null;
  sameOctaveAgreementRate: number | null;
  noDetectionCount: number;
  unstableScore: number;
};

type RankingEntry = {
  algorithm: string;
  overallAccuracy: number;
  lowStringAccuracy: number;
  medianAbsCents: number | null;
  stabilityScore: number;
  octaveErrorRate: number;
  lowStringNoDetectionRate: number;
  compositeRankScore: number;
};

type PyinFrameResult = {
  captureTimeSec: number;
  pitchHz: number | null;
  midiEstimate: number | null;
  confidence: number | null;
  reason: string | null;
};

type PyinTrace = {
  inputSampleRate: number;
  runtimeSampleRate: number;
  resampled: boolean;
  runtimeBlockSize: number;
  runtimeCallbackSize: number;
  runtimeHopSize: number;
  fminHz: number;
  fmaxHz: number;
  inferredFrameLength: number;
  frames: PyinFrameResult[];
};

const FRAME_SIZE = 4096;
const FEATURE_FFT_SIZE = 8192;
const FEATURE_HOP_SIZE = 2048;
const FILE_NAME_PATTERN = /^string_(\d+)_fret_(\d+)_take_(\d+)\.wav$/i;
const DATASET_ROOT = 'assets/session_20260403_174852';
const WINDOWS_DATASET_ROOT = 'assets\\session_20260403_174852';
const OUTPUT_ROOT = 'analysis/pitchdebug_partial_eval_raw_only';
const BASELINE_RESULTS_PATH = 'analysis/pitchdebug_partial_eval/results.json';
const ALGORITHMS = ['ac14', 'spectral_game_runtime_unified_v3', 'MASP', 'FRETNET', 'pyin'] as const;
const EXPECTED_STRINGS = [1, 2, 3, 4, 5, 6] as const;
const EXPECTED_TAKES = [1, 2, 3] as const;
const EXPECTED_FRET_MIN = 0;
const EXPECTED_FRET_MAX = 12;
const EXPECTED_FILE_COUNT = EXPECTED_STRINGS.length * (EXPECTED_FRET_MAX - EXPECTED_FRET_MIN + 1) * EXPECTED_TAKES.length;
const PYIN_BLOCK_SIZE = FRAME_SIZE;
const PYIN_CALLBACK_SIZE = FRAME_SIZE;
const FEATURE_SEGMENTS = [
  { id: 'full', label: 'Full take' },
  { id: 'early', label: 'Early segment' },
  { id: 'center', label: 'Center segment' },
  { id: 'late', label: 'Late sustain segment' }
] as const;
const TIME_WINDOWS = [
  { id: 'full_take', label: 'Full take', kind: 'full' as const, durationSec: null, startOffsetSec: 0, targetFrames: 18 },
  { id: 'center_window', label: 'Center window (450 ms)', kind: 'center' as const, durationSec: 0.45, startOffsetSec: 0, targetFrames: 8 },
  { id: 'sustain_window', label: 'Sustain window (750 ms)', kind: 'sustain' as const, durationSec: 0.75, startOffsetSec: 0, targetFrames: 12 },
  { id: 'onset_skipped_window', label: 'Onset skipped (200 ms + 550 ms)', kind: 'offset' as const, durationSec: 0.55, startOffsetSec: 0.20, targetFrames: 9 },
  { id: 'sustain_long_window', label: 'Sustain long (1200 ms)', kind: 'sustain' as const, durationSec: 1.2, startOffsetSec: 0, targetFrames: 18 }
] as const;
const FRONTENDS = [
  { id: 'raw', label: 'RAW' }
] as const;

let dspCoreInitPromise: Promise<void> | null = null;

class DspCoreDetector implements DetectorRunner {
  readonly name: string;
  private core: GhDspCore | null = null;
  private preparedSampleRate = 0;
  private preparedBlockSize = 0;
  private zeroReference = new Float32Array(0);

  constructor(
    name: string,
    private readonly preset: PitchDetectorPreset,
    private readonly spectralModelJson: string | null = null
  ) {
    this.name = name;
  }

  async init(): Promise<void> {
    await ensureDspCoreReady();
  }

  reset(): void {
    this.core?.reset();
  }

  dispose(): void {
    this.core?.free();
    this.core = null;
  }

  processFrame(input: AudioFrameContext): PitchDetectorResult {
    const core = this.ensureCore(input.sampleRate, input.processedFrame.length);
    if (this.zeroReference.length !== input.processedFrame.length) {
      this.zeroReference = new Float32Array(input.processedFrame.length);
    }
    core.set_reference_block(this.zeroReference);
    const output = core.process_block(input.processedFrame) as Record<string, unknown>;
    const midi = finiteNumber(output.midi_estimate);
    const confidence = finiteNumber(output.confidence) ?? 0;
    if (midi === null) {
      return {
        detectorName: this.name,
        accepted: false,
        confidence,
        rejectReason: buildRejectReason(input.optionalFeatures?.metrics.rmsDbfs ?? null),
        stringId: finiteInteger(output.detected_string),
        fret: finiteInteger(output.detected_fret),
        debug: output
      };
    }
    return {
      detectorName: this.name,
      accepted: true,
      midi,
      pitchHz: midiToHz(midi),
      noteName: midiToNoteName(Math.round(midi)),
      confidence,
      stringId: finiteInteger(output.detected_string),
      fret: finiteInteger(output.detected_fret),
      debug: output
    };
  }

  private ensureCore(sampleRate: number, blockSize: number): GhDspCore {
    if (!this.core || this.preparedSampleRate !== sampleRate || this.preparedBlockSize !== blockSize) {
      this.core?.free();
      this.core = new GhDspCore();
      this.core.prepare(sampleRate, blockSize, 1);
      this.core.set_pitch_detector_preset(this.preset);
      if (this.spectralModelJson) {
        this.core.set_spectral_model(this.spectralModelJson);
      }
      this.preparedSampleRate = sampleRate;
      this.preparedBlockSize = blockSize;
    }
    return this.core;
  }
}

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

  const datasetIntegrity = await buildDatasetIntegrityReport(datasetDir);
  const pyinCliPath = await resolvePyinCliPath(repoRoot);
  const pyinCacheDir = path.join(outputDir, '.pyin_cache');
  await fs.mkdir(pyinCacheDir, { recursive: true });
  const spectralModel = buildPracticeSpectralRuntimeModel(12);
  const spectralModelJson = JSON.stringify(spectralModel);
  const detectors = await createDetectors(spectralModelJson);

  const featuresRows: TakeFeaturesRow[] = [];
  const diagnosticRows: DiagnosticRow[] = [];
  const pyinTraces = new Map<string, PyinTrace>();
  const decodeFailures = new Map<string, string>();

  try {
    for (let index = 0; index < datasetRows.length; index += 1) {
      const row = datasetRows[index];
      console.log(`[diagnostics] ${index + 1}/${datasetRows.length} ${row.relativeFilePath}`);
      let decoded: { samples: Float32Array; sampleRate: number };
      try {
        decoded = await decodeMonoAudio(row.filePath);
      } catch (error) {
        decodeFailures.set(
          row.relativeFilePath,
          error instanceof Error ? (error.message || 'decode_failed') : String(error)
        );
        continue;
      }
      const pyinTrace = await runPyinTraceForFile({
        filePath: row.filePath,
        fileId: row.fileId,
        cliPath: pyinCliPath,
        outputDir: pyinCacheDir
      });
      pyinTraces.set(row.fileId, pyinTrace);

      const groundTruthMidi = midiForStringFret(row.stringId, row.fret);
      const groundTruthFrequencyHz = midiToHz(groundTruthMidi);
      const takeFeatures = buildTakeFeatures(row, decoded.samples, decoded.sampleRate, groundTruthMidi, groundTruthFrequencyHz);
      featuresRows.push(takeFeatures);

      const rawWindowFeatures = new Map<string, SegmentFeature>();
      const rawSegments = new Map<string, { startSample: number; endSample: number; samples: Float32Array }>();
      for (const timeWindow of TIME_WINDOWS) {
        const bounds = resolveTimeWindowBounds(decoded.samples.length, decoded.sampleRate, timeWindow);
        const rawSegment = decoded.samples.slice(bounds.startSample, bounds.endSample);
        rawSegments.set(timeWindow.id, { ...bounds, samples: rawSegment });
        rawWindowFeatures.set(
          timeWindow.id,
          computeSegmentFeature(timeWindow.id, rawSegment, decoded.sampleRate, groundTruthFrequencyHz, bounds.startSample / decoded.sampleRate)
        );
      }

      for (const timeWindow of TIME_WINDOWS) {
        const rawSegment = rawSegments.get(timeWindow.id);
        const windowFeature = rawWindowFeatures.get(timeWindow.id);
        if (!rawSegment || !windowFeature) continue;
        const processedSegment = rawSegment.samples;
        const frameStarts = buildVariantFrameStarts(processedSegment.length, decoded.sampleRate, timeWindow.targetFrames);
        const featureService = new FeatureExtractionService(FRAME_SIZE);
        for (const detector of detectors) {
          detector.reset();
        }

        const perDetectorResults = new Map<string, PitchDetectorResult[]>();
        for (const detector of detectors) {
          perDetectorResults.set(detector.name, []);
        }

        for (let frameIndex = 0; frameIndex < frameStarts.length; frameIndex += 1) {
          const start = frameStarts[frameIndex];
          const rawFrame = readFrame(rawSegment.samples, start, FRAME_SIZE);
          const processedFrame = readFrame(processedSegment, start, FRAME_SIZE);
          const features = featureService.extractFeatures(processedFrame, decoded.sampleRate, null, spectralModel);
          const frameContext: AudioFrameContext = {
            timestampMs: ((rawSegment.startSample + start) / decoded.sampleRate) * 1000,
            frameIndex,
            sampleRate: decoded.sampleRate,
            rawFrame,
            processedFrame,
            analysisWindowId: frameIndex,
            optionalFeatures: features
          };
          for (const detector of detectors) {
            const result = detector.processFrame(frameContext);
            perDetectorResults.get(detector.name)?.push(result);
          }
        }

        for (const detector of detectors) {
          diagnosticRows.push(
            summarizeDiagnosticRow({
              row,
              algorithm: detector.name,
              frontend: 'raw',
              timeWindowVariant: timeWindow.id,
              groundTruthMidi,
              groundTruthFrequencyHz,
              sampleRate: decoded.sampleRate,
              sampleCount: decoded.samples.length,
              durationSec: decoded.samples.length / decoded.sampleRate,
              frameResults: perDetectorResults.get(detector.name) ?? [],
              fullFeature: takeFeatures.segments.full,
              windowFeature,
              windowStartSec: rawSegment.startSample / decoded.sampleRate,
              windowEndSec: rawSegment.endSample / decoded.sampleRate
            })
          );
        }

        const pyinFrameResults = selectPyinFrameResultsForWindow(
          pyinTrace,
          rawSegment.startSample / decoded.sampleRate,
          rawSegment.endSample / decoded.sampleRate,
          timeWindow.targetFrames
        );
        diagnosticRows.push(
          summarizeDiagnosticRow({
            row,
            algorithm: 'pyin',
            frontend: 'raw',
            timeWindowVariant: timeWindow.id,
            groundTruthMidi,
            groundTruthFrequencyHz,
            sampleRate: decoded.sampleRate,
            sampleCount: decoded.samples.length,
            durationSec: decoded.samples.length / decoded.sampleRate,
            frameResults: pyinFrameResults,
            fullFeature: takeFeatures.segments.full,
            windowFeature,
            windowStartSec: rawSegment.startSample / decoded.sampleRate,
            windowEndSec: rawSegment.endSample / decoded.sampleRate
          })
        );
      }
    }
  } finally {
    for (const detector of detectors) {
      detector.dispose?.();
    }
  }

  for (const [relativeFilePath, error] of decodeFailures.entries()) {
    datasetIntegrity.corruptedFiles.push({ relativeFilePath, error });
  }

  const maspAudit = buildMaspAudit(diagnosticRows);
  const pyinAudit = buildPyinAudit(diagnosticRows, pyinTraces, pyinCliPath);
  const takeConsistencyRows = buildTakeConsistencyRows(diagnosticRows);
  const lowMidHighByAlgorithm = buildLowMidHighMetrics(diagnosticRows);
  const rankings = buildAlgorithmRankings(diagnosticRows, takeConsistencyRows, lowMidHighByAlgorithm);

  await writeFeaturesOutputs(outputDir, featuresRows);
  await writeResultsOutputs(outputDir, datasetRows, diagnosticRows, datasetIntegrity, maspAudit, pyinAudit, takeConsistencyRows, lowMidHighByAlgorithm, rankings);
  await writePlots(plotsDir, diagnosticRows, featuresRows);
  await writeSummary(outputDir, datasetRows, diagnosticRows, datasetIntegrity, maspAudit, pyinAudit, takeConsistencyRows, lowMidHighByAlgorithm, rankings);

  console.log(`Dataset: ${DATASET_ROOT}`);
  console.log(`Files discovered: ${datasetRows.length}`);
  console.log(`Decoded files analyzed: ${featuresRows.length}`);
  console.log(`Algorithms: ${ALGORITHMS.join(', ')}`);
  console.log(`Outputs: ${OUTPUT_ROOT}`);
}

async function createDetectors(spectralModelJson: string): Promise<DetectorRunner[]> {
  const masp = new MASPAdapter();
  const detectors: DetectorRunner[] = [
    new DspCoreDetector('ac14', PitchDetectorPreset.Ac14),
    new DspCoreDetector('spectral_game_runtime_unified_v3', PitchDetectorPreset.SpectralGameRuntimeUnifiedV3, spectralModelJson),
    {
      name: masp.name,
      init: () => masp.init({ enabled: true }),
      reset: () => masp.reset(),
      processFrame: (input) => masp.processFrame(input)
    },
    new DspCoreDetector('FRETNET', PitchDetectorPreset.Fretnet, spectralModelJson)
  ];
  for (const detector of detectors) {
    await detector.init();
  }
  return detectors;
}

async function resolvePyinCliPath(repoRoot: string): Promise<string> {
  const candidates = [
    path.join(repoRoot, 'tools/native_pitch_runtime/target/release/fretnet_host_cli'),
    path.join(repoRoot, 'tools/native_pitch_runtime/target/debug/fretnet_host_cli')
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  throw new Error('pYIN host CLI not found. Build tools/native_pitch_runtime first (fretnet_host_cli).');
}

async function runPyinTraceForFile(input: {
  filePath: string;
  fileId: string;
  cliPath: string;
  outputDir: string;
}): Promise<PyinTrace> {
  const outputPath = path.join(input.outputDir, `${input.fileId}.pyin.json`);
  const args = [
    '--audio-path', input.filePath,
    '--backend', 'pyin',
    '--mode', 'streaming',
    '--format', 'json',
    '--block-size', String(PYIN_BLOCK_SIZE),
    '--callback-size', String(PYIN_CALLBACK_SIZE),
    '--output', outputPath
  ];
  await execFile(input.cliPath, args, { maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(await fs.readFile(outputPath, 'utf8')) as Record<string, unknown>;
  const runtimeConfig = (parsed.runtime_config ?? {}) as Record<string, unknown>;
  const audio = (parsed.audio ?? {}) as Record<string, unknown>;
  const runs = Array.isArray(parsed.runs) ? parsed.runs as Array<Record<string, unknown>> : [];
  const streamingRun = runs.find((run) => run.mode === 'streaming') ?? runs[0] ?? {};
  const run = (streamingRun.run ?? {}) as Record<string, unknown>;
  const rawFrames = Array.isArray(run.frames) ? run.frames as Array<Record<string, unknown>> : [];
  const pyinConfig = (runtimeConfig.pyin ?? {}) as Record<string, unknown>;
  const runtimeSampleRate = finiteInteger(runtimeConfig.sample_rate) ?? finiteInteger(audio.runtime_sample_rate) ?? 48_000;
  const runtimeBlockSize = finiteInteger(runtimeConfig.block_size) ?? PYIN_BLOCK_SIZE;
  const fminHz = finiteNumber(pyinConfig.fmin_hz) ?? 82.40689;
  const fmaxHz = finiteNumber(pyinConfig.fmax_hz) ?? 1200.0;
  const inferredFrameLength =
    finiteInteger(pyinConfig.frame_length) ?? deriveDefaultPyinFrameLength(runtimeSampleRate, runtimeBlockSize, fminHz);
  const runtimeHopSize = finiteInteger(pyinConfig.hop_length) ?? runtimeBlockSize;

  return {
    inputSampleRate: finiteInteger(audio.input_sample_rate) ?? runtimeSampleRate,
    runtimeSampleRate,
    resampled: Boolean(audio.resampled),
    runtimeBlockSize,
    runtimeCallbackSize: finiteInteger((run.summary as Record<string, unknown> | undefined)?.callback_size) ?? PYIN_CALLBACK_SIZE,
    runtimeHopSize,
    fminHz,
    fmaxHz,
    inferredFrameLength,
    frames: rawFrames.map((frame) => {
      const event = (frame.event ?? {}) as Record<string, unknown>;
      const pitchHz = finiteNumber(event.pitch_hz);
      return {
        captureTimeSec: finiteNumber(frame.capture_time_sec) ?? finiteNumber(event.timestamp_sec) ?? 0,
        pitchHz: pitchHz !== null && pitchHz > 0 ? pitchHz : null,
        midiEstimate: finiteNumber(event.midi_estimate),
        confidence: finiteNumber(event.confidence),
        reason: typeof event.reason === 'string' ? event.reason : null
      };
    })
  };
}

function deriveDefaultPyinFrameLength(sampleRate: number, runtimeBlockSize: number, fminHz: number): number {
  const safeRuntimeBlock = Math.max(256, runtimeBlockSize);
  if (!(fminHz > 0)) return safeRuntimeBlock;
  const maxPeriod = Math.max(1, Math.ceil(Math.max(sampleRate, 8_000) / fminHz));
  const minSafeFrame = (maxPeriod + 2) * 2;
  return Math.max(safeRuntimeBlock, nextPowerOfTwoAtLeast(minSafeFrame));
}

function nextPowerOfTwoAtLeast(value: number): number {
  if (!(value > 1)) return 1;
  return 2 ** Math.ceil(Math.log2(value));
}

function selectPyinFrameResultsForWindow(
  trace: PyinTrace,
  windowStartSec: number,
  windowEndSec: number,
  targetFrames: number
): PitchDetectorResult[] {
  const rawFrames = trace.frames.filter((frame) => frame.captureTimeSec >= windowStartSec && frame.captureTimeSec <= windowEndSec);
  const frames = sampleEvenly(rawFrames, Math.max(3, targetFrames));
  if (frames.length <= 0) {
    return [
      {
        detectorName: 'pyin',
        accepted: false,
        confidence: 0,
        rejectReason: 'pyin_no_event_in_window',
        debug: {
          runtimeSampleRate: trace.runtimeSampleRate,
          inputSampleRate: trace.inputSampleRate,
          resampled: trace.resampled,
          blockSize: trace.runtimeBlockSize,
          hopSize: trace.runtimeHopSize
        }
      }
    ];
  }
  return frames.map((frame) => {
    if (frame.pitchHz === null || frame.midiEstimate === null) {
      return {
        detectorName: 'pyin',
        accepted: false,
        confidence: frame.confidence ?? 0,
        rejectReason: frame.reason ?? 'pyin_unvoiced',
        debug: {
          runtimeSampleRate: trace.runtimeSampleRate,
          inputSampleRate: trace.inputSampleRate,
          resampled: trace.resampled,
          blockSize: trace.runtimeBlockSize,
          hopSize: trace.runtimeHopSize
        }
      } as PitchDetectorResult;
    }
    return {
      detectorName: 'pyin',
      accepted: true,
      midi: frame.midiEstimate,
      pitchHz: frame.pitchHz,
      noteName: midiToNoteName(Math.round(frame.midiEstimate)),
      confidence: frame.confidence ?? 0,
      debug: {
        runtimeSampleRate: trace.runtimeSampleRate,
        inputSampleRate: trace.inputSampleRate,
        resampled: trace.resampled,
        blockSize: trace.runtimeBlockSize,
        hopSize: trace.runtimeHopSize
      }
    } as PitchDetectorResult;
  });
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

async function ensureDspCoreReady(): Promise<void> {
  if (!dspCoreInitPromise) {
    dspCoreInitPromise = (async () => {
      const wasmPath = path.resolve(process.cwd(), 'src/audio/dsp-core/gh_dsp_core_bg.wasm');
      const wasmBytes = await fs.readFile(wasmPath);
      const moduleBytes = wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength);
      await initDspCore({ module_or_path: moduleBytes });
    })();
  }
  await dspCoreInitPromise;
}

async function buildDatasetRows(datasetDir: string): Promise<DatasetRow[]> {
  const audioDir = path.join(datasetDir, 'audio');
  const manifestPath = path.join(datasetDir, 'manifest.json');
  const manifest = await readJsonIfExists<DatasetManifest>(manifestPath);
  const manifestByKey = new Map<string, DatasetManifestTake>();

  for (const take of manifest?.takes ?? []) {
    const key = buildDatasetKey(take.stringId, take.fret, take.take);
    if (key) {
      manifestByKey.set(key, take);
      continue;
    }
    const parsed = typeof take.relativePath === 'string' ? parseTakeFromFileName(path.basename(take.relativePath)) : null;
    if (parsed) {
      manifestByKey.set(buildDatasetKey(parsed.stringId, parsed.fret, parsed.take)!, take);
    }
  }

  const entries = await fs.readdir(audioDir);
  const rows: DatasetRow[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.wav')) continue;
    const parsed = parseTakeFromFileName(entry);
    if (!parsed) continue;
    const fullPath = path.join(audioDir, entry);
    const relativePath = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
    const manifestTake = manifestByKey.get(buildDatasetKey(parsed.stringId, parsed.fret, parsed.take)!);
    rows.push({
      fileId: `s${String(parsed.stringId).padStart(2, '0')}_f${String(parsed.fret).padStart(2, '0')}_t${String(parsed.take).padStart(2, '0')}`,
      filePath: fullPath,
      relativeFilePath: relativePath,
      stringId: parsed.stringId,
      fret: parsed.fret,
      take: parsed.take,
      durationSec: finiteNumber(manifestTake?.durationSec),
      sampleRate: finiteInteger(manifestTake?.sampleRate),
      sampleCount: finiteInteger(manifestTake?.sampleCount),
      manifestOrder: finiteInteger(manifestTake?.order)
    });
  }

  rows.sort((left, right) =>
    (left.manifestOrder ?? Number.MAX_SAFE_INTEGER) - (right.manifestOrder ?? Number.MAX_SAFE_INTEGER) ||
    right.stringId - left.stringId ||
    left.fret - right.fret ||
    left.take - right.take ||
    left.relativeFilePath.localeCompare(right.relativeFilePath)
  );
  return rows;
}

async function buildDatasetIntegrityReport(datasetDir: string): Promise<DatasetIntegrityReport> {
  const audioDir = path.join(datasetDir, 'audio');
  const entries = await fs.readdir(audioDir);
  const wavEntries = entries.filter((entry) => entry.toLowerCase().endsWith('.wav'));
  const invalidNamedFiles: string[] = [];
  const combos = new Map<string, string[]>();

  for (const entry of wavEntries) {
    const parsed = parseTakeFromFileName(entry);
    if (!parsed) {
      invalidNamedFiles.push(`audio/${entry}`);
      continue;
    }
    const key = `${parsed.stringId}:${parsed.fret}:${parsed.take}`;
    const existing = combos.get(key) ?? [];
    existing.push(`audio/${entry}`);
    combos.set(key, existing);
  }

  const duplicateCombos = [...combos.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([key, files]) => {
      const [stringId, fret, take] = key.split(':').map(Number);
      return { stringId, fret, take, files };
    });

  const missingCombos: Array<{ stringId: number; fret: number; take: number }> = [];
  for (const stringId of EXPECTED_STRINGS) {
    for (let fret = EXPECTED_FRET_MIN; fret <= EXPECTED_FRET_MAX; fret += 1) {
      for (const take of EXPECTED_TAKES) {
        const key = `${stringId}:${fret}:${take}`;
        if (!combos.has(key)) {
          missingCombos.push({ stringId, fret, take });
        }
      }
    }
  }

  return {
    expectedFileCount: EXPECTED_FILE_COUNT,
    discoveredWavCount: wavEntries.length,
    parsedPatternCount: combos.size,
    invalidNamedFiles: invalidNamedFiles.sort(),
    duplicateCombos,
    missingCombos,
    corruptedFiles: []
  };
}

function buildTakeFeatures(
  row: DatasetRow,
  samples: Float32Array,
  sampleRate: number,
  groundTruthMidi: number,
  groundTruthFrequencyHz: number
): TakeFeaturesRow {
  const durationSec = samples.length / sampleRate;
  const segments: Record<string, SegmentFeature> = {};
  const earlyEnd = Math.min(durationSec, 0.45);
  const centerStart = Math.max(0, durationSec / 2 - Math.min(0.5, durationSec) / 2);
  const centerEnd = Math.min(durationSec, centerStart + Math.min(0.5, durationSec));
  const lateDuration = Math.min(0.65, durationSec);
  const lateStart = Math.max(0, Math.min(durationSec - lateDuration, Math.max(0.45, durationSec * 0.62)));
  const lateEnd = Math.min(durationSec, lateStart + lateDuration);
  const bounds = [
    { id: 'full', startSec: 0, endSec: durationSec },
    { id: 'early', startSec: 0, endSec: earlyEnd },
    { id: 'center', startSec: centerStart, endSec: centerEnd },
    { id: 'late', startSec: lateStart, endSec: lateEnd }
  ];
  for (const segment of bounds) {
    const startSample = Math.max(0, Math.round(segment.startSec * sampleRate));
    const endSample = Math.max(startSample + 1, Math.min(samples.length, Math.round(segment.endSec * sampleRate)));
    segments[segment.id] = computeSegmentFeature(segment.id, samples.slice(startSample, endSample), sampleRate, groundTruthFrequencyHz, segment.startSec);
  }
  return {
    fileId: row.fileId,
    relativeFilePath: row.relativeFilePath,
    stringId: row.stringId,
    fret: row.fret,
    take: row.take,
    groundTruthMidi,
    groundTruthNote: midiToNoteName(groundTruthMidi),
    groundTruthFrequencyHz: roundNumber(groundTruthFrequencyHz, 6),
    durationSec: roundNumber(durationSec, 6),
    sampleRate,
    sampleCount: samples.length,
    segments
  };
}

function computeSegmentFeature(
  segmentId: string,
  samples: Float32Array,
  sampleRate: number,
  expectedFrequencyHz: number,
  startSec: number
): SegmentFeature {
  const mean = average(Array.from(samples));
  const rms = computeRms(samples);
  const peak = computePeak(samples);
  const { powerSpectrum, magnitudeSpectrum, fftSize } = buildAverageSpectrum(samples, sampleRate);
  const fundBandwidthHz = Math.max(6, expectedFrequencyHz * 0.08);
  const harmonic2BandwidthHz = Math.max(8, expectedFrequencyHz * 0.1);
  const harmonic3BandwidthHz = Math.max(10, expectedFrequencyHz * 0.12);
  const fundEnergy = bandEnergy(powerSpectrum, sampleRate, fftSize, expectedFrequencyHz - fundBandwidthHz, expectedFrequencyHz + fundBandwidthHz);
  const harmonic2Energy = bandEnergy(powerSpectrum, sampleRate, fftSize, expectedFrequencyHz * 2 - harmonic2BandwidthHz, expectedFrequencyHz * 2 + harmonic2BandwidthHz);
  const harmonic3Energy = bandEnergy(powerSpectrum, sampleRate, fftSize, expectedFrequencyHz * 3 - harmonic3BandwidthHz, expectedFrequencyHz * 3 + harmonic3BandwidthHz);
  const topPeaks = computeTopSpectralPeaks(magnitudeSpectrum, sampleRate, fftSize, 4);
  const low80120 = bandEnergy(powerSpectrum, sampleRate, fftSize, 80, 120);
  const mid120250 = bandEnergy(powerSpectrum, sampleRate, fftSize, 120, 250);
  const low5001000 = bandEnergy(powerSpectrum, sampleRate, fftSize, 500, 1000);
  return {
    segmentId,
    startSec: roundNumber(startSec, 6),
    endSec: roundNumber(startSec + samples.length / sampleRate, 6),
    durationSec: roundNumber(samples.length / sampleRate, 6),
    sampleCount: samples.length,
    rms: roundNumber(rms, 8),
    peakAbs: roundNumber(peak, 8),
    crestFactor: roundNumber(peak / Math.max(rms, 1e-12), 6),
    mean: roundNumber(mean, 8),
    dcOffset: roundNumber(mean, 8),
    energy_20_50_hz: roundNumber(bandEnergy(powerSpectrum, sampleRate, fftSize, 20, 50), 6),
    energy_50_90_hz: roundNumber(bandEnergy(powerSpectrum, sampleRate, fftSize, 50, 90), 6),
    energy_80_120_hz: roundNumber(low80120, 6),
    energy_120_250_hz: roundNumber(mid120250, 6),
    energy_250_500_hz: roundNumber(bandEnergy(powerSpectrum, sampleRate, fftSize, 250, 500), 6),
    energy_500_1000_hz: roundNumber(low5001000, 6),
    energy_1000_2000_hz: roundNumber(bandEnergy(powerSpectrum, sampleRate, fftSize, 1000, 2000), 6),
    low_to_mid_ratio: roundNumber(low80120 / Math.max(mid120250, 1e-12), 6),
    spectral_tilt_80_120_vs_500_1000_db: roundNumber(10 * Math.log10(Math.max(low80120, 1e-12) / Math.max(low5001000, 1e-12)), 3),
    fund_energy: roundNumber(fundEnergy, 6),
    harmonic2_energy: roundNumber(harmonic2Energy, 6),
    harmonic3_energy: roundNumber(harmonic3Energy, 6),
    fund_to_2harm_ratio: roundNumber(fundEnergy / Math.max(harmonic2Energy, 1e-12), 6),
    fund_to_2harm_ratio_db: roundNumber(10 * Math.log10(Math.max(fundEnergy, 1e-12) / Math.max(harmonic2Energy, 1e-12)), 3),
    fund_to_3harm_ratio: roundNumber(fundEnergy / Math.max(harmonic3Energy, 1e-12), 6),
    fund_to_3harm_ratio_db: roundNumber(10 * Math.log10(Math.max(fundEnergy, 1e-12) / Math.max(harmonic3Energy, 1e-12)), 3),
    second_harmonic_stronger_than_fundamental: harmonic2Energy > fundEnergy,
    third_harmonic_stronger_than_fundamental: harmonic3Energy > fundEnergy,
    topPeakHz: roundNullable(topPeaks[0]?.frequencyHz ?? null, 3),
    topPeak2Hz: roundNullable(topPeaks[1]?.frequencyHz ?? null, 3)
  };
}

function buildAverageSpectrum(samples: Float32Array, sampleRate: number): { powerSpectrum: Float32Array; magnitudeSpectrum: Float32Array; fftSize: number } {
  const fftSize = FEATURE_FFT_SIZE;
  const plan = buildFftPlan(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const magnitude = new Float32Array(fftSize / 2 + 1);
  const window = fillWindowKernel(new Float32Array(fftSize), 'hann');
  const power = new Float32Array(fftSize / 2 + 1);
  const starts = buildSpectrumFrameStarts(samples.length, fftSize, FEATURE_HOP_SIZE);
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
  const avgMagnitude = new Float32Array(power.length);
  for (let i = 0; i < power.length; i += 1) {
    power[i] /= frameCount;
    avgMagnitude[i] = Math.sqrt(power[i]);
  }
  return { powerSpectrum: power, magnitudeSpectrum: avgMagnitude, fftSize };
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

function resolveTimeWindowBounds(
  sampleCount: number,
  sampleRate: number,
  spec: (typeof TIME_WINDOWS)[number]
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

function buildVariantFrameStarts(sampleCount: number, sampleRate: number, targetFrames: number): number[] {
  if (!(sampleCount > 0) || !(sampleRate > 0)) return [0];
  const maxStart = Math.max(0, sampleCount - FRAME_SIZE);
  if (maxStart <= 0) return [0];
  const count = Math.max(3, targetFrames);
  const starts: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const ratio = count === 1 ? 0.5 : index / (count - 1);
    starts.push(Math.round(ratio * maxStart));
  }
  return uniqueSorted(starts);
}

function applyFrontend(source: Float32Array, sampleRate: number, frontendId: string): Float32Array {
  const samples = new Float32Array(source);
  if (frontendId === 'raw') return samples;
  if (frontendId === 'dc_remove_only') {
    removeMeanInPlace(samples);
    return samples;
  }
  if (frontendId === 'hpf_20hz') {
    applyBiquadInPlace(samples, designHighPassBiquad(sampleRate, 20, Math.SQRT1_2));
    return samples;
  }
  if (frontendId === 'low_shelf_plus_3db_100hz') {
    applyBiquadInPlace(samples, designLowShelfBiquad(sampleRate, 100, 1, 3));
    return samples;
  }
  if (frontendId === 'low_shelf_plus_6db_100hz') {
    applyBiquadInPlace(samples, designLowShelfBiquad(sampleRate, 100, 1, 6));
    return samples;
  }
  if (frontendId === 'hpf_20hz_plus_low_shelf_3db_100hz') {
    applyBiquadInPlace(samples, designHighPassBiquad(sampleRate, 20, Math.SQRT1_2));
    applyBiquadInPlace(samples, designLowShelfBiquad(sampleRate, 100, 1, 3));
    return samples;
  }
  return samples;
}

function summarizeDiagnosticRow(input: {
  row: DatasetRow;
  algorithm: string;
  frontend: string;
  timeWindowVariant: string;
  groundTruthMidi: number;
  groundTruthFrequencyHz: number;
  sampleRate: number;
  sampleCount: number;
  durationSec: number;
  frameResults: PitchDetectorResult[];
  fullFeature: SegmentFeature;
  windowFeature: SegmentFeature;
  windowStartSec: number;
  windowEndSec: number;
}): DiagnosticRow {
  const accepted = input.frameResults.filter((result) => result.accepted && finiteNumber(result.pitchHz) !== null);
  const totalFrameCount = input.frameResults.length;
  const acceptedFrameRate = totalFrameCount > 0 ? accepted.length / totalFrameCount : 0;
  const predictedFrequencyHz = median(accepted.map((result) => finiteNumber(result.pitchHz)!).filter((value): value is number => value !== null));
  const predictedMidi = median(accepted.map((result) => finiteNumber(result.midi)!).filter((value): value is number => value !== null));
  const confidence = median(accepted.map((result) => finiteNumber(result.confidence)!).filter((value): value is number => value !== null));
  const dominantRejectReason = mostCommon(input.frameResults.map((result) => result.rejectReason ?? null));
  const dominantDebugResampleMode = mostCommon(
    input.frameResults.map((result) => {
      const mode = (result.debug as Record<string, unknown> | undefined)?.resampleMode;
      return typeof mode === 'string' ? mode : null;
    })
  );
  const invalidOutput = predictedFrequencyHz !== null && (!Number.isFinite(predictedFrequencyHz) || predictedFrequencyHz <= 0);
  const centsError = predictedFrequencyHz === null || invalidOutput ? null : centsBetweenFrequencies(predictedFrequencyHz, input.groundTruthFrequencyHz);
  const absCentsError = centsError === null ? null : Math.abs(centsError);
  const classifiedErrorType = classifyError(predictedFrequencyHz, centsError, absCentsError);
  return {
    fileId: input.row.fileId,
    relativeFilePath: input.row.relativeFilePath,
    stringId: input.row.stringId,
    fret: input.row.fret,
    take: input.row.take,
    sampleRate: input.sampleRate,
    sampleCount: input.sampleCount,
    durationSec: roundNumber(input.durationSec, 6),
    groundTruthMidi: input.groundTruthMidi,
    groundTruthNote: midiToNoteName(input.groundTruthMidi),
    groundTruthFrequencyHz: roundNumber(input.groundTruthFrequencyHz, 6),
    algorithm: input.algorithm,
    frontend: input.frontend,
    timeWindowVariant: input.timeWindowVariant,
    windowStartSec: roundNumber(input.windowStartSec, 6),
    windowEndSec: roundNumber(input.windowEndSec, 6),
    windowDurationSec: roundNumber(input.windowEndSec - input.windowStartSec, 6),
    predictionHz: roundNullable(predictedFrequencyHz, 6),
    predictionMidi: roundNullable(predictedMidi, 6),
    predictionNote: predictedMidi === null ? null : midiToNoteName(Math.round(predictedMidi)),
    confidence: roundNullable(confidence, 6),
    acceptedFrameCount: accepted.length,
    totalFrameCount,
    acceptedFrameRate: roundNumber(acceptedFrameRate, 6),
    noDetection: accepted.length <= 0,
    invalidOutput,
    dominantRejectReason,
    dominantDebugResampleMode,
    centsError: roundNullable(centsError, 3),
    absCentsError: roundNullable(absCentsError, 3),
    classifiedErrorType,
    isSuccess: classifiedErrorType === 'correct_within_50c',
    isFailure: classifiedErrorType !== 'correct_within_50c',
    full_rms: input.fullFeature.rms,
    full_peak_abs: input.fullFeature.peakAbs,
    full_low_to_mid_ratio: input.fullFeature.low_to_mid_ratio,
    full_fund_to_2harm_ratio_db: input.fullFeature.fund_to_2harm_ratio_db,
    full_fund_to_3harm_ratio_db: input.fullFeature.fund_to_3harm_ratio_db,
    full_second_harmonic_stronger: input.fullFeature.second_harmonic_stronger_than_fundamental,
    window_rms: input.windowFeature.rms,
    window_peak_abs: input.windowFeature.peakAbs,
    window_low_to_mid_ratio: input.windowFeature.low_to_mid_ratio,
    window_fund_to_2harm_ratio_db: input.windowFeature.fund_to_2harm_ratio_db,
    window_fund_to_3harm_ratio_db: input.windowFeature.fund_to_3harm_ratio_db,
    window_second_harmonic_stronger: input.windowFeature.second_harmonic_stronger_than_fundamental
  };
}

function classifyError(predictionHz: number | null, centsError: number | null, absCentsError: number | null): string {
  if (predictionHz === null) return 'no_detection';
  if (!Number.isFinite(predictionHz) || predictionHz <= 0) return 'invalid_output';
  if (absCentsError !== null && absCentsError <= 50) return 'correct_within_50c';
  if (centsError !== null && Math.abs(centsError - 1200) <= 120) return 'octave_up_error';
  if (centsError !== null && Math.abs(centsError + 1200) <= 120) return 'octave_down_error';
  if (centsError !== null) {
    const harmonicTargets = [1902, -1902, 2400, -2400, 2786, -2786];
    if (harmonicTargets.some((target) => Math.abs(centsError - target) <= 140)) {
      return 'harmonic_related_error';
    }
  }
  if (absCentsError !== null && absCentsError <= 150) return 'near_miss_non_octave';
  return 'large_error';
}

function computeAggregate(rows: DiagnosticRow[]): AggregateMetrics {
  const count = rows.length;
  return {
    count,
    pitchAccuracy50Cents: count > 0 ? rows.filter((row) => row.classifiedErrorType === 'correct_within_50c').length / count : 0,
    medianAbsCentsError: roundNullable(median(rows.map((row) => row.absCentsError).filter((value): value is number => value !== null)), 3),
    medianSignedCentsError: roundNullable(median(rows.map((row) => row.centsError).filter((value): value is number => value !== null)), 3),
    noDetectionRate: count > 0 ? rows.filter((row) => row.classifiedErrorType === 'no_detection').length / count : 0,
    invalidOutputRate: count > 0 ? rows.filter((row) => row.classifiedErrorType === 'invalid_output').length / count : 0,
    octaveUpRate: count > 0 ? rows.filter((row) => row.classifiedErrorType === 'octave_up_error').length / count : 0,
    octaveDownRate: count > 0 ? rows.filter((row) => row.classifiedErrorType === 'octave_down_error').length / count : 0,
    harmonicRelatedRate: count > 0 ? rows.filter((row) => row.classifiedErrorType === 'harmonic_related_error').length / count : 0,
    nearMissRate: count > 0 ? rows.filter((row) => row.classifiedErrorType === 'near_miss_non_octave').length / count : 0,
    largeErrorRate: count > 0 ? rows.filter((row) => row.classifiedErrorType === 'large_error').length / count : 0,
    medianAcceptedFrameRate: roundNullable(median(rows.map((row) => row.acceptedFrameRate)), 6)
  };
}

async function writeFeaturesOutputs(outputDir: string, featuresRows: TakeFeaturesRow[]): Promise<void> {
  const jsonDoc = {
    generatedAtIso: new Date().toISOString(),
    datasetPath: DATASET_ROOT,
    rows: featuresRows
  };
  await fs.writeFile(path.join(outputDir, 'features_per_take.json'), `${JSON.stringify(jsonDoc, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'features_per_take.csv'), `${buildFeaturesCsv(featuresRows)}\n`, 'utf8');
}

async function writeResultsOutputs(
  outputDir: string,
  datasetRows: DatasetRow[],
  diagnosticRows: DiagnosticRow[],
  datasetIntegrity: DatasetIntegrityReport,
  maspAudit: MaspAudit,
  pyinAudit: PyinAudit,
  takeConsistencyRows: TakeConsistencyRow[],
  lowMidHighByAlgorithm: Record<string, Record<string, AggregateMetrics>>,
  rankings: { overall: RankingEntry[]; lowFrequency: RankingEntry[] }
): Promise<void> {
  const rawFull = selectRows(diagnosticRows, 'raw', 'full_take');
  const aggregatesByAlgorithm = Object.fromEntries(
    ALGORITHMS.map((algorithm) => [algorithm, computeAggregate(rawFull.filter((row) => row.algorithm === algorithm))])
  );
  const aggregatesByAlgorithmAndTimeWindow = Object.fromEntries(
    TIME_WINDOWS.map((window) => [
      window.id,
      Object.fromEntries(
        ALGORITHMS.map((algorithm) => [
          algorithm,
          computeAggregate(selectRows(diagnosticRows, 'raw', window.id).filter((row) => row.algorithm === algorithm))
        ])
      )
    ])
  );
  const errorTypeDistribution = Object.fromEntries(
    ALGORITHMS.map((algorithm) => [
      algorithm,
      countBy(rawFull.filter((row) => row.algorithm === algorithm).map((row) => row.classifiedErrorType))
    ])
  );
  const unstableNotes = [...takeConsistencyRows]
    .sort((left, right) => right.unstableScore - left.unstableScore)
    .slice(0, 30);
  const doc = {
    generatedAtIso: new Date().toISOString(),
    datasetPath: DATASET_ROOT,
    datasetPathWindows: WINDOWS_DATASET_ROOT,
    frontends: FRONTENDS.map((frontend) => frontend.id),
    timeWindows: TIME_WINDOWS,
    algorithms: [...ALGORITHMS],
    dataset: {
      expectedFileCount: EXPECTED_FILE_COUNT,
      discoveredRows: datasetRows.length,
      stringsCovered: uniqueSorted(datasetRows.map((row) => row.stringId)),
      fretsCovered: uniqueSorted(datasetRows.map((row) => row.fret))
    },
    datasetIntegrity,
    rawFullTakeAggregates: aggregatesByAlgorithm,
    aggregatesByAlgorithmAndTimeWindow,
    errorTypeDistribution,
    lowMidHighByAlgorithm,
    takeConsistency: {
      rows: takeConsistencyRows,
      unstableTop: unstableNotes
    },
    rankings,
    audits: {
      masp: maspAudit,
      pyin: pyinAudit
    },
    rows: diagnosticRows
  };
  const json = `${JSON.stringify(doc, null, 2)}\n`;
  const csv = `${buildDiagnosticCsv(rawFull)}\n`;
  await fs.writeFile(path.join(outputDir, 'results.json'), json, 'utf8');
  await fs.writeFile(path.join(outputDir, 'results.csv'), csv, 'utf8');
}

function buildMaspAudit(diagnosticRows: DiagnosticRow[]): MaspAudit {
  const maspRows = selectRows(diagnosticRows, 'raw', 'full_take').filter((row) => row.algorithm === 'MASP');
  const modeCounts = new Map<string, number>();
  for (const row of maspRows) {
    const key = row.dominantDebugResampleMode ?? 'unknown';
    modeCounts.set(key, (modeCounts.get(key) ?? 0) + 1);
  }
  const errorCounts = new Map<string, number>();
  for (const row of maspRows) {
    errorCounts.set(row.classifiedErrorType, (errorCounts.get(row.classifiedErrorType) ?? 0) + 1);
  }
  return {
    observedSampleRates: uniqueSorted(maspRows.map((row) => row.sampleRate)),
    dominantResampleModes: Object.fromEntries([...modeCounts.entries()].sort((a, b) => b[1] - a[1])),
    sourceFrameSamples: FRAME_SIZE,
    strictFrameSamples: FRAME_SIZE,
    sourceDurationMsAt48k: roundNumber((FRAME_SIZE / 48000) * 1000, 3),
    interpretedDurationMsAt22050: roundNumber((FRAME_SIZE / 22050) * 1000, 3),
    durationStretchFactorAt48k: roundNumber((FRAME_SIZE / 22050) / (FRAME_SIZE / 48000), 6),
    effectiveFrequencyScaleFactorAt48k: roundNumber(22050 / 48000, 6),
    rawFullTakeAccuracy: roundNullable(computeAggregate(maspRows).pitchAccuracy50Cents, 6),
    rawFullTakeMedianSignedCents: computeAggregate(maspRows).medianSignedCentsError,
    dominantErrorTypes: Object.fromEntries([...errorCounts.entries()].sort((a, b) => b[1] - a[1])),
    note: 'MASP normalizes every frame to a target RMS internally, so scale is unlikely to be the main issue. The stronger evidence is a wrapper-level sample-rate mismatch: 48 kHz frames are remapped into a 22.05 kHz analysis without preserving duration.'
  };
}

function buildPyinAudit(
  diagnosticRows: DiagnosticRow[],
  pyinTraces: Map<string, PyinTrace>,
  cliPath: string
): PyinAudit {
  const rawFull = selectRows(diagnosticRows, 'raw', 'full_take');
  const pyinRows = rawFull.filter((row) => row.algorithm === 'pyin');
  const lowRows = pyinRows.filter((row) => row.stringId >= 5);
  const traces = [...pyinTraces.values()];
  return {
    cliPath,
    runCount: traces.length,
    observedInputSampleRates: uniqueSorted(traces.map((trace) => trace.inputSampleRate)),
    observedRuntimeSampleRates: uniqueSorted(traces.map((trace) => trace.runtimeSampleRate)),
    anyResampledInput: traces.some((trace) => trace.resampled),
    configuredBlockSize: traces[0]?.runtimeBlockSize ?? PYIN_BLOCK_SIZE,
    configuredCallbackSize: traces[0]?.runtimeCallbackSize ?? PYIN_CALLBACK_SIZE,
    configuredHopSize: traces[0]?.runtimeHopSize ?? PYIN_BLOCK_SIZE,
    inferredFrameLength: traces[0]?.inferredFrameLength ?? PYIN_BLOCK_SIZE,
    fminHz: traces[0]?.fminHz ?? 82.40689,
    fmaxHz: traces[0]?.fmaxHz ?? 1200,
    unvoicedRepresentation: '`pitch_hz=null`, `midi_estimate=null`, `reason="pyin_unvoiced"`',
    noDetectionBehavior: 'Window is marked as no-detection when no accepted pYIN frame exists in that window.',
    rawFullTakeAccuracy: roundNullable(computeAggregate(pyinRows).pitchAccuracy50Cents, 6),
    rawLowStringAccuracy: roundNullable(computeAggregate(lowRows).pitchAccuracy50Cents, 6),
    rawLowStringNoDetectionRate: roundNullable(computeAggregate(lowRows).noDetectionRate, 6),
    rawLowStringMedianSignedCents: computeAggregate(lowRows).medianSignedCentsError,
    note: 'pYIN is run via native host runtime CLI with explicit block/callback size equal to 4096 samples and no explicit sample-rate override.'
  };
}

function buildTakeConsistencyRows(diagnosticRows: DiagnosticRow[]): TakeConsistencyRow[] {
  const rawFull = selectRows(diagnosticRows, 'raw', 'full_take');
  const out: TakeConsistencyRow[] = [];
  for (const algorithm of ALGORITHMS) {
    const algorithmRows = rawFull.filter((row) => row.algorithm === algorithm);
    const grouped = new Map<string, DiagnosticRow[]>();
    for (const row of algorithmRows) {
      const key = `${row.stringId}:${row.fret}`;
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }
    for (const [key, rows] of grouped.entries()) {
      const [stringId, fret] = key.split(':').map(Number);
      const sorted = [...rows].sort((left, right) => left.take - right.take);
      const cents = sorted.map((row) => row.centsError).filter((value): value is number => value !== null);
      const noDetectionCount = sorted.filter((row) => row.classifiedErrorType === 'no_detection').length;
      const consistencyRate = sorted.length > 0
        ? sorted.filter((row) => row.classifiedErrorType === 'correct_within_50c').length / sorted.length
        : 0;
      const predictedMidis = sorted.map((row) => row.predictionMidi).filter((value): value is number => value !== null);
      const roundedNotes = predictedMidis.map((value) => Math.round(value));
      const octaves = predictedMidis.map((value) => Math.floor(value / 12));
      const sameNoteAgreementRate = pairwiseAgreementRate(roundedNotes);
      const sameOctaveAgreementRate = pairwiseAgreementRate(octaves);
      const std = standardDeviation(cents);
      const unstableScore =
        (std ?? 180) / 100 +
        (1 - consistencyRate) +
        (1 - (sameOctaveAgreementRate ?? 0));
      out.push({
        algorithm,
        stringId,
        fret,
        takeCount: sorted.length,
        meanCentsError: roundNullable(averageOrNull(cents), 3),
        stdCentsError: roundNullable(std, 3),
        consistencyRate: roundNumber(consistencyRate, 6),
        sameNoteAgreementRate: roundNullable(sameNoteAgreementRate, 6),
        sameOctaveAgreementRate: roundNullable(sameOctaveAgreementRate, 6),
        noDetectionCount,
        unstableScore: roundNumber(unstableScore, 6)
      });
    }
  }
  return out.sort((left, right) =>
    left.algorithm.localeCompare(right.algorithm) ||
    right.stringId - left.stringId ||
    left.fret - right.fret
  );
}

function buildLowMidHighMetrics(diagnosticRows: DiagnosticRow[]): Record<string, Record<string, AggregateMetrics>> {
  const rawFull = selectRows(diagnosticRows, 'raw', 'full_take');
  const groups: Array<{ id: 'low' | 'mid' | 'high'; includes: (stringId: number) => boolean }> = [
    { id: 'low', includes: (stringId) => stringId >= 5 },
    { id: 'mid', includes: (stringId) => stringId >= 3 && stringId <= 4 },
    { id: 'high', includes: (stringId) => stringId <= 2 }
  ];
  const out: Record<string, Record<string, AggregateMetrics>> = {};
  for (const algorithm of ALGORITHMS) {
    out[algorithm] = {};
    for (const group of groups) {
      out[algorithm][group.id] = computeAggregate(
        rawFull.filter((row) => row.algorithm === algorithm && group.includes(row.stringId))
      );
    }
  }
  return out;
}

function buildAlgorithmRankings(
  diagnosticRows: DiagnosticRow[],
  takeConsistencyRows: TakeConsistencyRow[],
  lowMidHighByAlgorithm: Record<string, Record<string, AggregateMetrics>>
): { overall: RankingEntry[]; lowFrequency: RankingEntry[] } {
  const rawFull = selectRows(diagnosticRows, 'raw', 'full_take');
  const entries: RankingEntry[] = ALGORITHMS.map((algorithm) => {
    const overallAggregate = computeAggregate(rawFull.filter((row) => row.algorithm === algorithm));
    const lowAggregate = lowMidHighByAlgorithm[algorithm].low;
    const stabilityRows = takeConsistencyRows.filter((row) => row.algorithm === algorithm);
    const stabilityScore = average(stabilityRows.map((row) => row.consistencyRate));
    return {
      algorithm,
      overallAccuracy: overallAggregate.pitchAccuracy50Cents,
      lowStringAccuracy: lowAggregate.pitchAccuracy50Cents,
      medianAbsCents: overallAggregate.medianAbsCentsError,
      stabilityScore,
      octaveErrorRate: overallAggregate.octaveUpRate + overallAggregate.octaveDownRate,
      lowStringNoDetectionRate: lowAggregate.noDetectionRate,
      compositeRankScore: 0
    };
  });
  const rankAccuracy = rankingMap(entries, (entry) => entry.overallAccuracy, true);
  const rankLow = rankingMap(entries, (entry) => entry.lowStringAccuracy, true);
  const rankMedian = rankingMap(entries, (entry) => entry.medianAbsCents ?? Number.POSITIVE_INFINITY, false);
  const rankStability = rankingMap(entries, (entry) => entry.stabilityScore, true);
  const rankOctave = rankingMap(entries, (entry) => entry.octaveErrorRate, false);
  for (const entry of entries) {
    entry.compositeRankScore =
      rankAccuracy.get(entry.algorithm)! +
      rankLow.get(entry.algorithm)! +
      rankMedian.get(entry.algorithm)! +
      rankStability.get(entry.algorithm)! +
      rankOctave.get(entry.algorithm)!;
  }
  const overall = [...entries].sort((left, right) =>
    left.compositeRankScore - right.compositeRankScore ||
    right.overallAccuracy - left.overallAccuracy
  );
  const lowFrequency = [...entries].sort((left, right) =>
    right.lowStringAccuracy - left.lowStringAccuracy ||
    left.lowStringNoDetectionRate - right.lowStringNoDetectionRate ||
    compareNullable(left.medianAbsCents, right.medianAbsCents)
  );
  return { overall, lowFrequency };
}

function rankingMap(
  entries: RankingEntry[],
  valueOf: (entry: RankingEntry) => number,
  descending: boolean
): Map<string, number> {
  const sorted = [...entries].sort((left, right) => {
    const leftValue = valueOf(left);
    const rightValue = valueOf(right);
    return descending ? rightValue - leftValue : leftValue - rightValue;
  });
  return new Map(sorted.map((entry, index) => [entry.algorithm, index + 1]));
}

function pairwiseAgreementRate(values: number[]): number | null {
  if (values.length < 2) return null;
  let pairs = 0;
  let equalPairs = 0;
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      pairs += 1;
      if (values[i] === values[j]) equalPairs += 1;
    }
  }
  return pairs > 0 ? equalPairs / pairs : null;
}

function standardDeviation(values: number[]): number | null {
  if (values.length <= 1) return null;
  const mu = average(values);
  const variance = average(values.map((value) => (value - mu) ** 2));
  return Math.sqrt(variance);
}

function averageOrNull(values: number[]): number | null {
  if (values.length <= 0) return null;
  return average(values);
}

function compareNullable(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

async function writePlots(plotsDir: string, diagnosticRows: DiagnosticRow[], featuresRows: TakeFeaturesRow[]): Promise<void> {
  const rawFull = selectRows(diagnosticRows, 'raw', 'full_take');
  await fs.writeFile(path.join(plotsDir, 'accuracy_by_algorithm.svg'), buildMetricByAlgorithmSvg(rawFull, 'Pitch Accuracy within ±50 cents (RAW/full_take)', (aggregate) => aggregate.pitchAccuracy50Cents, { isPercent: true }), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'median_cents_error_by_algorithm.svg'), buildMetricByAlgorithmSvg(rawFull, 'Median absolute cents error (RAW/full_take)', (aggregate) => aggregate.medianAbsCentsError ?? 0, { isPercent: false, unit: 'c' }), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'no_detection_rate_by_algorithm.svg'), buildMetricByAlgorithmSvg(rawFull, 'No-detection rate (RAW/full_take)', (aggregate) => aggregate.noDetectionRate, { isPercent: true }), 'utf8');
  for (const algorithm of ALGORITHMS) {
    const rows = rawFull.filter((row) => row.algorithm === algorithm);
    await fs.writeFile(path.join(plotsDir, `rms_vs_correctness_${sanitizeFileSegment(algorithm)}.svg`), buildBinaryScatterSvg(rows, 'full_rms', `RMS vs correctness: ${algorithm}`, 'Full-take RMS'), 'utf8');
    await fs.writeFile(path.join(plotsDir, `f0_vs_h2_ratio_${sanitizeFileSegment(algorithm)}.svg`), buildBinaryScatterSvg(rows, 'full_fund_to_2harm_ratio_db', `Fundamental vs 2nd harmonic ratio: ${algorithm}`, 'Fund/H2 ratio (dB)'), 'utf8');
  }
  await fs.writeFile(path.join(plotsDir, 'accuracy_by_time_window.svg'), buildGroupedAccuracySvg(diagnosticRows, 'raw', 'timeWindowVariant', TIME_WINDOWS.map((item) => item.id), TIME_WINDOWS.map((item) => item.label), 'Accuracy by time-window variant (RAW)'), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'error_type_distribution.svg'), buildErrorTypeDistributionSvg(rawFull), 'utf8');
  await fs.writeFile(path.join(plotsDir, 'failure_rate_vs_frequency.svg'), buildFailureRateVsFrequencySvg(rawFull), 'utf8');
  const cases = chooseRepresentativeCases(rawFull, featuresRows);
  for (let index = 0; index < cases.length; index += 1) {
    await fs.writeFile(path.join(plotsDir, `representative_case_${index + 1}_${sanitizeFileSegment(cases[index].algorithm)}.svg`), buildRepresentativeCaseSvg(cases[index]), 'utf8');
  }
}

async function writeSummary(
  outputDir: string,
  datasetRows: DatasetRow[],
  diagnosticRows: DiagnosticRow[],
  datasetIntegrity: DatasetIntegrityReport,
  maspAudit: MaspAudit,
  pyinAudit: PyinAudit,
  takeConsistencyRows: TakeConsistencyRow[],
  lowMidHighByAlgorithm: Record<string, Record<string, AggregateMetrics>>,
  rankings: { overall: RankingEntry[]; lowFrequency: RankingEntry[] }
): Promise<void> {
  const rawFull = selectRows(diagnosticRows, 'raw', 'full_take');
  const accuracyByAlgorithm = Object.fromEntries(ALGORITHMS.map((algorithm) => [algorithm, computeAggregate(rawFull.filter((row) => row.algorithm === algorithm))]));
  const lowStringAccuracy = Object.fromEntries(ALGORITHMS.map((algorithm) => [algorithm, lowMidHighByAlgorithm[algorithm].low]));
  const correlations = Object.fromEntries(ALGORITHMS.map((algorithm) => {
    const rows = rawFull.filter((row) => row.algorithm === algorithm);
    return [algorithm, {
      rms: computeCorrelationSummary(rows.map((row) => row.full_rms), rows.map((row) => row.isSuccess ? 1 : 0), rows.map((row) => row.absCentsError)),
      fund_h2: computeCorrelationSummary(rows.map((row) => row.full_fund_to_2harm_ratio_db), rows.map((row) => row.isSuccess ? 1 : 0), rows.map((row) => row.absCentsError))
    }];
  }));
  const onsetSkips = Object.fromEntries(ALGORITHMS.map((algorithm) => [algorithm, computeAggregate(selectRows(diagnosticRows, 'raw', 'onset_skipped_window').filter((row) => row.algorithm === algorithm)).pitchAccuracy50Cents - accuracyByAlgorithm[algorithm].pitchAccuracy50Cents]));
  const sustain = Object.fromEntries(ALGORITHMS.map((algorithm) => [algorithm, computeAggregate(selectRows(diagnosticRows, 'raw', 'sustain_window').filter((row) => row.algorithm === algorithm)).pitchAccuracy50Cents - accuracyByAlgorithm[algorithm].pitchAccuracy50Cents]));
  const center = Object.fromEntries(ALGORITHMS.map((algorithm) => [algorithm, computeAggregate(selectRows(diagnosticRows, 'raw', 'center_window').filter((row) => row.algorithm === algorithm)).pitchAccuracy50Cents - accuracyByAlgorithm[algorithm].pitchAccuracy50Cents]));
  const sustainLong = Object.fromEntries(ALGORITHMS.map((algorithm) => [algorithm, computeAggregate(selectRows(diagnosticRows, 'raw', 'sustain_long_window').filter((row) => row.algorithm === algorithm)).pitchAccuracy50Cents - accuracyByAlgorithm[algorithm].pitchAccuracy50Cents]));
  const stringsCovered = uniqueSorted(datasetRows.map((row) => row.stringId));
  const fretsCovered = uniqueSorted(datasetRows.map((row) => row.fret));
  const unstableTop = [...takeConsistencyRows].sort((left, right) => right.unstableScore - left.unstableScore).slice(0, 12);
  const missingList = datasetIntegrity.missingCombos.map((item) => `(string=${item.stringId}, fret=${item.fret}, take=${item.take})`);

  const summary = [
    '# PitchDebug RAW-Only Evaluation',
    '',
    '## Dataset Recap',
    '',
    `- Exact dataset path used: \`${WINDOWS_DATASET_ROOT}\``,
    `- WAV files analyzed: ${rawFull.filter((row) => row.algorithm === 'ac14').length}`,
    `- Expected files: ${EXPECTED_FILE_COUNT}`,
    `- Discovered WAV files: ${datasetIntegrity.discoveredWavCount}`,
    `- Strings covered: ${stringsCovered.join(', ')}`,
    `- Frets covered: ${fretsCovered.join(', ')}`,
    `- Algorithms evaluated: ${ALGORITHMS.join(', ')}`,
    '',
    '## Dataset Integrity',
    '',
    `- Missing combinations: ${datasetIntegrity.missingCombos.length}`,
    `- Duplicate combinations: ${datasetIntegrity.duplicateCombos.length}`,
    `- Corrupted WAV files: ${datasetIntegrity.corruptedFiles.length}`,
    ...(datasetIntegrity.missingCombos.length === 0
      ? ['- Missing list: none']
      : [`- Missing list: ${missingList.join(', ')}`]),
    ...(datasetIntegrity.duplicateCombos.length === 0
      ? ['- Duplicate list: none']
      : [`- Duplicate list: ${datasetIntegrity.duplicateCombos.map((item) => `(string=${item.stringId}, fret=${item.fret}, take=${item.take})`).join(', ')}`]),
    ...(datasetIntegrity.corruptedFiles.length === 0
      ? ['- Corrupted file list: none']
      : [`- Corrupted file list: ${datasetIntegrity.corruptedFiles.map((item) => `${item.relativeFilePath} (${item.error})`).join('; ')}`]),
    '',
    '## RAW-Only Benchmark Results',
    '',
    '| Algorithm | ±50c Accuracy | Median Abs Cents | No-detection | Octave Up | Octave Down | Harmonic-related |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...ALGORITHMS.map((algorithm) => {
      const metrics = accuracyByAlgorithm[algorithm];
      return `| ${algorithm} | ${formatPct(metrics.pitchAccuracy50Cents)} | ${formatNullable(metrics.medianAbsCentsError, 2, 'c')} | ${formatPct(metrics.noDetectionRate)} | ${formatPct(metrics.octaveUpRate)} | ${formatPct(metrics.octaveDownRate)} | ${formatPct(metrics.harmonicRelatedRate)} |`;
    }),
    '',
    '## RAW-Only Diagnostics',
    '',
    `- Correlation with correctness: RMS is weaker than fund/H2 ratio for ${ALGORITHMS.filter((algorithm) => Math.abs(correlations[algorithm].fund_h2.pearson_success ?? 0) > Math.abs(correlations[algorithm].rms.pearson_success ?? 0)).join(', ')}.`,
    `- Time-window delta vs full_take: ${ALGORITHMS.map((algorithm) => `${algorithm} center ${formatPct(center[algorithm], true)}, sustain ${formatPct(sustain[algorithm], true)}, onset-skipped ${formatPct(onsetSkips[algorithm], true)}, sustain-long ${formatPct(sustainLong[algorithm], true)}`).join('; ')}.`,
    `- Low strings (5-6) remain hardest: ${ALGORITHMS.map((algorithm) => `${algorithm} ${formatPct(lowStringAccuracy[algorithm].pitchAccuracy50Cents)} accuracy, ${formatPct(lowStringAccuracy[algorithm].noDetectionRate)} no-detect`).join('; ')}.`,
    '',
    '## Low/Mid/High String Groups',
    '',
    '| Algorithm | Group | Accuracy ±50c | Median Abs Cents | Octave Error | No-detection |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...ALGORITHMS.flatMap((algorithm) => ['low', 'mid', 'high'].map((group) => {
      const metrics = lowMidHighByAlgorithm[algorithm][group];
      return `| ${algorithm} | ${group} | ${formatPct(metrics.pitchAccuracy50Cents)} | ${formatNullable(metrics.medianAbsCentsError, 2, 'c')} | ${formatPct(metrics.octaveUpRate + metrics.octaveDownRate)} | ${formatPct(metrics.noDetectionRate)} |`;
    })),
    '',
    '## Take Consistency',
    '',
    '| Algorithm | String | Fret | Mean Cents | Std Cents | Consistency (0..1) | Same-note Agreement | Same-octave Agreement |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...unstableTop.map((row) => `| ${row.algorithm} | ${row.stringId} | ${row.fret} | ${formatNullable(row.meanCentsError, 2, 'c')} | ${formatNullable(row.stdCentsError, 2, 'c')} | ${row.consistencyRate.toFixed(2)} | ${formatNullable(row.sameNoteAgreementRate, 2, '')} | ${formatNullable(row.sameOctaveAgreementRate, 2, '')} |`),
    '',
    '## Correlations (RAW/full_take)',
    '',
    '| Algorithm | Corr(success, RMS) | Corr(success, fund/H2 dB) | Corr(abs cents, RMS) | Corr(abs cents, fund/H2 dB) |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...ALGORITHMS.map((algorithm) => `| ${algorithm} | ${formatNullableSigned(correlations[algorithm].rms.pearson_success)} | ${formatNullableSigned(correlations[algorithm].fund_h2.pearson_success)} | ${formatNullableSigned(correlations[algorithm].rms.pearson_abs_cents)} | ${formatNullableSigned(correlations[algorithm].fund_h2.pearson_abs_cents)} |`),
    '',
    '## Integration Audit Notes',
    '',
    `- MASP wrapper status: dominant mode is ${Object.keys(maspAudit.dominantResampleModes)[0] ?? 'unknown'}, observed sample rates ${maspAudit.observedSampleRates.join(', ')} Hz, effective frequency-scale factor at 48k is ${maspAudit.effectiveFrequencyScaleFactorAt48k.toFixed(3)}.`,
    '- MASP remaining uncertainty: wrapper alignment must be re-verified after duration-preserving resample fix.',
    `- pYIN wrapper status: input sample rates ${pyinAudit.observedInputSampleRates.join(', ')} Hz, runtime sample rates ${pyinAudit.observedRuntimeSampleRates.join(', ')} Hz, resampling applied = ${pyinAudit.anyResampledInput}.`,
    `- pYIN runtime settings: block/hop=${pyinAudit.configuredBlockSize}/${pyinAudit.configuredHopSize} samples, inferred frame length=${pyinAudit.inferredFrameLength}, fmin=${pyinAudit.fminHz.toFixed(5)} Hz, fmax=${pyinAudit.fmaxHz.toFixed(1)} Hz.`,
    `- pYIN unvoiced handling: ${pyinAudit.unvoicedRepresentation}.`,
    `- pYIN shared mapping: median over accepted frame-level frequencies per window, then mapped to shared cents-error format.`,
    '',
    '## Global Ranking',
    '',
    `- Overall ranking: ${rankings.overall.map((entry) => entry.algorithm).join(' > ')}`,
    `- Low-frequency ranking (priority): ${rankings.lowFrequency.map((entry) => entry.algorithm).join(' > ')}`,
    '',
    '## Recommendations',
    '',
    '1. Prioritize wrapper/integration correctness before detector retuning, especially MASP sample-rate/duration handling.',
    '2. Prioritize low-note harmonic disambiguation (strings 5-6) using RAW-only diagnostics as canonical evidence.',
    '3. Keep RAW-only benchmark as the authoritative comparison for this phase; filtered frontends stay out of headline metrics.',
    '4. After MASP wrapper fix, rerun this exact RAW-only suite unchanged to isolate wrapper effects.',
    '',
    '## Output Files',
    '',
    '- `results.csv`',
    '- `results.json`',
    '- `features_per_take.csv`',
    '- `features_per_take.json`',
    '- `plots/`',
    ''
  ].join('\n');

  await fs.writeFile(path.join(outputDir, 'summary.md'), summary, 'utf8');
}

function chooseRepresentativeCases(rawFull: DiagnosticRow[], featuresRows: TakeFeaturesRow[]): Array<{ row: DiagnosticRow; feature: TakeFeaturesRow; algorithm: string }> {
  const byFile = new Map(featuresRows.map((row) => [row.fileId, row]));
  const candidates = rawFull
    .filter((row) => row.classifiedErrorType !== 'correct_within_50c')
    .sort((a, b) => (a.groundTruthFrequencyHz - b.groundTruthFrequencyHz) || ((b.absCentsError ?? 0) - (a.absCentsError ?? 0)));
  const selected: Array<{ row: DiagnosticRow; feature: TakeFeaturesRow; algorithm: string }> = [];
  const used = new Set<string>();
  for (const row of candidates) {
    if (used.has(row.fileId)) continue;
    const feature = byFile.get(row.fileId);
    if (!feature) continue;
    selected.push({ row, feature, algorithm: row.algorithm });
    used.add(row.fileId);
    if (selected.length >= 3) break;
  }
  return selected;
}

function buildRepresentativeCaseSvg(caseInfo: { row: DiagnosticRow; feature: TakeFeaturesRow; algorithm: string }): string {
  const width = 860;
  const height = 420;
  const margin = { left: 60, right: 20, top: 50, bottom: 50 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const segment = caseInfo.feature.segments.center;
  const energies: Array<[string, number]> = [
    ['20-50', segment.energy_20_50_hz],
    ['50-90', segment.energy_50_90_hz],
    ['80-120', segment.energy_80_120_hz],
    ['120-250', segment.energy_120_250_hz],
    ['250-500', segment.energy_250_500_hz],
    ['500-1000', segment.energy_500_1000_hz],
    ['1000-2000', segment.energy_1000_2000_hz]
  ];
  const maxValue = Math.max(...energies.map(([, value]) => value), 1);
  const xBand = bandScale(energies.map(([label]) => label), margin.left, margin.left + innerWidth, 0.18);
  const y = linearScale(0, maxValue, margin.top + innerHeight, margin.top);
  const f0x = markerPosition(caseInfo.row.groundTruthFrequencyHz, 20, 2000, margin.left, margin.left + innerWidth);
  const h2x = markerPosition(caseInfo.row.groundTruthFrequencyHz * 2, 20, 2000, margin.left, margin.left + innerWidth);
  const h3x = markerPosition(caseInfo.row.groundTruthFrequencyHz * 3, 20, 2000, margin.left, margin.left + innerWidth);
  const elements = [svgHeader(width, height), `<rect width="${width}" height="${height}" fill="#08111f" />`];
  elements.push(`<text x="${margin.left}" y="28" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Representative failure: ${escapeXml(caseInfo.row.fileId)} / ${escapeXml(caseInfo.algorithm)}</text>`);
  elements.push(`<text x="${margin.left}" y="46" fill="#94a3b8" font-size="12" font-family="Arial, sans-serif">GT ${caseInfo.row.groundTruthNote} ${caseInfo.row.groundTruthFrequencyHz.toFixed(2)} Hz | prediction ${caseInfo.row.predictionNote ?? 'none'} ${caseInfo.row.predictionHz?.toFixed(2) ?? '-'} Hz | ${caseInfo.row.classifiedErrorType}</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  for (const [label, value] of energies) {
    const x0 = xBand.positionForValue(label) ?? margin.left;
    elements.push(`<rect x="${x0.toFixed(2)}" y="${y(value).toFixed(2)}" width="${(xBand.bandWidth - 2).toFixed(2)}" height="${(margin.top + innerHeight - y(value)).toFixed(2)}" fill="#38bdf8" fill-opacity="0.8" />`);
    elements.push(`<text x="${(x0 + xBand.bandWidth / 2).toFixed(2)}" y="${height - 16}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${label}</text>`);
  }
  elements.push(`<line x1="${f0x.toFixed(2)}" y1="${margin.top}" x2="${f0x.toFixed(2)}" y2="${margin.top + innerHeight}" stroke="#22c55e" stroke-dasharray="4 4" />`);
  elements.push(`<line x1="${h2x.toFixed(2)}" y1="${margin.top}" x2="${h2x.toFixed(2)}" y2="${margin.top + innerHeight}" stroke="#f59e0b" stroke-dasharray="4 4" />`);
  elements.push(`<line x1="${h3x.toFixed(2)}" y1="${margin.top}" x2="${h3x.toFixed(2)}" y2="${margin.top + innerHeight}" stroke="#f43f5e" stroke-dasharray="4 4" />`);
  elements.push(`<text x="${f0x.toFixed(2)}" y="${margin.top + 14}" fill="#22c55e" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">f0</text>`);
  elements.push(`<text x="${h2x.toFixed(2)}" y="${margin.top + 28}" fill="#f59e0b" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">2f0</text>`);
  elements.push(`<text x="${h3x.toFixed(2)}" y="${margin.top + 42}" fill="#f43f5e" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">3f0</text>`);
  elements.push('</svg>');
  return elements.join('\n');
}

function buildHpfAuditSvg(rawFrame: Float32Array, legacyFrame: Float32Array, continuousFrame: Float32Array, sampleRate: number, fileId: string): string {
  const width = 960;
  const height = 560;
  const mid = 280;
  const header = [svgHeader(width, height), `<rect width="${width}" height="${height}" fill="#08111f" />`];
  header.push(`<text x="50" y="28" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">HPF50/LPF2000 audit: ${escapeXml(fileId)}</text>`);
  header.push(`<text x="50" y="46" fill="#94a3b8" font-size="12" font-family="Arial, sans-serif">Raw vs legacy frame-local wrapper vs continuous same-coefficient reference | ${sampleRate} Hz</text>`);
  header.push(buildWaveformPanel(rawFrame, 50, 70, 860, 170, '#38bdf8', 'Raw frame'));
  header.push(buildWaveformPanel(legacyFrame, 50, mid, 860, 110, '#f43f5e', 'Legacy frame-local HPF50/LPF2000'));
  header.push(buildWaveformPanel(continuousFrame, 50, mid + 140, 860, 110, '#22c55e', 'Continuous same-coefficient reference'));
  header.push('</svg>');
  return header.join('\n');
}

function buildWaveformPanel(samples: Float32Array, x: number, y: number, width: number, height: number, color: string, label: string): string {
  const elements = [`<text x="${x}" y="${y - 10}" fill="#cbd5e1" font-size="12" font-family="Arial, sans-serif">${escapeXml(label)}</text>`, `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#0f172a" stroke="#334155" />`];
  const centerY = y + height / 2;
  const path: string[] = [];
  const shown = Math.min(samples.length, 512);
  for (let i = 0; i < shown; i += 1) {
    const px = x + (i / Math.max(1, shown - 1)) * width;
    const py = centerY - samples[i] * (height * 0.42);
    path.push(`${i === 0 ? 'M' : 'L'} ${px.toFixed(2)} ${py.toFixed(2)}`);
  }
  elements.push(`<path d="${path.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" />`);
  return elements.join('\n');
}

function buildBinaryScatterSvg(rows: DiagnosticRow[], xField: 'full_rms' | 'full_fund_to_2harm_ratio_db', title: string, xLabel: string): string {
  const width = 880;
  const height = 460;
  const margin = { left: 70, right: 20, top: 50, bottom: 60 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const xValues = rows.map((row) => row[xField]);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const x = linearScale(minX, maxX === minX ? minX + 1 : maxX, margin.left, margin.left + innerWidth);
  const y = linearScale(0, 1, margin.top + innerHeight, margin.top);
  const elements = [svgHeader(width, height), `<rect width="${width}" height="${height}" fill="#08111f" />`];
  elements.push(`<text x="${margin.left}" y="30" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">${escapeXml(title)}</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  for (const row of rows) {
    const py = y(row.isSuccess ? 1 : 0) + ((hashString(row.fileId + row.algorithm) % 9) - 4);
    elements.push(`<circle cx="${x(row[xField]).toFixed(2)}" cy="${py.toFixed(2)}" r="4.5" fill="${row.isSuccess ? '#22c55e' : '#f43f5e'}" fill-opacity="0.85" />`);
  }
  elements.push(`<text x="${(margin.left + width - margin.right) / 2}" y="${height - 18}" fill="#cbd5e1" font-size="12" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(xLabel)}</text>`);
  elements.push(`<text x="18" y="${(margin.top + margin.top + innerHeight) / 2}" fill="#cbd5e1" font-size="12" text-anchor="middle" font-family="Arial, sans-serif" transform="rotate(-90 18 ${(margin.top + margin.top + innerHeight) / 2})">Correctness</text>`);
  elements.push(`<text x="${margin.left - 10}" y="${y(1)}" fill="#94a3b8" font-size="11" text-anchor="end" dominant-baseline="middle" font-family="Arial, sans-serif">correct</text>`);
  elements.push(`<text x="${margin.left - 10}" y="${y(0)}" fill="#94a3b8" font-size="11" text-anchor="end" dominant-baseline="middle" font-family="Arial, sans-serif">incorrect</text>`);
  elements.push('</svg>');
  return elements.join('\n');
}

function buildMetricByAlgorithmSvg(
  rawFull: DiagnosticRow[],
  title: string,
  metricOf: (aggregate: AggregateMetrics) => number,
  options: { isPercent: boolean; unit?: string }
): string {
  const width = 920;
  const height = 460;
  const margin = { left: 80, right: 20, top: 50, bottom: 70 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const algorithmScale = bandScale(ALGORITHMS.map(String), margin.left, margin.left + innerWidth, 0.3);
  const metrics = ALGORITHMS.map((algorithm) => {
    const aggregate = computeAggregate(rawFull.filter((row) => row.algorithm === algorithm));
    return { algorithm, value: metricOf(aggregate) };
  });
  const maxValue = options.isPercent ? 1 : Math.max(1, ...metrics.map((item) => item.value));
  const y = linearScale(0, maxValue, margin.top + innerHeight, margin.top);
  const elements = [svgHeader(width, height), `<rect width="${width}" height="${height}" fill="#08111f" />`];
  elements.push(`<text x="${margin.left}" y="30" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">${escapeXml(title)}</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  for (const item of metrics) {
    const x0 = algorithmScale.positionForValue(item.algorithm) ?? margin.left;
    const barTop = y(item.value);
    const barHeight = margin.top + innerHeight - barTop;
    elements.push(`<rect x="${x0.toFixed(2)}" y="${barTop.toFixed(2)}" width="${(algorithmScale.bandWidth - 2).toFixed(2)}" height="${barHeight.toFixed(2)}" fill="${colorForAlgorithm(item.algorithm)}" fill-opacity="0.85" />`);
    const label = options.isPercent
      ? formatPct(item.value)
      : `${item.value.toFixed(1)}${options.unit ?? ''}`;
    elements.push(`<text x="${(x0 + algorithmScale.bandWidth / 2).toFixed(2)}" y="${(barTop - 6).toFixed(2)}" fill="#cbd5e1" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(label)}</text>`);
    elements.push(`<text x="${(x0 + algorithmScale.bandWidth / 2).toFixed(2)}" y="${height - 18}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(item.algorithm)}</text>`);
  }
  elements.push('</svg>');
  return elements.join('\n');
}

function buildGroupedAccuracySvg(
  diagnosticRows: DiagnosticRow[],
  fixedValue: string,
  varyingField: 'timeWindowVariant' | 'frontend',
  ids: string[],
  labels: string[],
  title: string
): string {
  const width = 980;
  const height = 520;
  const margin = { left: 70, right: 20, top: 50, bottom: 90 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const groups = ids.map((id, index) => ({ id, label: labels[index] ?? id }));
  const groupScale = bandScale(groups.map((group) => group.id), margin.left, margin.left + innerWidth, 0.2);
  const subScale = bandScale(ALGORITHMS.map(String), 0, groupScale.bandWidth, 0.1);
  const y = linearScale(0, 1, margin.top + innerHeight, margin.top);
  const elements = [svgHeader(width, height), `<rect width="${width}" height="${height}" fill="#08111f" />`];
  elements.push(`<text x="${margin.left}" y="30" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">${escapeXml(title)}</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  for (const group of groups) {
    const x0 = groupScale.positionForValue(group.id) ?? margin.left;
    const rows = varyingField === 'timeWindowVariant'
      ? diagnosticRows.filter((row) => row.frontend === fixedValue && row.timeWindowVariant === group.id)
      : diagnosticRows.filter((row) => row.timeWindowVariant === fixedValue && row.frontend === group.id);
    for (const algorithm of ALGORITHMS) {
      const algorithmRows = rows.filter((row) => row.algorithm === algorithm);
      const acc = computeAggregate(algorithmRows).pitchAccuracy50Cents;
      const subX = subScale.positionForValue(algorithm) ?? 0;
      elements.push(`<rect x="${(x0 + subX).toFixed(2)}" y="${y(acc).toFixed(2)}" width="${(subScale.bandWidth - 2).toFixed(2)}" height="${(margin.top + innerHeight - y(acc)).toFixed(2)}" fill="${colorForAlgorithm(algorithm)}" fill-opacity="0.8" />`);
    }
    elements.push(`<text x="${(x0 + groupScale.bandWidth / 2).toFixed(2)}" y="${height - 18}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(group.label)}</text>`);
  }
  elements.push(...buildLegend(ALGORITHMS.map((algorithm) => ({ label: algorithm, color: colorForAlgorithm(algorithm) })), width - 240, 70));
  elements.push('</svg>');
  return elements.join('\n');
}

function buildErrorTypeDistributionSvg(rawFull: DiagnosticRow[]): string {
  const width = 980;
  const height = 520;
  const margin = { left: 70, right: 20, top: 50, bottom: 70 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const groupScale = bandScale(ALGORITHMS.map(String), margin.left, margin.left + innerWidth, 0.4);
  const y = linearScale(0, 1, margin.top + innerHeight, margin.top);
  const errorTypes = [
    ['correct_within_50c', '#22c55e'],
    ['octave_up_error', '#38bdf8'],
    ['octave_down_error', '#6366f1'],
    ['harmonic_related_error', '#f59e0b'],
    ['near_miss_non_octave', '#eab308'],
    ['large_error', '#f97316'],
    ['no_detection', '#f43f5e'],
    ['invalid_output', '#94a3b8']
  ] as const;
  const elements = [svgHeader(width, height), `<rect width="${width}" height="${height}" fill="#08111f" />`];
  elements.push(`<text x="${margin.left}" y="30" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Error-type distribution (RAW/full_take)</text>`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top + innerHeight}" x2="${width - margin.right}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerHeight}" stroke="#475569" />`);
  for (const algorithm of ALGORITHMS) {
    const rows = rawFull.filter((row) => row.algorithm === algorithm);
    const x0 = groupScale.positionForValue(algorithm) ?? margin.left;
    let currentTop = margin.top + innerHeight;
    for (const [errorType, color] of errorTypes) {
      const ratio = rows.length > 0 ? rows.filter((row) => row.classifiedErrorType === errorType).length / rows.length : 0;
      const heightPx = (margin.top + innerHeight) - y(ratio);
      currentTop -= heightPx;
      elements.push(`<rect x="${x0.toFixed(2)}" y="${currentTop.toFixed(2)}" width="${(groupScale.bandWidth - 2).toFixed(2)}" height="${heightPx.toFixed(2)}" fill="${color}" />`);
    }
    elements.push(`<text x="${(x0 + groupScale.bandWidth / 2).toFixed(2)}" y="${height - 18}" fill="#94a3b8" font-size="11" text-anchor="middle" font-family="Arial, sans-serif">${algorithm}</text>`);
  }
  elements.push(...buildLegend(errorTypes.map(([label, color]) => ({ label, color })), width - 260, 70));
  elements.push('</svg>');
  return elements.join('\n');
}

function buildFailureRateVsFrequencySvg(rawFull: DiagnosticRow[]): string {
  const grouped = new Map<number, Record<string, number>>();
  for (const algorithm of ALGORITHMS) {
    for (const row of rawFull.filter((item) => item.algorithm === algorithm)) {
      const bucket = grouped.get(row.groundTruthFrequencyHz) ?? {};
      bucket[algorithm] = (bucket[algorithm] ?? 0) + (row.isFailure ? 1 : 0);
      bucket[`${algorithm}_count`] = (bucket[`${algorithm}_count`] ?? 0) + 1;
      grouped.set(row.groundTruthFrequencyHz, bucket);
    }
  }
  const frequencies = [...grouped.keys()].sort((a, b) => a - b);
  const width = 980;
  const height = 460;
  const margin = { left: 70, right: 20, top: 50, bottom: 60 };
  const x = linearScale(Math.min(...frequencies), Math.max(...frequencies), margin.left, width - margin.right);
  const y = linearScale(0, 1, height - margin.bottom, margin.top);
  const elements = [svgHeader(width, height), `<rect width="${width}" height="${height}" fill="#08111f" />`];
  elements.push(`<text x="${margin.left}" y="30" fill="#f8fafc" font-size="20" font-family="Arial, sans-serif">Failure rate vs ground-truth frequency (RAW/full_take)</text>`);
  elements.push(`<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#475569" />`);
  elements.push(`<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#475569" />`);
  for (const algorithm of ALGORITHMS) {
    const path: string[] = [];
    for (const frequency of frequencies) {
      const bucket = grouped.get(frequency) ?? {};
      const count = bucket[`${algorithm}_count`] ?? 0;
      const failRate = count > 0 ? (bucket[algorithm] ?? 0) / count : 0;
      path.push(`${path.length === 0 ? 'M' : 'L'} ${x(frequency).toFixed(2)} ${y(failRate).toFixed(2)}`);
    }
    elements.push(`<path d="${path.join(' ')}" fill="none" stroke="${colorForAlgorithm(algorithm)}" stroke-width="2.4" />`);
  }
  elements.push(...buildLegend(ALGORITHMS.map((algorithm) => ({ label: algorithm, color: colorForAlgorithm(algorithm) })), width - 240, 70));
  elements.push('</svg>');
  return elements.join('\n');
}

function buildFeaturesCsv(rows: TakeFeaturesRow[]): string {
  const segments = FEATURE_SEGMENTS.map((item) => item.id);
  const header = [
    'file_id', 'relative_file_path', 'string', 'fret', 'take', 'ground_truth_midi', 'ground_truth_note', 'ground_truth_frequency_hz', 'duration_sec', 'sample_rate', 'sample_count',
    ...segments.flatMap((segment) => [
      `${segment}_start_sec`, `${segment}_end_sec`, `${segment}_duration_sec`, `${segment}_rms`, `${segment}_peak_abs`, `${segment}_crest_factor`, `${segment}_mean`, `${segment}_dc_offset`,
      `${segment}_energy_20_50_hz`, `${segment}_energy_50_90_hz`, `${segment}_energy_80_120_hz`, `${segment}_energy_120_250_hz`, `${segment}_energy_250_500_hz`, `${segment}_energy_500_1000_hz`, `${segment}_energy_1000_2000_hz`,
      `${segment}_low_to_mid_ratio`, `${segment}_spectral_tilt_db`, `${segment}_fund_energy`, `${segment}_harmonic2_energy`, `${segment}_harmonic3_energy`,
      `${segment}_fund_to_2harm_ratio`, `${segment}_fund_to_2harm_ratio_db`, `${segment}_fund_to_3harm_ratio`, `${segment}_fund_to_3harm_ratio_db`,
      `${segment}_second_harmonic_stronger`, `${segment}_third_harmonic_stronger`, `${segment}_top_peak_hz`, `${segment}_top_peak2_hz`
    ])
  ];
  const csvRows = [header.join(',')];
  for (const row of rows) {
    const values: Array<string | number | boolean | null> = [
      row.fileId,
      row.relativeFilePath,
      row.stringId,
      row.fret,
      row.take,
      row.groundTruthMidi,
      row.groundTruthNote,
      row.groundTruthFrequencyHz,
      row.durationSec,
      row.sampleRate,
      row.sampleCount
    ];
    for (const segmentId of segments) {
      const segment = row.segments[segmentId];
      values.push(
        segment.startSec, segment.endSec, segment.durationSec, segment.rms, segment.peakAbs, segment.crestFactor, segment.mean, segment.dcOffset,
        segment.energy_20_50_hz, segment.energy_50_90_hz, segment.energy_80_120_hz, segment.energy_120_250_hz, segment.energy_250_500_hz, segment.energy_500_1000_hz, segment.energy_1000_2000_hz,
        segment.low_to_mid_ratio, segment.spectral_tilt_80_120_vs_500_1000_db, segment.fund_energy, segment.harmonic2_energy, segment.harmonic3_energy,
        segment.fund_to_2harm_ratio, segment.fund_to_2harm_ratio_db, segment.fund_to_3harm_ratio, segment.fund_to_3harm_ratio_db,
        segment.second_harmonic_stronger_than_fundamental, segment.third_harmonic_stronger_than_fundamental, segment.topPeakHz, segment.topPeak2Hz
      );
    }
    csvRows.push(values.map((value) => csvEscape(formatCsvValue(value))).join(','));
  }
  return csvRows.join('\n');
}

function buildDiagnosticCsv(rows: DiagnosticRow[]): string {
  const header = Object.keys(rows[0] ?? {
    fileId: '', relativeFilePath: '', stringId: 0, fret: 0, take: 0, sampleRate: 0, sampleCount: 0, durationSec: 0,
    groundTruthMidi: 0, groundTruthNote: '', groundTruthFrequencyHz: 0, algorithm: '', frontend: '', timeWindowVariant: '', windowStartSec: 0, windowEndSec: 0,
    windowDurationSec: 0, predictionHz: null, predictionMidi: null, predictionNote: null, confidence: null, acceptedFrameCount: 0, totalFrameCount: 0,
    acceptedFrameRate: 0, noDetection: false, invalidOutput: false, dominantRejectReason: null, dominantDebugResampleMode: null, centsError: null, absCentsError: null,
    classifiedErrorType: '', isSuccess: false, isFailure: false, full_rms: 0, full_peak_abs: 0, full_low_to_mid_ratio: 0, full_fund_to_2harm_ratio_db: 0,
    full_fund_to_3harm_ratio_db: 0, full_second_harmonic_stronger: false, window_rms: 0, window_peak_abs: 0, window_low_to_mid_ratio: 0,
    window_fund_to_2harm_ratio_db: 0, window_fund_to_3harm_ratio_db: 0, window_second_harmonic_stronger: false
  });
  const out = [header.join(',')];
  for (const row of rows) {
    out.push(header.map((key) => csvEscape(formatCsvValue((row as Record<string, unknown>)[key]))).join(','));
  }
  return out.join('\n');
}

function computeCorrelationSummary(feature: Array<number | null>, success: number[], absCents: Array<number | null>): CorrelationSummary {
  return {
    pearson_success: roundNullable(pearson(feature, success), 6),
    pearson_abs_cents: roundNullable(pearson(feature, absCents), 6)
  };
}

function pearson(leftRaw: Array<number | null>, rightRaw: Array<number | null> | number[]): number | null {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(leftRaw.length, rightRaw.length); i += 1) {
    const left = leftRaw[i];
    const right = rightRaw[i] as number | null;
    if (left === null || right === null || !Number.isFinite(left) || !Number.isFinite(right)) continue;
    pairs.push([left, right]);
  }
  if (pairs.length < 3) return null;
  const leftMean = average(pairs.map((pair) => pair[0]));
  const rightMean = average(pairs.map((pair) => pair[1]));
  let numerator = 0;
  let leftDenom = 0;
  let rightDenom = 0;
  for (const [left, right] of pairs) {
    const dx = left - leftMean;
    const dy = right - rightMean;
    numerator += dx * dy;
    leftDenom += dx * dx;
    rightDenom += dy * dy;
  }
  const denom = Math.sqrt(leftDenom * rightDenom);
  return denom > 0 ? numerator / denom : null;
}

function selectRows(rows: DiagnosticRow[], frontend: string, timeWindowVariant: string): DiagnosticRow[] {
  return rows.filter((row) => row.frontend === frontend && row.timeWindowVariant === timeWindowVariant);
}

async function decodeMonoAudio(filePath: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const bytes = await fs.readFile(filePath);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const decoded = await decodeAudio(arrayBuffer) as {
    sampleRate: number;
    length: number;
    numberOfChannels: number;
    getChannelData: (channel: number) => Float32Array;
  };
  if (decoded.numberOfChannels <= 1) {
    return {
      samples: new Float32Array(decoded.getChannelData(0)),
      sampleRate: decoded.sampleRate
    };
  }
  const mixed = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const channelData = decoded.getChannelData(channel);
    for (let index = 0; index < mixed.length; index += 1) {
      mixed[index] += channelData[index] / decoded.numberOfChannels;
    }
  }
  return { samples: mixed, sampleRate: decoded.sampleRate };
}

function readFrame(samples: Float32Array, start: number, frameSize: number): Float32Array {
  const frame = new Float32Array(frameSize);
  if (start >= samples.length) return frame;
  const available = Math.min(frameSize, samples.length - start);
  frame.set(samples.subarray(start, start + available), 0);
  return frame;
}

function parseTakeFromFileName(fileName: string): { stringId: number; fret: number; take: number } | null {
  const match = fileName.match(FILE_NAME_PATTERN);
  if (!match) return null;
  return {
    stringId: Number(match[1]),
    fret: Number(match[2]),
    take: Number(match[3])
  };
}

function buildDatasetKey(stringId: number | undefined, fret: number | undefined, take: number | undefined): string | null {
  if (!Number.isFinite(stringId) || !Number.isFinite(fret) || !Number.isFinite(take)) return null;
  return `${Math.round(stringId!)}:${Math.round(fret!)}:${Math.round(take!)}`;
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function buildRejectReason(rmsDbfs: number | null): string {
  if (rmsDbfs !== null && rmsDbfs < -55) return 'insufficient_signal_level';
  return 'no_detection';
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

function removeMeanInPlace(samples: Float32Array): void {
  const mean = average(Array.from(samples));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] -= mean;
  }
}

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

function applyBiquadInPlace(samples: Float32Array, coeffs: Biquad): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x0 = samples[i];
    const y0 = coeffs.b0 * x0 + coeffs.b1 * x1 + coeffs.b2 * x2 - coeffs.a1 * y1 - coeffs.a2 * y2;
    samples[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
}

function designHighPassBiquad(sampleRate: number, cutoffHz: number, q: number): Biquad {
  const omega = (2 * Math.PI * cutoffHz) / sampleRate;
  const sin = Math.sin(omega);
  const cos = Math.cos(omega);
  const alpha = sin / (2 * q);
  const b0 = (1 + cos) / 2;
  const b1 = -(1 + cos);
  const b2 = (1 + cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  return normalizeBiquad(b0, b1, b2, a0, a1, a2);
}

function designLowShelfBiquad(sampleRate: number, cutoffHz: number, slope: number, gainDb: number): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const omega = (2 * Math.PI * cutoffHz) / sampleRate;
  const sin = Math.sin(omega);
  const cos = Math.cos(omega);
  const beta = 2 * Math.sqrt(A) * (sin / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
  const b0 = A * ((A + 1) - (A - 1) * cos + beta);
  const b1 = 2 * A * ((A - 1) - (A + 1) * cos);
  const b2 = A * ((A + 1) - (A - 1) * cos - beta);
  const a0 = (A + 1) + (A - 1) * cos + beta;
  const a1 = -2 * ((A - 1) + (A + 1) * cos);
  const a2 = (A + 1) + (A - 1) * cos - beta;
  return normalizeBiquad(b0, b1, b2, a0, a1, a2);
}

function normalizeBiquad(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function applyLegacyContinuousHpfLpfInPlace(samples: Float32Array, sampleRate: number, hpfHz: number, lpfHz: number): void {
  if (samples.length <= 1) return;
  const alphaHp = sampleRate > 0 && hpfHz > 0 ? 1 / (1 + 1 / (2 * Math.PI * hpfHz / sampleRate)) : 0;
  let prevX = samples[0];
  let prevY = samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    const current = samples[i];
    const value = alphaHp * (prevY + current - prevX);
    samples[i] = value;
    prevX = current;
    prevY = value;
  }
  samples[0] = 0;
  const alphaLp = sampleRate > 0 && lpfHz > 0 ? (1 / sampleRate) / (1 / (2 * Math.PI * lpfHz) + 1 / sampleRate) : 0;
  let previous = samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    previous = previous + alphaLp * (samples[i] - previous);
    samples[i] = previous;
  }
}

function onePoleHighPassGain(sampleRate: number, cutoffHz: number, frequencyHz: number): number {
  const alpha = sampleRate > 0 && cutoffHz > 0 ? 1 / (1 + 1 / (2 * Math.PI * cutoffHz / sampleRate)) : 0;
  const omega = (2 * Math.PI * frequencyHz) / sampleRate;
  const zr = Math.cos(omega);
  const zi = Math.sin(omega);
  const numRe = alpha * (1 - zr);
  const numIm = alpha * zi;
  const denRe = 1 - alpha * zr;
  const denIm = -alpha * zi;
  return Math.hypot(numRe, numIm) / Math.max(1e-12, Math.hypot(denRe, denIm));
}

function onePoleLowPassGain(sampleRate: number, cutoffHz: number, frequencyHz: number): number {
  const alpha = sampleRate > 0 && cutoffHz > 0 ? (1 / sampleRate) / (1 / (2 * Math.PI * cutoffHz) + 1 / sampleRate) : 0;
  const pole = 1 - alpha;
  const omega = (2 * Math.PI * frequencyHz) / sampleRate;
  const denRe = 1 - pole * Math.cos(omega);
  const denIm = pole * Math.sin(omega);
  return alpha / Math.max(1e-12, Math.hypot(denRe, denIm));
}

function combinedOnePoleGainDb(sampleRate: number, highPassHz: number, lowPassHz: number, frequencyHz: number): number {
  return 20 * Math.log10(Math.max(1e-12, onePoleHighPassGain(sampleRate, highPassHz, frequencyHz) * onePoleLowPassGain(sampleRate, lowPassHz, frequencyHz)));
}

function subtractFrames(left: Float32Array, right: Float32Array): Float32Array {
  const out = new Float32Array(Math.min(left.length, right.length));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = left[i] - right[i];
  }
  return out;
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function average(values: number[]): number {
  if (values.length <= 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length <= 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function mostCommon(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function centsBetweenFrequencies(observedHz: number, referenceHz: number): number {
  return 1200 * Math.log2(observedHz / referenceHz);
}

function roundNumber(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function roundNullable(value: number | null, digits: number): number | null {
  return value === null ? null : roundNumber(value, digits);
}

function formatPct(value: number, signed = false): string {
  const percent = value * 100;
  return `${signed && percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

function formatNullable(value: number | null, digits: number, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return `${value.toFixed(digits)}${unit}`;
}

function formatNullableSigned(value: number | null): string {
  if (value === null) return '-';
  return value >= 0 ? `+${value.toFixed(3)}` : value.toFixed(3);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function svgHeader(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function linearScale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): (value: number) => number {
  const safeSpan = domainMax - domainMin || 1;
  return (value: number) => rangeMin + ((value - domainMin) / safeSpan) * (rangeMax - rangeMin);
}

function bandScale(values: string[], rangeMin: number, rangeMax: number, paddingInner: number) {
  const span = rangeMax - rangeMin;
  const step = span / Math.max(1, values.length + paddingInner * Math.max(0, values.length - 1));
  const bandWidth = step * (1 - paddingInner);
  const positions = new Map<string, number>();
  values.forEach((value, index) => {
    positions.set(value, rangeMin + index * step);
  });
  return {
    bandWidth,
    positionForValue: (value: string) => positions.get(value) ?? null
  };
}

function buildLegend(items: Array<{ label: string; color: string }>, x: number, y: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const yOffset = y + index * 18;
    lines.push(`<rect x="${x}" y="${yOffset - 10}" width="12" height="12" fill="${item.color}" />`);
    lines.push(`<text x="${x + 18}" y="${yOffset}" fill="#cbd5e1" font-size="12" font-family="Arial, sans-serif">${escapeXml(item.label)}</text>`);
  }
  return lines;
}

function colorForAlgorithm(algorithm: string): string {
  switch (algorithm) {
    case 'ac14': return '#38bdf8';
    case 'spectral_game_runtime_unified_v3': return '#22c55e';
    case 'MASP': return '#f59e0b';
    case 'FRETNET': return '#f43f5e';
    case 'pyin': return '#a78bfa';
    default: return '#cbd5e1';
  }
}

function markerPosition(frequencyHz: number, minHz: number, maxHz: number, rangeMin: number, rangeMax: number): number {
  const safe = Math.max(minHz, Math.min(maxHz, frequencyHz));
  return rangeMin + ((safe - minHz) / (maxHz - minHz || 1)) * (rangeMax - rangeMin);
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '_');
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

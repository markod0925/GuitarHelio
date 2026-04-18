import { performance } from 'node:perf_hooks';
import type { DatasetRow, DetectorRunner } from './shared';
import {
  buildFrameStartsFullCoverage,
  readFrame
} from './shared';
import { midiToHz } from '../../src/ui/song-select/utils/songSelectUtils';
import type { JamsNoteEvent } from './gameplay_validator_polyphonic';

export type MonoDatasetName = 'android' | 'guitarset_solo';
export type MonoWindowKind = 'guard' | 'transition' | 'stable';
export type MonoWindowCategory = 'empty_window' | 'transition_window' | 'single_note_window';
export type MonoStringBand = 'low' | 'mid' | 'high';
export type SampleRateMode = 'native' | 'force_48000' | 'force_44100';

export type MonoBenchmarkConfig = {
  frameSizeSamples: number;
  hopSizeSamples: number;
  pitchToleranceCents: number;
  requiredConsecutiveFrames: 2 | 3;
  fftSize: 2048 | 4096;
  sampleRateMode: SampleRateMode;
};

export type AndroidWindowConfig = {
  preGuardStartSec: number;
  preGuardDurationSec: number;
  attackStartSec: number;
  attackDurationSec: number;
  stable1StartSec: number;
  stable1DurationSec: number;
  stable2StartSec: number;
  stable2DurationSec: number;
  stable3StartSec: number;
  stable3DurationSec: number;
  tailGuardStartSec: number;
  tailGuardDurationSec: number;
};

export type GuitarSetWindowConfig = {
  onsetTransitionSec: number;
  stableWindowSec: number;
  releaseTransitionSec: number;
  gapPaddingSec: number;
  gapMinSec: number;
};

export type MonoWindowSpec = {
  windowId: string;
  fileId: string;
  relativeFilePath: string;
  dataset: MonoDatasetName;
  startSec: number;
  endSec: number;
  targetOnsetSec: number | null;
  expectedMidi: number | null;
  expectedAccept: boolean;
  windowKind: MonoWindowKind;
  windowCategory: MonoWindowCategory;
  isStableWindow: boolean;
  sourceStringId: number | null;
  sourceFret: number | null;
  sourceTake: number | null;
  sourceBand: MonoStringBand | null;
  noteLabel: string | null;
};

export type MonoFrameObservation = {
  frameIndex: number;
  timestampMs: number;
  frameStartSec: number;
  frameCenterSec: number;
  frameEndSec: number;
  frameStartSample: number;
  frameEndSample: number;
  frameSizeSamples: number;
  hopSizeSamples: number;
  sampleRate: number;
  runtimeMs: number;
  detectorAccepted: boolean;
  detectorConfidence: number;
  detectedMidi: number | null;
  detectedHz: number | null;
  rejectReason: string | null;
};

export type MonoWindowEvidence = {
  frameCount: number;
  selectedFrameCount: number;
  acceptedFrameCount: number;
  targetHitCount: number;
  wrongNoteFrameCount: number;
  noDetectFrameCount: number;
  anyActivationFrameCount: number;
  targetHitRatio: number;
  wrongNoteRatio: number;
  supportSeconds: number;
  targetConsecutiveSeconds: number;
  maxConfidence: number;
  medianConfidence: number;
  firstTargetHitLatencyMs: number | null;
  firstAnyHitLatencyMs: number | null;
  confirmationLatencyMs: number | null;
  confirmationLatencyFromTargetOnsetMs: number | null;
  confirmedDetectedMidi: number | null;
  confirmedDetectedHz: number | null;
  confirmedCentsError: number | null;
  confirmedFrameNoteMismatch: boolean;
  confirmedConsecutiveFrames: number;
  consecutiveGoodFramesMax: number;
  resetCount: number;
  noDetectResetCount: number;
  dominantDetectedMidi: number | null;
  dominantDetectedMidiCount: number;
  rawDetectedMidis: number[];
  runtimeAvgMs: number;
  runtimeP95Ms: number;
  noDetectFrameRatio: number;
};

export type MonoWindowResult = MonoWindowSpec & {
  observations: MonoFrameObservation[];
  evidence: MonoWindowEvidence;
  frameSizeSamples: number;
  hopSizeSamples: number;
  pitchToleranceCents: number;
  requiredConsecutiveFrames: 2 | 3;
  fftSize: 2048 | 4096;
  sampleRateMode: SampleRateMode;
  sampleRateHz: number;
  acceptPreGate: boolean;
  acceptPostGate: boolean;
  accept: boolean;
  rejectReason: string;
  falseReject: boolean;
  falseAccept: boolean;
  noteMismatch: boolean;
  mismatchType: MonoMismatchType;
  decisionLatencyMs: number | null;
  decisionLatencyFromTargetOnsetMs: number | null;
  validatorRuntimeMs: number;
  detectorRuntimeMs: number;
  totalRuntimeMs: number;
};

export type MonoMismatchType =
  | 'correct_target'
  | 'empty_window'
  | 'false_activation'
  | 'missed_target'
  | 'octave_distractor'
  | 'neighbor_note'
  | 'wrong_note';

export type MonoAggregateMetrics = {
  dataset: MonoDatasetName;
  windows: number;
  positiveWindows: number;
  negativeWindows: number;
  stableWindows: number;
  transitionWindows: number;
  guardWindows: number;
  confirmedWindows: number;
  confirmedWindowRate: number;
  tar: number;
  strictFar: number;
  noteMismatchFar: number;
  precision: number;
  recall: number;
  lowBandTar: number | null;
  lowBandFar: number | null;
  stableWindowAcceptRate: number | null;
  transitionWindowAcceptRate: number | null;
  guardWindowFalseAcceptRate: number | null;
  averageSupportSeconds: number;
  averageTargetHitRatio: number;
  averageWrongNoteRatio: number;
  averageConfirmationLatencyMsAvg: number | null;
  averageConfirmationLatencyMsP95: number | null;
  averageConfirmationLatencyFromTargetOnsetMsAvg: number | null;
  averageConfirmationLatencyFromTargetOnsetMsP95: number | null;
  firstTargetHitLatencyMsAvg: number | null;
  firstTargetHitLatencyMsP95: number | null;
  firstAnyHitLatencyMsAvg: number | null;
  firstAnyHitLatencyMsP95: number | null;
  noDetectFrameRatio: number;
  resetCountAvg: number;
  detectorRuntimeAvgMs: number;
  detectorRuntimeP95Ms: number;
  validatorRuntimeAvgMs: number;
  validatorRuntimeP95Ms: number;
  totalRuntimeAvgMs: number;
  totalRuntimeP95Ms: number;
};

export type StreamingTrace = {
  observations: MonoFrameObservation[];
  detectorRuntimeAvgMs: number;
  detectorRuntimeP95Ms: number;
  detectorRuntimeTotalMs: number;
  frameCount: number;
  sampleRateHz: number;
  frameSizeSamples: number;
  hopSizeSamples: number;
  sampleRateMode: SampleRateMode;
  fftSize: 2048 | 4096;
};

export type PreparedMonoAudio = {
  samples: Float32Array;
  sampleRate: number;
  sourceSampleRate: number;
  resampled: boolean;
  sampleRateMode: SampleRateMode;
};

export const DEFAULT_MONO_BENCHMARK_CONFIG: MonoBenchmarkConfig = {
  frameSizeSamples: 2048,
  hopSizeSamples: 512,
  pitchToleranceCents: 100,
  requiredConsecutiveFrames: 2,
  fftSize: 2048,
  sampleRateMode: 'force_48000'
};

export const DEFAULT_ANDROID_WINDOW_CONFIG: AndroidWindowConfig = {
  preGuardStartSec: 0,
  preGuardDurationSec: 0.20,
  attackStartSec: 0.20,
  attackDurationSec: 0.30,
  stable1StartSec: 0.50,
  stable1DurationSec: 0.60,
  stable2StartSec: 1.15,
  stable2DurationSec: 0.60,
  stable3StartSec: 1.80,
  stable3DurationSec: 0.60,
  tailGuardStartSec: 2.95,
  tailGuardDurationSec: 0.20
};

export const DEFAULT_GUITARSET_WINDOW_CONFIG: GuitarSetWindowConfig = {
  onsetTransitionSec: 0.12,
  stableWindowSec: 0.45,
  releaseTransitionSec: 0.12,
  gapPaddingSec: 0.05,
  gapMinSec: 0.25
};

export function buildAndroidMonoWindows(input: {
  datasetRow: DatasetRow;
  midi: number;
  durationSec: number;
  config?: AndroidWindowConfig;
}): MonoWindowSpec[] {
  const config = input.config ?? DEFAULT_ANDROID_WINDOW_CONFIG;
  const fileId = input.datasetRow.fileId;
  const relativeFilePath = input.datasetRow.relativeFilePath;
  const sourceBand = stringBandFor(input.datasetRow.stringId);
  const windows: MonoWindowSpec[] = [];

  addWindow(windows, {
    fileId,
    relativeFilePath,
    dataset: 'android',
    windowId: `${fileId}__pre_guard`,
    startSec: config.preGuardStartSec,
    endSec: config.preGuardStartSec + config.preGuardDurationSec,
    targetOnsetSec: null,
    expectedMidi: null,
    expectedAccept: false,
    windowKind: 'guard',
    windowCategory: 'empty_window',
    isStableWindow: false,
    sourceStringId: input.datasetRow.stringId,
    sourceFret: input.datasetRow.fret,
    sourceTake: input.datasetRow.take,
    sourceBand,
    noteLabel: null
  }, input.durationSec);

  addWindow(windows, {
    fileId,
    relativeFilePath,
    dataset: 'android',
    windowId: `${fileId}__attack_transition`,
    startSec: config.attackStartSec,
    endSec: config.attackStartSec + config.attackDurationSec,
    targetOnsetSec: config.attackStartSec,
    expectedMidi: input.midi,
    expectedAccept: true,
    windowKind: 'transition',
    windowCategory: 'transition_window',
    isStableWindow: false,
    sourceStringId: input.datasetRow.stringId,
    sourceFret: input.datasetRow.fret,
    sourceTake: input.datasetRow.take,
    sourceBand,
    noteLabel: noteLabelFor(input.midi)
  }, input.durationSec);

  addWindow(windows, {
    fileId,
    relativeFilePath,
    dataset: 'android',
    windowId: `${fileId}__stable_1`,
    startSec: config.stable1StartSec,
    endSec: config.stable1StartSec + config.stable1DurationSec,
    targetOnsetSec: config.attackStartSec,
    expectedMidi: input.midi,
    expectedAccept: true,
    windowKind: 'stable',
    windowCategory: 'single_note_window',
    isStableWindow: true,
    sourceStringId: input.datasetRow.stringId,
    sourceFret: input.datasetRow.fret,
    sourceTake: input.datasetRow.take,
    sourceBand,
    noteLabel: noteLabelFor(input.midi)
  }, input.durationSec);

  addWindow(windows, {
    fileId,
    relativeFilePath,
    dataset: 'android',
    windowId: `${fileId}__stable_2`,
    startSec: config.stable2StartSec,
    endSec: config.stable2StartSec + config.stable2DurationSec,
    targetOnsetSec: config.attackStartSec,
    expectedMidi: input.midi,
    expectedAccept: true,
    windowKind: 'stable',
    windowCategory: 'single_note_window',
    isStableWindow: true,
    sourceStringId: input.datasetRow.stringId,
    sourceFret: input.datasetRow.fret,
    sourceTake: input.datasetRow.take,
    sourceBand,
    noteLabel: noteLabelFor(input.midi)
  }, input.durationSec);

  addWindow(windows, {
    fileId,
    relativeFilePath,
    dataset: 'android',
    windowId: `${fileId}__stable_3`,
    startSec: config.stable3StartSec,
    endSec: config.stable3StartSec + config.stable3DurationSec,
    targetOnsetSec: config.attackStartSec,
    expectedMidi: input.midi,
    expectedAccept: true,
    windowKind: 'stable',
    windowCategory: 'single_note_window',
    isStableWindow: true,
    sourceStringId: input.datasetRow.stringId,
    sourceFret: input.datasetRow.fret,
    sourceTake: input.datasetRow.take,
    sourceBand,
    noteLabel: noteLabelFor(input.midi)
  }, input.durationSec);

  addWindow(windows, {
    fileId,
    relativeFilePath,
    dataset: 'android',
    windowId: `${fileId}__tail_guard`,
    startSec: config.tailGuardStartSec,
    endSec: config.tailGuardStartSec + config.tailGuardDurationSec,
    targetOnsetSec: null,
    expectedMidi: null,
    expectedAccept: false,
    windowKind: 'guard',
    windowCategory: 'empty_window',
    isStableWindow: false,
    sourceStringId: input.datasetRow.stringId,
    sourceFret: input.datasetRow.fret,
    sourceTake: input.datasetRow.take,
    sourceBand,
    noteLabel: null
  }, input.durationSec);

  return windows;
}

export function buildGuitarSetSoloWindows(input: {
  fileId: string;
  relativeFilePath: string;
  durationSec: number;
  events: JamsNoteEvent[];
  config?: GuitarSetWindowConfig;
}): MonoWindowSpec[] {
  const config = input.config ?? DEFAULT_GUITARSET_WINDOW_CONFIG;
  const windows: MonoWindowSpec[] = [];
  const events = [...input.events].sort((left, right) =>
    left.startSec - right.startSec ||
    left.endSec - right.endSec ||
    left.midi - right.midi
  );

  if (events.length === 0) {
    addWindow(windows, {
      fileId: input.fileId,
      relativeFilePath: input.relativeFilePath,
      dataset: 'guitarset_solo',
      windowId: `${input.fileId}__gap_0`,
      startSec: 0,
      endSec: Math.max(0, Math.min(input.durationSec, config.gapMinSec)),
      targetOnsetSec: null,
      expectedMidi: null,
      expectedAccept: false,
      windowKind: 'guard',
      windowCategory: 'empty_window',
      isStableWindow: false,
      sourceStringId: null,
      sourceFret: null,
      sourceTake: null,
      sourceBand: null,
      noteLabel: null
    }, input.durationSec);
    return windows;
  }

  const leadingGapEnd = Math.max(0, events[0].startSec - config.gapPaddingSec);
  if (leadingGapEnd >= config.gapMinSec) {
    addWindow(windows, {
      fileId: input.fileId,
      relativeFilePath: input.relativeFilePath,
      dataset: 'guitarset_solo',
      windowId: `${input.fileId}__gap_lead`,
      startSec: 0,
      endSec: leadingGapEnd,
      targetOnsetSec: null,
      expectedMidi: null,
      expectedAccept: false,
      windowKind: 'guard',
      windowCategory: 'empty_window',
      isStableWindow: false,
      sourceStringId: null,
      sourceFret: null,
      sourceTake: null,
      sourceBand: null,
      noteLabel: null
    }, input.durationSec);
  }

  events.forEach((event, index) => {
    const noteLabel = noteLabelFor(event.midi);
    const onsetEnd = Math.min(event.endSec, event.startSec + config.onsetTransitionSec);
    addWindow(windows, {
      fileId: input.fileId,
      relativeFilePath: input.relativeFilePath,
      dataset: 'guitarset_solo',
      windowId: `${input.fileId}__n${String(index).padStart(4, '0')}__attack`,
      startSec: event.startSec,
      endSec: onsetEnd,
      targetOnsetSec: event.startSec,
      expectedMidi: event.midi,
      expectedAccept: true,
      windowKind: 'transition',
      windowCategory: 'transition_window',
      isStableWindow: false,
      sourceStringId: null,
      sourceFret: null,
      sourceTake: null,
      sourceBand: null,
      noteLabel
    }, input.durationSec);

    const stableStart = onsetEnd;
    const stableTargetEnd = Math.min(event.endSec - config.releaseTransitionSec, stableStart + config.stableWindowSec);
    if (stableTargetEnd - stableStart >= config.gapMinSec / 2) {
      addWindow(windows, {
        fileId: input.fileId,
        relativeFilePath: input.relativeFilePath,
        dataset: 'guitarset_solo',
        windowId: `${input.fileId}__n${String(index).padStart(4, '0')}__stable`,
        startSec: stableStart,
        endSec: stableTargetEnd,
        targetOnsetSec: event.startSec,
        expectedMidi: event.midi,
        expectedAccept: true,
        windowKind: 'stable',
        windowCategory: 'single_note_window',
        isStableWindow: true,
        sourceStringId: null,
        sourceFret: null,
        sourceTake: null,
        sourceBand: null,
        noteLabel
      }, input.durationSec);
    }

    const releaseStart = Math.max(event.startSec, event.endSec - config.releaseTransitionSec);
    if (event.endSec - releaseStart >= config.gapMinSec / 4) {
      addWindow(windows, {
        fileId: input.fileId,
        relativeFilePath: input.relativeFilePath,
        dataset: 'guitarset_solo',
        windowId: `${input.fileId}__n${String(index).padStart(4, '0')}__release`,
        startSec: releaseStart,
        endSec: event.endSec,
        targetOnsetSec: event.startSec,
        expectedMidi: event.midi,
        expectedAccept: true,
        windowKind: 'transition',
        windowCategory: 'transition_window',
        isStableWindow: false,
        sourceStringId: null,
        sourceFret: null,
        sourceTake: null,
        sourceBand: null,
        noteLabel
      }, input.durationSec);
    }

    const next = events[index + 1] ?? null;
    if (next) {
      const gapStart = event.endSec + config.gapPaddingSec;
      const gapEnd = next.startSec - config.gapPaddingSec;
      if (gapEnd - gapStart >= config.gapMinSec) {
        addWindow(windows, {
          fileId: input.fileId,
          relativeFilePath: input.relativeFilePath,
          dataset: 'guitarset_solo',
          windowId: `${input.fileId}__gap_${String(index).padStart(4, '0')}`,
          startSec: gapStart,
          endSec: gapEnd,
          targetOnsetSec: null,
          expectedMidi: null,
          expectedAccept: false,
          windowKind: 'guard',
          windowCategory: 'empty_window',
          isStableWindow: false,
          sourceStringId: null,
          sourceFret: null,
          sourceTake: null,
          sourceBand: null,
          noteLabel: null
        }, input.durationSec);
      }
    }
  });

  const last = events[events.length - 1];
  const trailingStart = last.endSec + config.gapPaddingSec;
  if (input.durationSec - trailingStart >= config.gapMinSec) {
    addWindow(windows, {
      fileId: input.fileId,
      relativeFilePath: input.relativeFilePath,
      dataset: 'guitarset_solo',
      windowId: `${input.fileId}__gap_tail`,
      startSec: trailingStart,
      endSec: input.durationSec,
      targetOnsetSec: null,
      expectedMidi: null,
      expectedAccept: false,
      windowKind: 'guard',
      windowCategory: 'empty_window',
      isStableWindow: false,
      sourceStringId: null,
      sourceFret: null,
      sourceTake: null,
      sourceBand: null,
      noteLabel: null
    }, input.durationSec);
  }

  return windows;
}

export function buildProbeTimes(input: {
  startSec: number;
  endSec: number;
  spacingSec: number;
}): number[] {
  const startSec = Math.max(0, input.startSec);
  const endSec = Math.max(startSec, input.endSec);
  const spacingSec = Math.max(0.01, input.spacingSec);
  if (endSec <= startSec) return [roundSec(startSec)];

  const times: number[] = [];
  for (let time = startSec; time <= endSec + 1e-9; time += spacingSec) {
    times.push(roundSec(time));
  }
  if (times[times.length - 1] !== roundSec(endSec)) {
    times.push(roundSec(endSec));
  }
  return uniqueSortedFloats(times);
}

export function secondsToSampleIndex(seconds: number, sampleRate: number): number {
  return Math.max(0, Math.round(Math.max(0, seconds) * Math.max(1, sampleRate)));
}

export function buildStreamingFrameTimeline(input: {
  sampleCount: number;
  sampleRate: number;
  frameSizeSamples: number;
  hopSizeSamples: number;
}): Array<{
  frameIndex: number;
  frameStartSample: number;
  frameEndSample: number;
  frameStartSec: number;
  frameCenterSec: number;
  frameEndSec: number;
}> {
  const frameSizeSamples = Math.max(1, Math.round(input.frameSizeSamples));
  const hopSizeSamples = Math.max(1, Math.round(input.hopSizeSamples));
  const sampleRate = Math.max(1, Math.round(input.sampleRate));
  const frameStarts = buildFrameStartsFullCoverage(Math.max(0, Math.round(input.sampleCount)), frameSizeSamples, hopSizeSamples);
  return frameStarts.map((frameStartSample, frameIndex) => {
    const frameEndSample = frameStartSample + frameSizeSamples;
    const frameStartSec = frameStartSample / sampleRate;
    const frameCenterSec = (frameStartSample + frameSizeSamples / 2) / sampleRate;
    const frameEndSec = frameEndSample / sampleRate;
    return {
      frameIndex,
      frameStartSample,
      frameEndSample,
      frameStartSec,
      frameCenterSec,
      frameEndSec
    };
  });
}

export function prepareMonoAudioForBenchmark(input: {
  samples: Float32Array;
  sampleRate: number;
  sampleRateMode: SampleRateMode;
}): PreparedMonoAudio {
  const sourceSampleRate = Math.max(1, Math.round(input.sampleRate));
  const targetSampleRate = resolveScenarioSampleRate(sourceSampleRate, input.sampleRateMode);
  const samples = targetSampleRate === sourceSampleRate
    ? input.samples
    : resampleMonoSignal(input.samples, sourceSampleRate, targetSampleRate);
  return {
    samples,
    sampleRate: targetSampleRate,
    sourceSampleRate,
    resampled: targetSampleRate !== sourceSampleRate,
    sampleRateMode: input.sampleRateMode
  };
}

export function buildStreamingBenchmarkSweepVariants(base: Partial<MonoBenchmarkConfig> = {}): MonoBenchmarkConfig[] {
  const frameSizeSamples = base.frameSizeSamples ?? DEFAULT_MONO_BENCHMARK_CONFIG.frameSizeSamples;
  const hopSizeSamples = base.hopSizeSamples ?? DEFAULT_MONO_BENCHMARK_CONFIG.hopSizeSamples;
  const pitchToleranceCents = [30, 100, 300] as const;
  const requiredConsecutiveFrames = [2, 3] as const;
  const fftSizes = [2048, 4096] as const;
  const sampleRateModes: SampleRateMode[] = base.sampleRateMode ? [base.sampleRateMode] : ['force_48000', 'force_44100'];

  const variants: MonoBenchmarkConfig[] = [];
  for (const sampleRateMode of sampleRateModes) {
    for (const fftSize of fftSizes) {
      for (const pitchToleranceCent of pitchToleranceCents) {
        for (const consecutive of requiredConsecutiveFrames) {
          variants.push({
            frameSizeSamples: fftSize,
            hopSizeSamples,
            pitchToleranceCents: pitchToleranceCent,
            requiredConsecutiveFrames: consecutive,
            fftSize,
            sampleRateMode
          });
        }
      }
    }
  }
  if (variants.length === 0) {
    variants.push({
      frameSizeSamples,
      hopSizeSamples,
      pitchToleranceCents: DEFAULT_MONO_BENCHMARK_CONFIG.pitchToleranceCents,
      requiredConsecutiveFrames: DEFAULT_MONO_BENCHMARK_CONFIG.requiredConsecutiveFrames,
      fftSize: DEFAULT_MONO_BENCHMARK_CONFIG.fftSize,
      sampleRateMode: DEFAULT_MONO_BENCHMARK_CONFIG.sampleRateMode
    });
  }
  return variants;
}

export function buildBenchmarkVariantKey(config: MonoBenchmarkConfig): string {
  return [
    config.sampleRateMode,
    `fft${config.fftSize}`,
    `tol${config.pitchToleranceCents}`,
    `c${config.requiredConsecutiveFrames}`
  ].join('_');
}

export function formatBenchmarkVariantLabel(config: MonoBenchmarkConfig): string {
  return `${config.sampleRateMode} | fft=${config.fftSize} | tol=±${config.pitchToleranceCents}c | consec=${config.requiredConsecutiveFrames}`;
}

export function runStreamingTrace(input: {
  detector: DetectorRunner;
  samples: Float32Array;
  sampleRate: number;
  config: MonoBenchmarkConfig;
}): StreamingTrace {
  const sampleRate = Math.max(1, Math.round(input.sampleRate));
  const frameSizeSamples = Math.max(1, Math.round(input.config.frameSizeSamples));
  const hopSizeSamples = Math.max(1, Math.round(input.config.hopSizeSamples));
  const timeline = buildStreamingFrameTimeline({
    sampleCount: input.samples.length,
    sampleRate,
    frameSizeSamples,
    hopSizeSamples
  });

  const observations: MonoFrameObservation[] = [];
  input.detector.reset();
  for (const frame of timeline) {
    const rawFrame = readFrame(input.samples, frame.frameStartSample, frameSizeSamples);
    const startedAt = performance.now();
    const result = input.detector.processFrame({
      timestampMs: frame.frameCenterSec * 1000,
      frameIndex: frame.frameIndex,
      sampleRate,
      rawFrame,
      processedFrame: rawFrame,
      analysisWindowId: frame.frameIndex
    });
    const runtimeMs = performance.now() - startedAt;
    observations.push({
      frameIndex: frame.frameIndex,
      timestampMs: frame.frameCenterSec * 1000,
      frameStartSec: frame.frameStartSec,
      frameCenterSec: frame.frameCenterSec,
      frameEndSec: frame.frameEndSec,
      frameStartSample: frame.frameStartSample,
      frameEndSample: frame.frameEndSample,
      frameSizeSamples,
      hopSizeSamples,
      sampleRate,
      runtimeMs,
      detectorAccepted: result.accepted,
      detectorConfidence: result.confidence ?? 0,
      detectedMidi: result.midi ?? null,
      detectedHz: result.pitchHz ?? null,
      rejectReason: result.rejectReason ?? null
    });
  }

  const detectorRuntimeSamples = observations.map((obs) => obs.runtimeMs);
  return {
    observations,
    detectorRuntimeAvgMs: average(detectorRuntimeSamples),
    detectorRuntimeP95Ms: percentile(detectorRuntimeSamples, 0.95),
    detectorRuntimeTotalMs: detectorRuntimeSamples.reduce((sum, value) => sum + value, 0),
    frameCount: observations.length,
    sampleRateHz: sampleRate,
    frameSizeSamples,
    hopSizeSamples,
    sampleRateMode: input.config.sampleRateMode,
    fftSize: input.config.fftSize
  };
}

export function selectWindowObservations(
  observations: MonoFrameObservation[],
  window: Pick<MonoWindowSpec, 'startSec' | 'endSec'>
): MonoFrameObservation[] {
  const startSec = Math.min(window.startSec, window.endSec);
  const endSec = Math.max(window.startSec, window.endSec);
  return observations.filter((observation) => observation.frameCenterSec >= startSec && observation.frameCenterSec < endSec);
}

export function centsDifference(detectedHz: number, expectedHz: number): number {
  if (!(detectedHz > 0) || !(expectedHz > 0)) return Number.NaN;
  return 1200 * Math.log2(detectedHz / expectedHz);
}

export function isPitchMatch(input: {
  detectedHz: number | null;
  expectedMidi: number | null;
  pitchToleranceCents: number;
}): boolean {
  if (input.expectedMidi === null || input.detectedHz === null) return false;
  const expectedHz = midiToHz(input.expectedMidi);
  const cents = centsDifference(input.detectedHz, expectedHz);
  return Number.isFinite(cents) && Math.abs(cents) <= Math.abs(input.pitchToleranceCents);
}

export function evaluateMonoWindow(input: {
  spec: MonoWindowSpec;
  observations: MonoFrameObservation[];
  config: MonoBenchmarkConfig;
}): MonoWindowResult {
  const validatorStartedAt = performance.now();
  const selectedObservations = selectWindowObservations(input.observations, input.spec);
  const expectedMidi = input.spec.expectedMidi;
  const expectedHz = expectedMidi === null ? null : midiToHz(expectedMidi);
  const pitchToleranceCents = Math.max(0, Math.abs(input.config.pitchToleranceCents));
  const consecutiveThreshold = Math.max(1, Math.round(input.config.requiredConsecutiveFrames));
  const hopSec = input.config.hopSizeSamples / Math.max(1, selectedObservations[0]?.sampleRate ?? input.observations[0]?.sampleRate ?? 1);
  const selectedAccepted = selectedObservations.filter((obs) => obs.detectorAccepted && obs.detectedMidi !== null);
  const selectedAcceptedMidis = selectedAccepted.map((obs) => Math.round(obs.detectedMidi as number));
  const rawDetectedMidis = uniqueSortedIntegers(selectedAcceptedMidis);
  const dominantDetectedMidi = mostCommonNumber(selectedAcceptedMidis);
  const dominantDetectedMidiCount = dominantDetectedMidi === null
    ? 0
    : selectedAcceptedMidis.filter((midi) => midi === dominantDetectedMidi).length;
  const targetHitMask = selectedObservations.map((obs) => isGoodFrame(obs, expectedMidi, expectedHz, pitchToleranceCents));
  const wrongNoteMask = selectedObservations.map((obs) => isWrongNoteFrame(obs, expectedMidi, expectedHz, pitchToleranceCents));
  const noDetectMask = selectedObservations.map((obs) => !obs.detectorAccepted || obs.detectedMidi === null);
  const confidences = selectedAccepted.map((obs) => obs.detectorConfidence);
  const runtimeMs = selectedObservations.map((obs) => obs.runtimeMs);
  const selectedFrameCount = selectedObservations.length;
  const acceptedFrameCount = selectedAccepted.length;
  const targetHitCount = countTrue(targetHitMask);
  const wrongNoteFrameCount = countTrue(wrongNoteMask);
  const noDetectFrameCount = countTrue(noDetectMask);
  const targetHitRatio = selectedFrameCount > 0 ? targetHitCount / selectedFrameCount : 0;
  const wrongNoteRatio = selectedFrameCount > 0 ? wrongNoteFrameCount / selectedFrameCount : 0;
  const supportSeconds = targetHitCount * hopSec;
  const targetConsecutiveFrames = longestConsecutiveTrue(targetHitMask);
  const targetConsecutiveSeconds = targetConsecutiveFrames * hopSec;
  const firstTargetHit = selectedObservations.find((_, index) => targetHitMask[index]);
  const firstAnyHit = selectedObservations.find((obs) => obs.detectorAccepted && obs.detectedMidi !== null);
  let confirmationFrame: MonoFrameObservation | null = null;
  let confirmationConsecutiveFrames = 0;
  let confirmationConsecutiveFramesAtHit = 0;
  let consecutiveGoodFramesMax = 0;
  let resetCount = 0;
  let noDetectResetCount = 0;
  for (let index = 0; index < selectedObservations.length; index += 1) {
    if (targetHitMask[index]) {
      confirmationConsecutiveFrames += 1;
      if (confirmationConsecutiveFrames > consecutiveGoodFramesMax) {
        consecutiveGoodFramesMax = confirmationConsecutiveFrames;
      }
      if (confirmationFrame === null && confirmationConsecutiveFrames >= consecutiveThreshold) {
        confirmationFrame = selectedObservations[index];
        confirmationConsecutiveFramesAtHit = confirmationConsecutiveFrames;
      }
      continue;
    }
    if (confirmationConsecutiveFrames > 0) {
      resetCount += 1;
      if (noDetectMask[index]) {
        noDetectResetCount += 1;
      }
    }
    confirmationConsecutiveFrames = 0;
  }

  const confirmedDetectedMidi = confirmationFrame?.detectedMidi ?? null;
  const confirmedDetectedHz = confirmationFrame?.detectedHz ?? null;
  const confirmedCentsError =
    confirmationFrame !== null && expectedHz !== null && confirmationFrame.detectedHz !== null
      ? roundNumber(centsDifference(confirmationFrame.detectedHz, expectedHz), 6)
      : null;
  const confirmedFrameNoteMismatch =
    confirmationFrame !== null &&
    expectedMidi !== null &&
    confirmationFrame.detectedMidi !== null &&
    Math.round(confirmationFrame.detectedMidi) !== expectedMidi;

  const confirmationLatencyMs = confirmationFrame
    ? confirmationFrame.timestampMs - input.spec.startSec * 1000
    : null;
  const targetOnsetSec = input.spec.targetOnsetSec ?? input.spec.startSec;
  const confirmationLatencyFromTargetOnsetMs = confirmationFrame
    ? confirmationFrame.timestampMs - targetOnsetSec * 1000
    : null;

  const accept = confirmationFrame !== null;
  const falseReject = input.spec.expectedAccept && !accept;
  const falseAccept = !input.spec.expectedAccept && accept;
  const noteMismatch = accept && input.spec.expectedAccept ? confirmedFrameNoteMismatch : false;
  const rejectReason = buildRejectReason({
    expectedAccept: input.spec.expectedAccept,
    accept,
    selectedFrameCount,
    targetHitCount,
    consecutiveThreshold,
    targetHitMask,
    wrongNoteMask,
    noDetectFrameCount
  });

  const evidence: MonoWindowEvidence = {
    frameCount: input.observations.length,
    selectedFrameCount,
    acceptedFrameCount,
    targetHitCount,
    wrongNoteFrameCount,
    noDetectFrameCount,
    anyActivationFrameCount: acceptedFrameCount,
    targetHitRatio,
    wrongNoteRatio,
    supportSeconds,
    targetConsecutiveSeconds,
    maxConfidence: confidences.length > 0 ? Math.max(...confidences) : 0,
    medianConfidence: confidences.length > 0 ? median(confidences) : 0,
    firstTargetHitLatencyMs: firstTargetHit ? firstTargetHit.timestampMs - input.spec.startSec * 1000 : null,
    firstAnyHitLatencyMs: firstAnyHit ? firstAnyHit.timestampMs - input.spec.startSec * 1000 : null,
    confirmationLatencyMs,
    confirmationLatencyFromTargetOnsetMs,
    confirmedDetectedMidi,
    confirmedDetectedHz,
    confirmedCentsError,
    confirmedFrameNoteMismatch,
    confirmedConsecutiveFrames: confirmationFrame !== null ? confirmationConsecutiveFramesAtHit : 0,
    consecutiveGoodFramesMax,
    resetCount,
    noDetectResetCount,
    dominantDetectedMidi,
    dominantDetectedMidiCount,
    rawDetectedMidis,
    runtimeAvgMs: average(runtimeMs),
    runtimeP95Ms: percentile(runtimeMs, 0.95),
    noDetectFrameRatio: selectedFrameCount > 0 ? noDetectFrameCount / selectedFrameCount : 0
  };

  const decisionLatencyFromTargetOnsetMs = confirmationLatencyFromTargetOnsetMs;
  const detectorRuntimeMs = runtimeMs.reduce((sum, value) => sum + value, 0);
  const validatorRuntimeMs = performance.now() - validatorStartedAt;

  return {
    ...input.spec,
    observations: selectedObservations,
    evidence,
    frameSizeSamples: input.config.frameSizeSamples,
    hopSizeSamples: input.config.hopSizeSamples,
    pitchToleranceCents,
    requiredConsecutiveFrames: consecutiveThreshold as 2 | 3,
    fftSize: input.config.fftSize,
    sampleRateMode: input.config.sampleRateMode,
    sampleRateHz: selectedObservations[0]?.sampleRate ?? input.observations[0]?.sampleRate ?? 0,
    acceptPreGate: accept,
    acceptPostGate: accept,
    accept,
    rejectReason,
    falseReject,
    falseAccept,
    noteMismatch,
    mismatchType: classifyMismatch(input.spec, evidence),
    decisionLatencyMs: confirmationLatencyMs,
    decisionLatencyFromTargetOnsetMs,
    validatorRuntimeMs,
    detectorRuntimeMs,
    totalRuntimeMs: detectorRuntimeMs + validatorRuntimeMs
  };
}

export function aggregateMonoResults(results: MonoWindowResult[]): MonoAggregateMetrics {
  const positive = results.filter((row) => row.expectedAccept);
  const negative = results.filter((row) => !row.expectedAccept);
  const stable = results.filter((row) => row.windowKind === 'stable');
  const transition = results.filter((row) => row.windowKind === 'transition');
  const guard = results.filter((row) => row.windowKind === 'guard');
  const lowBand = results.filter((row) => row.sourceBand === 'low');

  const detectorRuntime = flatten(results.map((row) => row.observations.map((obs) => obs.runtimeMs)));
  const validatorRuntime = results.map((row) => row.validatorRuntimeMs);
  const totalRuntime = results.map((row) => row.totalRuntimeMs);
  const confirmationLatencies = results
    .filter((row) => row.accept)
    .map((row) => row.evidence.confirmationLatencyMs)
    .filter((value): value is number => value !== null);
  const confirmationLatenciesFromOnset = results
    .filter((row) => row.accept)
    .map((row) => row.evidence.confirmationLatencyFromTargetOnsetMs)
    .filter((value): value is number => value !== null);
  const targetHitLatencies = flatten(results.map((row) => row.evidence.firstTargetHitLatencyMs === null ? [] : [row.evidence.firstTargetHitLatencyMs]));
  const anyHitLatencies = flatten(results.map((row) => row.evidence.firstAnyHitLatencyMs === null ? [] : [row.evidence.firstAnyHitLatencyMs]));
  const noDetectFrameCount = results.reduce((sum, row) => sum + row.evidence.noDetectFrameCount, 0);
  const selectedFrameCount = results.reduce((sum, row) => sum + row.evidence.selectedFrameCount, 0);
  const resetCounts = results.map((row) => row.evidence.resetCount);

  return {
    dataset: results[0]?.dataset ?? 'android',
    windows: results.length,
    positiveWindows: positive.length,
    negativeWindows: negative.length,
    stableWindows: stable.length,
    transitionWindows: transition.length,
    guardWindows: guard.length,
    confirmedWindows: results.filter((row) => row.accept).length,
    confirmedWindowRate: results.length > 0 ? results.filter((row) => row.accept).length / results.length : 0,
    tar: ratio(positive.map((row) => row.accept)),
    strictFar: ratio(negative.map((row) => row.accept)),
    noteMismatchFar: positive.length > 0 ? positive.filter((row) => row.accept && row.noteMismatch).length / positive.length : 0,
    precision: results.filter((row) => row.accept).length > 0
      ? positive.filter((row) => row.accept).length / results.filter((row) => row.accept).length
      : 0,
    recall: positive.length > 0 ? positive.filter((row) => row.accept).length / positive.length : 0,
    lowBandTar: lowBand.filter((row) => row.expectedAccept).length > 0
      ? lowBand.filter((row) => row.expectedAccept && row.accept).length / lowBand.filter((row) => row.expectedAccept).length
      : null,
    lowBandFar: lowBand.filter((row) => !row.expectedAccept).length > 0
      ? lowBand.filter((row) => !row.expectedAccept && row.accept).length / lowBand.filter((row) => !row.expectedAccept).length
      : null,
    stableWindowAcceptRate: stable.length > 0 ? stable.filter((row) => row.accept).length / stable.length : null,
    transitionWindowAcceptRate: transition.length > 0 ? transition.filter((row) => row.accept).length / transition.length : null,
    guardWindowFalseAcceptRate: guard.length > 0 ? guard.filter((row) => row.accept).length / guard.length : null,
    averageSupportSeconds: average(results.map((row) => row.evidence.supportSeconds)),
    averageTargetHitRatio: average(results.map((row) => row.evidence.targetHitRatio)),
    averageWrongNoteRatio: average(results.map((row) => row.evidence.wrongNoteRatio)),
    averageConfirmationLatencyMsAvg: confirmationLatencies.length > 0 ? average(confirmationLatencies) : null,
    averageConfirmationLatencyMsP95: confirmationLatencies.length > 0 ? percentile(confirmationLatencies, 0.95) : null,
    averageConfirmationLatencyFromTargetOnsetMsAvg: confirmationLatenciesFromOnset.length > 0 ? average(confirmationLatenciesFromOnset) : null,
    averageConfirmationLatencyFromTargetOnsetMsP95: confirmationLatenciesFromOnset.length > 0 ? percentile(confirmationLatenciesFromOnset, 0.95) : null,
    firstTargetHitLatencyMsAvg: targetHitLatencies.length > 0 ? average(targetHitLatencies) : null,
    firstTargetHitLatencyMsP95: targetHitLatencies.length > 0 ? percentile(targetHitLatencies, 0.95) : null,
    firstAnyHitLatencyMsAvg: anyHitLatencies.length > 0 ? average(anyHitLatencies) : null,
    firstAnyHitLatencyMsP95: anyHitLatencies.length > 0 ? percentile(anyHitLatencies, 0.95) : null,
    noDetectFrameRatio: selectedFrameCount > 0 ? noDetectFrameCount / selectedFrameCount : 0,
    resetCountAvg: average(resetCounts),
    detectorRuntimeAvgMs: average(detectorRuntime),
    detectorRuntimeP95Ms: percentile(detectorRuntime, 0.95),
    validatorRuntimeAvgMs: average(validatorRuntime),
    validatorRuntimeP95Ms: percentile(validatorRuntime, 0.95),
    totalRuntimeAvgMs: average(totalRuntime),
    totalRuntimeP95Ms: percentile(totalRuntime, 0.95)
  };
}

export function noteLevelSummary(results: MonoWindowResult[]): {
  noteCount: number;
  recoveredNotes: number;
  acceptedStableNotes: number;
  falseActivationNotes: number;
  noteRecall: number;
  notePrecision: number;
} {
  const positive = results.filter((row) => row.expectedAccept && row.windowKind !== 'guard');
  const recoveredNotes = positive.filter((row) => row.accept).length;
  const falseActivationNotes = results.filter((row) => !row.expectedAccept && row.accept).length;
  const acceptedStableNotes = positive.filter((row) => row.accept).length;
  const noteCount = positive.length;
  const notePrecision = acceptedStableNotes + falseActivationNotes > 0
    ? acceptedStableNotes / (acceptedStableNotes + falseActivationNotes)
    : 0;
  const noteRecall = noteCount > 0 ? recoveredNotes / noteCount : 0;
  return {
    noteCount,
    recoveredNotes,
    acceptedStableNotes,
    falseActivationNotes,
    noteRecall,
    notePrecision
  };
}

function isGoodFrame(
  observation: MonoFrameObservation,
  expectedMidi: number | null,
  expectedHz: number | null,
  pitchToleranceCents: number
): boolean {
  if (expectedMidi === null || expectedHz === null) return false;
  if (!observation.detectorAccepted || observation.detectedMidi === null || observation.detectedHz === null) return false;
  const cents = centsDifference(observation.detectedHz, expectedHz);
  return Number.isFinite(cents) && Math.abs(cents) <= pitchToleranceCents;
}

function isWrongNoteFrame(
  observation: MonoFrameObservation,
  expectedMidi: number | null,
  expectedHz: number | null,
  pitchToleranceCents: number
): boolean {
  if (expectedMidi === null || expectedHz === null) return false;
  if (!observation.detectorAccepted || observation.detectedMidi === null || observation.detectedHz === null) return false;
  return !isGoodFrame(observation, expectedMidi, expectedHz, pitchToleranceCents);
}

function buildRejectReason(input: {
  expectedAccept: boolean;
  accept: boolean;
  selectedFrameCount: number;
  targetHitCount: number;
  consecutiveThreshold: number;
  targetHitMask: boolean[];
  wrongNoteMask: boolean[];
  noDetectFrameCount: number;
}): string {
  if (!input.expectedAccept) {
    return input.accept ? 'false_activation' : 'empty_window_rejected';
  }
  if (!input.accept) {
    if (input.selectedFrameCount <= 0) return 'insufficient_window_frames';
    if (input.targetHitCount <= 0) {
      return input.noDetectFrameCount > 0 ? 'target_no_detect' : 'target_missed';
    }
    if (longestConsecutiveTrue(input.targetHitMask) < input.consecutiveThreshold) {
      return 'target_consecutive_frames_too_low';
    }
    if (countTrue(input.wrongNoteMask) > 0) {
      return 'target_wrong_note_contamination';
    }
    return 'target_missed';
  }
  return 'passed';
}

function classifyMismatch(spec: MonoWindowSpec, evidence: MonoWindowEvidence): MonoMismatchType {
  if (!spec.expectedAccept) {
    return evidence.anyActivationFrameCount > 0 ? 'false_activation' : 'empty_window';
  }
  if (evidence.confirmedDetectedMidi === null) {
    return 'missed_target';
  }
  const expectedMidi = spec.expectedMidi;
  if (expectedMidi === null) {
    return 'empty_window';
  }
  if (Math.round(evidence.confirmedDetectedMidi) === expectedMidi) {
    return 'correct_target';
  }
  const diff = Math.round(evidence.confirmedDetectedMidi) - expectedMidi;
  if (Math.abs(diff) === 12) {
    return 'octave_distractor';
  }
  if (Math.abs(diff) <= 2) {
    return 'neighbor_note';
  }
  return 'wrong_note';
}

function addWindow(windows: MonoWindowSpec[], window: MonoWindowSpec, durationSec: number): void {
  const startSec = Math.max(0, roundSec(window.startSec));
  const endSec = Math.min(durationSec, roundSec(window.endSec));
  if (endSec <= startSec) return;
  windows.push({
    ...window,
    startSec,
    endSec
  });
}

function stringBandFor(stringId: number): MonoStringBand {
  if (stringId >= 5) return 'low';
  if (stringId >= 3) return 'mid';
  return 'high';
}

function noteLabelFor(midi: number): string {
  return `midi_${midi}`;
}

function roundSec(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundNumber(value: number, precision = 6): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function average(values: number[]): number {
  if (values.length <= 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length <= 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values: number[], q: number): number {
  if (values.length <= 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.max(0, Math.min(1, q));
  const position = clamped * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function ratio(values: boolean[]): number {
  if (values.length <= 0) return 0;
  return values.filter(Boolean).length / values.length;
}

function longestConsecutiveTrue(values: boolean[]): number {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    if (value) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function uniqueSortedFloats(values: number[]): number[] {
  return [...new Set(values.map((value) => roundSec(value)))].sort((a, b) => a - b);
}

function uniqueSortedIntegers(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value)))].sort((a, b) => a - b);
}

function mostCommonNumber(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? null;
}

function flatten(values: number[][]): number[] {
  return values.flatMap((value) => value);
}

function countTrue(values: boolean[]): number {
  return values.filter(Boolean).length;
}

function resolveScenarioSampleRate(sourceSampleRate: number, sampleRateMode: SampleRateMode): number {
  if (sampleRateMode === 'force_48000') return 48_000;
  if (sampleRateMode === 'force_44100') return 44_100;
  return sourceSampleRate;
}

function resampleMonoSignal(samples: Float32Array, sourceSampleRate: number, targetSampleRate: number): Float32Array {
  const inputLength = Math.max(0, Number(samples.length) || 0);
  if (inputLength <= 0) return new Float32Array(0);
  const srcRate = Math.max(1, Math.round(sourceSampleRate));
  const dstRate = Math.max(1, Math.round(targetSampleRate));
  if (srcRate === dstRate) return samples;

  const outputLength = Math.max(1, Math.round((inputLength * dstRate) / srcRate));
  const out = new Float32Array(outputLength);
  const lastSourceIndex = inputLength - 1;

  for (let i = 0; i < outputLength; i += 1) {
    const sourcePosition = (i * srcRate) / dstRate;
    const left = Math.floor(sourcePosition);
    const right = Math.min(lastSourceIndex, left + 1);
    const fraction = sourcePosition - left;
    const leftSample = Number.isFinite(samples[left]) ? samples[left] : 0;
    const rightSample = Number.isFinite(samples[right]) ? samples[right] : 0;
    out[i] = leftSample + (rightSample - leftSample) * fraction;
  }

  return out;
}

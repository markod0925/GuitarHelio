import type { SpectralRuntimeModel, SpectralRuntimeNote } from '../audio/pitchDetector';

export type WindowType = 'hann' | 'hamming' | 'blackman' | 'rect';
export type PitchDebugInputMode = 'live_mic' | 'file' | 'reference_test' | 'replay';

export interface PitchDetectorConfig {
  enabled: boolean;
  detectorSpecific?: Record<string, unknown>;
}

export interface PitchCandidate {
  pitchHz: number;
  midi?: number;
  noteName?: string;
  cents?: number;
  confidence?: number;
  label?: string;
}

export interface PitchDetectorResult {
  detectorName: string;
  accepted: boolean;
  pitchHz?: number;
  midi?: number;
  noteName?: string;
  cents?: number;
  confidence?: number;
  stringId?: number | null;
  fret?: number | null;
  candidates?: PitchCandidate[];
  rejectReason?: string | null;
  processingTimeMs?: number;
  debug?: Record<string, unknown>;
}

export type ReferenceNoteSelection = {
  enabled: boolean;
  label: string;
  midi: number;
  frequencyHz: number;
  stringId?: number | null;
  fret?: number | null;
  centsTolerance: number;
  harmonicOverlays: number;
};

export type SpectralPeak = {
  bin: number;
  frequencyHz: number;
  magnitude: number;
  magnitudeDb: number;
};

export interface FrameSignalMetrics {
  rms: number;
  rmsDbfs: number;
  peak: number;
  peakDbfs: number;
  crestFactor: number;
  dcOffset: number;
  clippingRatio: number;
  zcr: number;
  spectralCentroidHz: number;
  spectralRolloffHz: number;
  spectralFlatness: number;
  bandEnergy_60_100: number;
  bandEnergy_100_200: number;
  bandEnergy_200_400: number;
  bandEnergy_400_800: number;
  bandEnergy_800_1600: number;
  bandEnergy_1600_3200: number;
  lowBandEnergyRatio: number;
  estimatedNoiseFloorDb: number;
  estimatedSnrDb: number;
  autocorrelationBestLag?: number;
  autocorrelationBestPeak?: number;
  onsetStrength?: number;
  harmonicityScore?: number;
  energyNearE2?: number;
  energyNearE2Harmonic2?: number;
  energyNearE2Harmonic3?: number;
  energyNearE2Harmonic4?: number;
}

export interface PrecomputedFeatures {
  metrics: FrameSignalMetrics;
  fftSize: number;
  magnitudeSpectrum: Float32Array;
  frequencyResolutionHz: number;
  topSpectralPeaks: SpectralPeak[];
  spectralEnergyTotal: number;
  referenceNote: ReferenceNoteSelection | null;
  spectralModel: SpectralRuntimeModel | null;
  candidateNotes: SpectralRuntimeNote[];
}

export interface AudioFrameContext {
  timestampMs: number;
  frameIndex: number;
  sampleRate: number;
  rawFrame: Float32Array;
  processedFrame: Float32Array;
  analysisWindowId: number;
  optionalFeatures?: PrecomputedFeatures;
}

export interface PitchDetectorAdapter {
  name: string;
  init(config: PitchDetectorConfig): Promise<void> | void;
  reset(): void;
  processFrame(input: AudioFrameContext): PitchDetectorResult;
  dispose?(): void;
}

export type AudioCaptureMetadata = {
  mode: PitchDebugInputMode;
  requestedSampleRate: number | null;
  actualSampleRate: number | null;
  requestedBufferSize: number;
  callbackBufferSize: number;
  callbackIntervalMs: number;
  callbackIntervalAvgMs: number;
  callbackIntervalMaxMs: number;
  droppedBuffers: number;
  channels: number;
  unprocessedRequested: boolean;
  processingConstraintsDisabled: boolean;
  inputSource: string;
  deviceLabel: string | null;
  fileName: string | null;
  capturePreset: string;
  lowLatencyRequested: boolean;
  lowLatencyActive: boolean | null;
  androidInfo: string | null;
};

export type AudioCaptureFrame = {
  timestampMs: number;
  rawFrame: Float32Array;
  sampleRate: number;
};

export type PitchDebugFrameSnapshot = {
  frameContext: AudioFrameContext;
  rawMetrics: FrameSignalMetrics;
  features: PrecomputedFeatures;
  detectorResults: PitchDetectorResult[];
  captureMetadata: AudioCaptureMetadata;
  analysisTimeMs: number;
  overload: boolean;
};

export type ReferenceTestNoteDefinition = {
  label: string;
  midi: number;
  frequencyHz: number;
  stringId: number;
  fret: number;
};

export type ReferenceTestFrameRecord = {
  detectorName: string;
  accepted: boolean;
  confidence: number;
  centsError: number | null;
  octaveError: boolean;
  correct: boolean;
};

export type ReferenceTestNoteRun = {
  note: ReferenceTestNoteDefinition;
  startedAtMs: number;
  completedAtMs: number | null;
  framesByDetector: Record<string, ReferenceTestFrameRecord[]>;
};

export type ReferenceTestDetectorSummary = {
  detectorName: string;
  acceptanceRate: number;
  correctNoteRate: number;
  medianCentsError: number | null;
  octaveErrorRate: number;
  medianConfidence: number;
  rejectedFrameRate: number;
};

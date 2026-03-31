import { Capacitor, registerPlugin } from '@capacitor/core';
import type { MaspValidationContext } from '../audio/maspShared';
import type { PitchDetectorPreset, SpectralRuntimeModel } from '../audio/pitchDetector';
import {
  isElectronRuntime,
  requireElectronNativePitchBridge
} from '../../electron/src/audio-bridge';

export type NativePitchDiagnostics = {
  backend_effective?: string;
  backend_requested?: string;
  sample_rate_requested?: number;
  sample_rate_obtained?: number;
  buffer_frames_requested?: number;
  latency_ms?: number;
  preprocessing_active?: boolean;
  device_name?: string;
  requested_input_preset?: string;
  actual_input_preset?: string;
  audio_api?: string;
  sharing_mode?: string;
  performance_mode?: string;
  sample_rate?: number;
  hardware_sample_rate?: number;
  channel_count?: number;
  hardware_channel_count?: number;
  format?: string;
  frames_per_burst?: number;
  frames_per_callback?: number;
  device_id?: number;
  support_unprocessed_property?: boolean;
  stream_state?: string;
  xrun_count?: number;
  fallback_reason?: string | null;
  rms?: number;
  peak?: number;
  noise_floor?: number;
  average_abs?: number;
  callback_count?: number;
  dropped_blocks?: number;
};

export type NativePitchDetectionResult = {
  backend_name?: string;
  timestamp_sec?: number;
  pitch_hz?: number | null;
  midi_estimate?: number | null;
  confidence?: number;
  selected_notes?: Array<{
    note_id?: string | null;
    midi?: number;
    string?: number | null;
    fret?: number | null;
    score?: number;
  }>;
  chord_scores?: Array<{
    chord_id?: string;
    score?: number;
  }>;
  detected_string?: number | null;
  detected_fret?: number | null;
  best_note_id?: string | null;
  rejected_as_reference_bleed?: boolean;
  reference_midi?: number | null;
  reference_correlation?: number;
  energy_ratio_db?: number;
  onset_strength?: number;
  contamination_score?: number;
  validation_passed?: boolean | null;
  reason?: string | null;
  weighted_score?: number | null;
  score_threshold?: number | null;
  processing_time_ms?: number;
  callback_to_result_latency_ms?: number;
  detector_queue_depth?: number;
  dropped_blocks?: number;
  overrun?: boolean;
};

type NativePitchStartResponse = {
  running?: boolean;
  diagnostics?: NativePitchDiagnostics;
};

type NativePitchPollResponse = {
  running?: boolean;
  diagnostics?: NativePitchDiagnostics;
  results?: NativePitchDetectionResult[];
};

type NativePitchInputPlugin = {
  requestMicrophonePermission: () => Promise<{ granted?: boolean }>;
  getDiagnostics: (options: {
    requested_sample_rate?: number;
    channel_count?: number;
    frames_per_callback?: number;
    requested_input_preset?: string;
    performance_mode?: string;
    sharing_mode?: string;
    capture_seconds?: number;
  }) => Promise<{ diagnostics?: NativePitchDiagnostics }>;
  startCapture: (options: {
    backend_name: 'ac14' | 'masp' | 'fretnet' | 'spectral_game_runtime_unified_v3';
    requested_sample_rate?: number;
    block_size?: number;
    channel_count?: number;
    frames_per_callback?: number;
    requested_input_preset?: string;
    performance_mode?: string;
    sharing_mode?: string;
    audio_input_mode?: 'speaker' | 'headphones';
    spectral_model_json?: string;
  }) => Promise<NativePitchStartResponse>;
  stopCapture: () => Promise<NativePitchStartResponse>;
  pollResults: (options: { maxResults?: number }) => Promise<NativePitchPollResponse>;
  updateGameplayContext: (context: Record<string, unknown> | null) => Promise<{ updated?: boolean }>;
  resetDetector: () => Promise<{ reset?: boolean }>;
};

const NativePitchInput = registerPlugin<NativePitchInputPlugin>('NativePitchInput');
let electronNativeCaptureRunning = false;

export function shouldUseNativePitchInput(): boolean {
  return shouldUseAndroidNativePitchInput() || shouldUseElectronNativePitchInput();
}

export async function ensureNativePitchInputPermission(): Promise<boolean> {
  if (shouldUseAndroidNativePitchInput()) {
    const result = await NativePitchInput.requestMicrophonePermission();
    return Boolean(result?.granted);
  }
  if (shouldUseElectronNativePitchInput()) {
    return true;
  }
  return false;
}

export async function getNativePitchDiagnostics(options: {
  requestedSampleRate?: number;
  channelCount?: number;
  framesPerCallback?: number;
  captureSeconds?: number;
} = {}): Promise<NativePitchDiagnostics | null> {
  if (shouldUseAndroidNativePitchInput()) {
    const result = await NativePitchInput.getDiagnostics({
      requested_sample_rate: options.requestedSampleRate,
      channel_count: options.channelCount,
      frames_per_callback: options.framesPerCallback,
      requested_input_preset: 'unprocessed',
      performance_mode: 'low_latency',
      sharing_mode: 'exclusive',
      capture_seconds: options.captureSeconds ?? 2
    });
    return result?.diagnostics ?? null;
  }

  if (shouldUseElectronNativePitchInput()) {
    const bridge = requireElectronNativePitchBridge();
    const diagnosticsResult = toRecord(await bridge.getDiagnostics());
    let diagnostics = toDiagnostics(diagnosticsResult?.diagnostics);

    const sanityResult = toRecord(await bridge.runSanityTest({ captureSeconds: options.captureSeconds ?? 2 }));
    const sanity = toRecord(sanityResult?.sanity);

    if (diagnostics && sanity) {
      diagnostics = {
        ...diagnostics,
        rms: toNumber(sanity.rms) ?? diagnostics.rms,
        peak: toNumber(sanity.peak) ?? diagnostics.peak,
        noise_floor: toNumber(sanity.noise_floor) ?? diagnostics.noise_floor,
        average_abs: toNumber(sanity.average_abs) ?? diagnostics.average_abs,
        callback_count: toNumber(sanity.callback_count) ?? diagnostics.callback_count
      };
    }

    return diagnostics;
  }

  return null;
}

export async function startNativePitchCapture(options: {
  detectorPreset: PitchDetectorPreset;
  requestedSampleRate: number;
  blockSize: number;
  audioInputMode: 'speaker' | 'headphones';
  spectralModel?: SpectralRuntimeModel | null;
}): Promise<NativePitchStartResponse> {
  const backendName = mapPresetToNativeBackend(options.detectorPreset);

  if (shouldUseAndroidNativePitchInput()) {
    return await NativePitchInput.startCapture({
      backend_name: backendName,
      requested_sample_rate: options.requestedSampleRate,
      block_size: options.blockSize,
      channel_count: 1,
      frames_per_callback: 0,
      requested_input_preset: 'unprocessed',
      performance_mode: 'low_latency',
      sharing_mode: 'exclusive',
      audio_input_mode: options.audioInputMode,
      spectral_model_json: options.spectralModel ? JSON.stringify(options.spectralModel) : undefined
    });
  }

  if (shouldUseElectronNativePitchInput()) {
    const bridge = requireElectronNativePitchBridge();
    const response = toRecord(await bridge.startCapture({
      detector: backendName,
      sampleRateHint: options.requestedSampleRate,
      bufferFrames: options.blockSize,
      audioInputMode: options.audioInputMode,
      spectralModelJson: options.spectralModel ? JSON.stringify(options.spectralModel) : undefined
    }));

    const running = toBoolean(response?.running);
    if (running !== undefined) {
      electronNativeCaptureRunning = running;
    }

    return {
      running,
      diagnostics: toDiagnostics(response?.diagnostics) ?? undefined
    };
  }

  throw new Error('Native pitch capture is unavailable in this runtime.');
}

export async function stopNativePitchCapture(): Promise<void> {
  if (shouldUseAndroidNativePitchInput()) {
    await NativePitchInput.stopCapture();
    return;
  }

  if (shouldUseElectronNativePitchInput()) {
    if (!electronNativeCaptureRunning) {
      return;
    }
    const bridge = requireElectronNativePitchBridge();
    try {
      await bridge.stopCapture();
    } finally {
      electronNativeCaptureRunning = false;
    }
  }
}

export async function pollNativePitchResults(maxResults = 4): Promise<NativePitchPollResponse> {
  if (shouldUseAndroidNativePitchInput()) {
    return await NativePitchInput.pollResults({ maxResults });
  }

  if (shouldUseElectronNativePitchInput()) {
    const bridge = requireElectronNativePitchBridge();
    const response = toRecord(await bridge.pollDetections({ maxResults }));
    const running = toBoolean(response?.running);
    if (running !== undefined) {
      electronNativeCaptureRunning = running;
    }

    return {
      running,
      diagnostics: toDiagnostics(response?.diagnostics) ?? undefined,
      results: toDetectionResults(response?.results) ?? []
    };
  }

  return { running: false, results: [] };
}

export async function updateNativePitchGameplayContext(
  context: MaspValidationContext | null
): Promise<void> {
  if (shouldUseAndroidNativePitchInput()) {
    await NativePitchInput.updateGameplayContext(context ? { ...context } : null);
    return;
  }

  if (shouldUseElectronNativePitchInput()) {
    const bridge = requireElectronNativePitchBridge();
    await bridge.updateGameplayContext(context ? { ...context } : null);
  }
}

export async function resetNativePitchDetector(): Promise<void> {
  if (shouldUseAndroidNativePitchInput()) {
    await NativePitchInput.resetDetector();
    return;
  }

  if (shouldUseElectronNativePitchInput()) {
    if (!electronNativeCaptureRunning) {
      return;
    }
    const bridge = requireElectronNativePitchBridge();
    await bridge.resetDetector();
  }
}

function shouldUseAndroidNativePitchInput(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

function shouldUseElectronNativePitchInput(): boolean {
  // Strict policy on desktop Electron: native addon or explicit failure, never WebAudio fallback.
  return isElectronRuntime();
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toNumber(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isFinite(value) === false) {
    return null;
  }
  return value;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value !== 'boolean') {
    return undefined;
  }
  return value;
}

function toDiagnostics(value: unknown): NativePitchDiagnostics | null {
  const record = toRecord(value);
  if (record === null) {
    return null;
  }
  return record as NativePitchDiagnostics;
}

function toDetectionResults(value: unknown): NativePitchDetectionResult[] | null {
  if (Array.isArray(value) === false) {
    return null;
  }
  return value.filter((entry): entry is NativePitchDetectionResult => toRecord(entry) !== null);
}

function mapPresetToNativeBackend(
  preset: PitchDetectorPreset
): 'ac14' | 'masp' | 'fretnet' | 'spectral_game_runtime_unified_v3' {
  if (preset === 'ac14') return 'ac14';
  if (preset === 'fretnet') return 'fretnet';
  if (preset === 'spectral_game_runtime_unified_v3') return 'spectral_game_runtime_unified_v3';
  return 'masp';
}

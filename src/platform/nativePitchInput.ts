import { Capacitor, registerPlugin } from '@capacitor/core';
import type { MaspValidationContext } from '../audio/maspShared';
import type { PitchDetectorPreset, SpectralRuntimeModel } from '../audio/pitchDetector';

export type NativePitchDiagnostics = {
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

export function shouldUseNativePitchInput(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function ensureNativePitchInputPermission(): Promise<boolean> {
  if (!shouldUseNativePitchInput()) {
    return false;
  }
  const result = await NativePitchInput.requestMicrophonePermission();
  return Boolean(result?.granted);
}

export async function getNativePitchDiagnostics(options: {
  requestedSampleRate?: number;
  channelCount?: number;
  framesPerCallback?: number;
  captureSeconds?: number;
} = {}): Promise<NativePitchDiagnostics | null> {
  if (!shouldUseNativePitchInput()) {
    return null;
  }
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

export async function startNativePitchCapture(options: {
  detectorPreset: PitchDetectorPreset;
  requestedSampleRate: number;
  blockSize: number;
  audioInputMode: 'speaker' | 'headphones';
  spectralModel?: SpectralRuntimeModel | null;
}): Promise<NativePitchStartResponse> {
  const backendName = mapPresetToNativeBackend(options.detectorPreset);
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

export async function stopNativePitchCapture(): Promise<void> {
  if (!shouldUseNativePitchInput()) {
    return;
  }
  await NativePitchInput.stopCapture();
}

export async function pollNativePitchResults(maxResults = 4): Promise<NativePitchPollResponse> {
  return await NativePitchInput.pollResults({ maxResults });
}

export async function updateNativePitchGameplayContext(
  context: MaspValidationContext | null
): Promise<void> {
  if (!shouldUseNativePitchInput()) {
    return;
  }
  await NativePitchInput.updateGameplayContext(context ? { ...context } : null);
}

export async function resetNativePitchDetector(): Promise<void> {
  if (!shouldUseNativePitchInput()) {
    return;
  }
  await NativePitchInput.resetDetector();
}

function mapPresetToNativeBackend(
  preset: PitchDetectorPreset
): 'ac14' | 'masp' | 'fretnet' | 'spectral_game_runtime_unified_v3' {
  if (preset === 'ac14') return 'ac14';
  if (preset === 'fretnet') return 'fretnet';
  if (preset === 'spectral_game_runtime_unified_v3') return 'spectral_game_runtime_unified_v3';
  return 'masp';
}

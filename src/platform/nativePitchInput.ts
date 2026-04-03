import { Capacitor, registerPlugin } from '@capacitor/core';
import type { MaspValidationContext } from '../audio/maspShared';
import type { PitchDetectorPreset, SpectralRuntimeModel } from '../audio/pitchDetector';
import {
  isElectronRuntime,
  requireElectronNativePitchBridge
} from '../../electron/src/audio-bridge';

export type NativePitchDiagnostics = {
  backend_name?: string;
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
  total_callback_samples?: number;
  total_staged_samples?: number;
  staged_sample_count?: number;
  all_zero_callback_count?: number;
  silent_callback_count?: number;
  signal_callback_count?: number;
  runtime_sample_rate?: number;
  target_block_size?: number;
  process_condition_check_count?: number;
  process_condition_pass_count?: number;
  process_skip_insufficient_samples_count?: number;
  process_skip_runtime_not_ready_count?: number;
  processed_block_count?: number;
  submitted_sample_count?: number;
  runtime_process_call_count?: number;
  runtime_process_null_result_count?: number;
  runtime_process_error_count?: number;
  emitted_result_count?: number;
  detector_queue_depth?: number;
  discarded_sample_count?: number;
  stop_request_count?: number;
  stop_noop_count?: number;
  reset_request_count?: number;
  reset_while_running_count?: number;
  pending_samples_on_last_stop?: number;
  pending_samples_on_last_reset?: number;
  detector_ready?: boolean;
  last_processing_state?: string | null;
  last_discard_reason?: string | null;
  last_error?: string | null;
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

export type NativePitchDatasetStorageInfo = {
  basePath: string | null;
  rootRelativePath: string;
};

export type NativePitchDatasetTakeResult = {
  recorded: boolean;
  discarded: boolean;
  output_path?: string | null;
  sample_rate?: number;
  channel_count?: number;
  encoding?: string;
  bits_per_sample?: number;
  sample_count?: number;
  duration_sec?: number;
  bytes_written?: number;
  file_exists?: boolean;
  header_valid?: boolean;
  wav_audio_format?: number;
  wav_channels?: number;
  wav_sample_rate?: number;
  wav_bits_per_sample?: number;
  wav_data_bytes?: number;
  validation_error?: string | null;
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

export type NativePitchRuntimeDebugOptions = {
  debugLoggingEnabled: boolean;
  verboseNativePitchDiagnostics: boolean;
  traceFretnetRuntime: boolean;
  nativePitchFileLoggingEnabled: boolean;
};

export type NativePitchDebugLogInfo = {
  enabled: boolean;
  logPath: string | null;
  exists: boolean;
  bytes: number;
  shareableLogPath: string | null;
  shareableExists: boolean;
};

type NativePitchInputPlugin = {
  requestMicrophonePermission: () => Promise<{ granted?: boolean }>;
  getDebugLogInfo: () => Promise<{
    enabled?: boolean;
    logPath?: string | null;
    exists?: boolean;
    bytes?: number;
    shareableLogPath?: string | null;
    shareableExists?: boolean;
  }>;
  shareDebugLog: () => Promise<{ shared?: boolean; logPath?: string | null }>;
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
    debug_logging_enabled?: boolean;
    verbose_native_pitch_diagnostics?: boolean;
    trace_fretnet_runtime?: boolean;
    native_pitch_file_logging_enabled?: boolean;
  }) => Promise<NativePitchStartResponse>;
  stopCapture: () => Promise<NativePitchStartResponse>;
  getDatasetStorageInfo: () => Promise<{
    basePath?: string | null;
    rootRelativePath?: string | null;
  }>;
  datasetStartTake: (options: {
    relative_path: string;
  }) => Promise<NativePitchDatasetTakeResult>;
  datasetStopTake: (options: {
    discard_current?: boolean;
  }) => Promise<NativePitchDatasetTakeResult>;
  pollResults: (options: {
    maxResults?: number;
    includeDiagnostics?: boolean;
  }) => Promise<NativePitchPollResponse>;
  updateGameplayContext: (context: Record<string, unknown> | null) => Promise<{ updated?: boolean }>;
  resetDetector: (options?: { allow_while_running?: boolean }) => Promise<{ reset?: boolean }>;
};

const NativePitchInput = registerPlugin<NativePitchInputPlugin>('NativePitchInput');
let electronNativeCaptureRunning = false;
let androidNativeCaptureRunning = false;
const NATIVE_ANDROID_START_TIMEOUT_MS = 20_000;
const NATIVE_ANDROID_FRETNET_START_TIMEOUT_MS = 35_000;
const NATIVE_PITCH_DEFAULT_DEBUG_OPTIONS: NativePitchRuntimeDebugOptions = {
  debugLoggingEnabled: false,
  verboseNativePitchDiagnostics: false,
  traceFretnetRuntime: false,
  nativePitchFileLoggingEnabled: false
};
let nativePitchRuntimeDebugOptions: NativePitchRuntimeDebugOptions =
  resolveDebugOptionsFromGlobalState();

export function getNativePitchRuntimeDebugOptions(): NativePitchRuntimeDebugOptions {
  return { ...nativePitchRuntimeDebugOptions };
}

export function configureNativePitchRuntimeDebugOptions(
  options: Partial<NativePitchRuntimeDebugOptions>
): NativePitchRuntimeDebugOptions {
  nativePitchRuntimeDebugOptions = {
    ...nativePitchRuntimeDebugOptions,
    ...normalizeDebugOptions(options)
  };
  return { ...nativePitchRuntimeDebugOptions };
}

export function isNativePitchVerboseDiagnosticsEnabled(): boolean {
  return nativePitchRuntimeDebugOptions.verboseNativePitchDiagnostics;
}

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

export async function getNativePitchDebugLogInfo(): Promise<NativePitchDebugLogInfo> {
  if (shouldUseAndroidNativePitchInput()) {
    const result = await NativePitchInput.getDebugLogInfo();
    return {
      enabled: Boolean(result?.enabled),
      logPath: typeof result?.logPath === 'string' ? result.logPath : null,
      exists: Boolean(result?.exists),
      bytes: typeof result?.bytes === 'number' && Number.isFinite(result.bytes) ? result.bytes : 0,
      shareableLogPath: typeof result?.shareableLogPath === 'string' ? result.shareableLogPath : null,
      shareableExists: Boolean(result?.shareableExists)
    };
  }

  return {
    enabled: false,
    logPath: null,
    exists: false,
    bytes: 0,
    shareableLogPath: null,
    shareableExists: false
  };
}

export async function shareNativePitchDebugLog(): Promise<{ logPath: string | null }> {
  if (!shouldUseAndroidNativePitchInput()) {
    throw new Error('Native pitch debug log sharing is available only on Android native runtime.');
  }

  const result = await NativePitchInput.shareDebugLog();
  return {
    logPath: typeof result?.logPath === 'string' ? result.logPath : null
  };
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
  debugOptions?: Partial<NativePitchRuntimeDebugOptions>;
}): Promise<NativePitchStartResponse> {
  const backendName = mapPresetToNativeBackend(options.detectorPreset);
  const debugOptions = resolveDebugOptions(options.debugOptions);

  if (shouldUseAndroidNativePitchInput()) {
    const timeoutMs =
      backendName === 'fretnet'
        ? NATIVE_ANDROID_FRETNET_START_TIMEOUT_MS
        : NATIVE_ANDROID_START_TIMEOUT_MS;
    const response = await withTimeout(
      NativePitchInput.startCapture({
        backend_name: backendName,
        requested_sample_rate: options.requestedSampleRate,
        block_size: options.blockSize,
        channel_count: 1,
        frames_per_callback: 0,
        requested_input_preset: 'unprocessed',
        performance_mode: 'low_latency',
        sharing_mode: 'exclusive',
        audio_input_mode: options.audioInputMode,
        spectral_model_json: options.spectralModel ? JSON.stringify(options.spectralModel) : undefined,
        debug_logging_enabled: debugOptions.debugLoggingEnabled,
        verbose_native_pitch_diagnostics: debugOptions.verboseNativePitchDiagnostics,
        trace_fretnet_runtime: debugOptions.traceFretnetRuntime,
        native_pitch_file_logging_enabled: debugOptions.nativePitchFileLoggingEnabled
      }),
      timeoutMs,
      `Native ${backendName} start timed out after ${Math.round(timeoutMs / 1000)}s.`
    );
    if (typeof response?.running === 'boolean') {
      androidNativeCaptureRunning = response.running;
    } else {
      androidNativeCaptureRunning = true;
    }
    return response;
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
    try {
      await NativePitchInput.stopCapture();
    } finally {
      androidNativeCaptureRunning = false;
    }
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

export async function getNativePitchDatasetStorageInfo(): Promise<NativePitchDatasetStorageInfo | null> {
  if (shouldUseAndroidNativePitchInput()) {
    const result = await NativePitchInput.getDatasetStorageInfo();
    return {
      basePath: typeof result?.basePath === 'string' && result.basePath.trim().length > 0
        ? result.basePath
        : null,
      rootRelativePath: typeof result?.rootRelativePath === 'string' && result.rootRelativePath.trim().length > 0
        ? result.rootRelativePath
        : 'pitch_debug_recordings'
    };
  }
  return null;
}

export async function startNativePitchDatasetTake(relativePath: string): Promise<NativePitchDatasetTakeResult> {
  if (shouldUseAndroidNativePitchInput()) {
    return await NativePitchInput.datasetStartTake({ relative_path: relativePath });
  }
  throw new Error('Native dataset take recording is available only on Android native runtime.');
}

export async function stopNativePitchDatasetTake(discardCurrent = false): Promise<NativePitchDatasetTakeResult> {
  if (shouldUseAndroidNativePitchInput()) {
    return await NativePitchInput.datasetStopTake({ discard_current: discardCurrent });
  }
  throw new Error('Native dataset take recording is available only on Android native runtime.');
}

export async function pollNativePitchResults(
  maxResults = 4,
  options: { includeDiagnostics?: boolean } = {}
): Promise<NativePitchPollResponse> {
  if (shouldUseAndroidNativePitchInput()) {
    const result = await NativePitchInput.pollResults({
      maxResults,
      includeDiagnostics: options.includeDiagnostics ?? true
    });
    if (typeof result?.running === 'boolean') {
      androidNativeCaptureRunning = result.running;
    }
    return result;
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

export async function resetNativePitchDetector(options: { allowWhileRunning?: boolean } = {}): Promise<void> {
  if (shouldUseAndroidNativePitchInput()) {
    const allowWhileRunning = options.allowWhileRunning ?? false;
    if (androidNativeCaptureRunning && !allowWhileRunning) {
      return;
    }
    await NativePitchInput.resetDetector({ allow_while_running: allowWhileRunning });
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

function resolveDebugOptions(
  overrides: Partial<NativePitchRuntimeDebugOptions> | undefined
): NativePitchRuntimeDebugOptions {
  return {
    ...nativePitchRuntimeDebugOptions,
    ...normalizeDebugOptions(overrides)
  };
}

function normalizeDebugOptions(
  options: Partial<NativePitchRuntimeDebugOptions> | undefined
): Partial<NativePitchRuntimeDebugOptions> {
  if (!options) {
    return {};
  }
  const normalized: Partial<NativePitchRuntimeDebugOptions> = {};
  if (typeof options.debugLoggingEnabled === 'boolean') {
    normalized.debugLoggingEnabled = options.debugLoggingEnabled;
  }
  if (typeof options.verboseNativePitchDiagnostics === 'boolean') {
    normalized.verboseNativePitchDiagnostics = options.verboseNativePitchDiagnostics;
  }
  if (typeof options.traceFretnetRuntime === 'boolean') {
    normalized.traceFretnetRuntime = options.traceFretnetRuntime;
  }
  if (typeof options.nativePitchFileLoggingEnabled === 'boolean') {
    normalized.nativePitchFileLoggingEnabled = options.nativePitchFileLoggingEnabled;
  }
  return normalized;
}

function resolveDebugOptionsFromGlobalState(): NativePitchRuntimeDebugOptions {
  return {
    debugLoggingEnabled: readBooleanGlobalFlag('nativePitch.debugLoggingEnabled'),
    verboseNativePitchDiagnostics: readBooleanGlobalFlag('nativePitch.verboseNativePitchDiagnostics'),
    traceFretnetRuntime: readBooleanGlobalFlag('nativePitch.traceFretnetRuntime'),
    nativePitchFileLoggingEnabled: readBooleanGlobalFlag('nativePitch.fileLoggingEnabled')
  };
}

function readBooleanGlobalFlag(storageKey: string): boolean {
  const fromStorage = readLocalStorageValue(storageKey);
  if (fromStorage !== null) {
    return fromStorage;
  }

  const globalFlags = toRecord((globalThis as { __GH_NATIVE_PITCH_DEBUG__?: unknown }).__GH_NATIVE_PITCH_DEBUG__);
  const raw = globalFlags?.[storageKey];
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (storageKey === 'nativePitch.debugLoggingEnabled') {
    return NATIVE_PITCH_DEFAULT_DEBUG_OPTIONS.debugLoggingEnabled;
  }
  if (storageKey === 'nativePitch.verboseNativePitchDiagnostics') {
    return NATIVE_PITCH_DEFAULT_DEBUG_OPTIONS.verboseNativePitchDiagnostics;
  }
  if (storageKey === 'nativePitch.traceFretnetRuntime') {
    return NATIVE_PITCH_DEFAULT_DEBUG_OPTIONS.traceFretnetRuntime;
  }
  return NATIVE_PITCH_DEFAULT_DEBUG_OPTIONS.nativePitchFileLoggingEnabled;
}

function readLocalStorageValue(storageKey: string): boolean | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    const value = localStorage.getItem(storageKey);
    if (value === null) {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
    return null;
  } catch {
    return null;
  }
}

function mapPresetToNativeBackend(
  preset: PitchDetectorPreset
): 'ac14' | 'masp' | 'fretnet' | 'spectral_game_runtime_unified_v3' {
  if (preset === 'ac14') return 'ac14';
  if (preset === 'fretnet') return 'fretnet';
  if (preset === 'spectral_game_runtime_unified_v3') return 'spectral_game_runtime_unified_v3';
  return 'masp';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

import { Capacitor, registerPlugin } from '@capacitor/core';
import { isElectronRuntime, requireElectronNativePitchBridge } from '../../electron/src/audio-bridge.js';
const NativePitchInput = registerPlugin('NativePitchInput');
let electronNativeCaptureRunning = false;
let androidNativeCaptureRunning = false;
const NATIVE_ANDROID_START_TIMEOUT_MS = 20_000;
const NATIVE_ANDROID_FRETNET_START_TIMEOUT_MS = 35_000;
const NATIVE_PITCH_DEFAULT_DEBUG_OPTIONS = {
    debugLoggingEnabled: false,
    verboseNativePitchDiagnostics: false,
    traceFretnetRuntime: false,
    nativePitchFileLoggingEnabled: false
};
let nativePitchRuntimeDebugOptions = resolveDebugOptionsFromGlobalState();
export function getNativePitchRuntimeDebugOptions() {
    return { ...nativePitchRuntimeDebugOptions };
}
export function configureNativePitchRuntimeDebugOptions(options) {
    nativePitchRuntimeDebugOptions = {
        ...nativePitchRuntimeDebugOptions,
        ...normalizeDebugOptions(options)
    };
    return { ...nativePitchRuntimeDebugOptions };
}
export function isNativePitchVerboseDiagnosticsEnabled() {
    return nativePitchRuntimeDebugOptions.verboseNativePitchDiagnostics;
}
export function shouldUseNativePitchInput() {
    return shouldUseAndroidNativePitchInput() || shouldUseElectronNativePitchInput();
}
export async function ensureNativePitchInputPermission() {
    if (shouldUseAndroidNativePitchInput()) {
        const result = await NativePitchInput.requestMicrophonePermission();
        return Boolean(result?.granted);
    }
    if (shouldUseElectronNativePitchInput()) {
        return true;
    }
    return false;
}
export async function getNativePitchDebugLogInfo() {
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
export async function shareNativePitchDebugLog() {
    if (!shouldUseAndroidNativePitchInput()) {
        throw new Error('Native pitch debug log sharing is available only on Android native runtime.');
    }
    const result = await NativePitchInput.shareDebugLog();
    return {
        logPath: typeof result?.logPath === 'string' ? result.logPath : null
    };
}
export async function getNativePitchDiagnostics(options = {}) {
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
export async function startNativePitchCapture(options) {
    const backendName = mapPresetToNativeBackend(options.detectorPreset);
    const debugOptions = resolveDebugOptions(options.debugOptions);
    if (shouldUseAndroidNativePitchInput()) {
        const timeoutMs = backendName === 'fretnet'
            ? NATIVE_ANDROID_FRETNET_START_TIMEOUT_MS
            : NATIVE_ANDROID_START_TIMEOUT_MS;
        const response = await withTimeout(NativePitchInput.startCapture({
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
        }), timeoutMs, `Native ${backendName} start timed out after ${Math.round(timeoutMs / 1000)}s.`);
        if (typeof response?.running === 'boolean') {
            androidNativeCaptureRunning = response.running;
        }
        else {
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
export async function stopNativePitchCapture() {
    if (shouldUseAndroidNativePitchInput()) {
        try {
            await NativePitchInput.stopCapture();
        }
        finally {
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
        }
        finally {
            electronNativeCaptureRunning = false;
        }
    }
}
export async function getNativePitchDatasetStorageInfo() {
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
export async function startNativePitchDatasetTake(relativePath) {
    if (shouldUseAndroidNativePitchInput()) {
        return await NativePitchInput.datasetStartTake({ relative_path: relativePath });
    }
    throw new Error('Native dataset take recording is available only on Android native runtime.');
}
export async function stopNativePitchDatasetTake(discardCurrent = false) {
    if (shouldUseAndroidNativePitchInput()) {
        return await NativePitchInput.datasetStopTake({ discard_current: discardCurrent });
    }
    throw new Error('Native dataset take recording is available only on Android native runtime.');
}
export async function pollNativePitchResults(maxResults = 4, options = {}) {
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
export async function updateNativePitchGameplayContext(context) {
    if (shouldUseAndroidNativePitchInput()) {
        await NativePitchInput.updateGameplayContext(context ? { ...context } : null);
        return;
    }
    if (shouldUseElectronNativePitchInput()) {
        const bridge = requireElectronNativePitchBridge();
        await bridge.updateGameplayContext(context ? { ...context } : null);
    }
}
export async function resetNativePitchDetector(options = {}) {
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
function shouldUseAndroidNativePitchInput() {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}
function shouldUseElectronNativePitchInput() {
    // Strict policy on desktop Electron: native addon or explicit failure, never WebAudio fallback.
    return isElectronRuntime();
}
function toRecord(value) {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    return value;
}
function toNumber(value) {
    if (typeof value !== 'number' || Number.isFinite(value) === false) {
        return null;
    }
    return value;
}
function toBoolean(value) {
    if (typeof value !== 'boolean') {
        return undefined;
    }
    return value;
}
function toDiagnostics(value) {
    const record = toRecord(value);
    if (record === null) {
        return null;
    }
    return record;
}
function toDetectionResults(value) {
    if (Array.isArray(value) === false) {
        return null;
    }
    return value.filter((entry) => toRecord(entry) !== null);
}
function resolveDebugOptions(overrides) {
    return {
        ...nativePitchRuntimeDebugOptions,
        ...normalizeDebugOptions(overrides)
    };
}
function normalizeDebugOptions(options) {
    if (!options) {
        return {};
    }
    const normalized = {};
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
function resolveDebugOptionsFromGlobalState() {
    return {
        debugLoggingEnabled: readBooleanGlobalFlag('nativePitch.debugLoggingEnabled'),
        verboseNativePitchDiagnostics: readBooleanGlobalFlag('nativePitch.verboseNativePitchDiagnostics'),
        traceFretnetRuntime: readBooleanGlobalFlag('nativePitch.traceFretnetRuntime'),
        nativePitchFileLoggingEnabled: readBooleanGlobalFlag('nativePitch.fileLoggingEnabled')
    };
}
function readBooleanGlobalFlag(storageKey) {
    const fromStorage = readLocalStorageValue(storageKey);
    if (fromStorage !== null) {
        return fromStorage;
    }
    const globalFlags = toRecord(globalThis.__GH_NATIVE_PITCH_DEBUG__);
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
function readLocalStorageValue(storageKey) {
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
    }
    catch {
        return null;
    }
}
function mapPresetToNativeBackend(preset) {
    if (preset === 'ac14')
        return 'ac14';
    if (preset === 'fretnet')
        return 'fretnet';
    if (preset === 'pyin')
        return 'pyin';
    if (preset === 'spectral_game_runtime_unified_v3')
        return 'spectral_game_runtime_unified_v3';
    return 'masp';
}
function withTimeout(promise, timeoutMs, message) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return promise;
    }
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(message));
        }, timeoutMs);
        promise.then((value) => {
            clearTimeout(timeoutId);
            resolve(value);
        }, (error) => {
            clearTimeout(timeoutId);
            reject(error);
        });
    });
}

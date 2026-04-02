package com.guitarhelio.app.pitch;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.AssetManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.Nullable;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.zip.ZipFile;

@CapacitorPlugin(
    name = "NativePitchInput",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class NativePitchInputPlugin extends Plugin {
    static {
        System.loadLibrary("native_pitch_input_jni");
    }

    private static final String TAG = "NativePitchInput";
    private static final String MASP_ASSET_DIR = "native-pitch/masp";
    private static final String FRETNET_ASSET_MODEL = "native-pitch/fretnet/model.onnx";
    private static final String FRETNET_ORT_LIBRARY_NAME = "libonnxruntime_fretnet.so";
    private static final String FRETNET_ORT_LIBRARY_FALLBACK_NAME = "libonnxruntime.so";
    private static final String FRETNET_ORT_LIBRARY_BASENAME = "onnxruntime_fretnet";
    private static final String FRETNET_ORT_LIBRARY_FALLBACK_BASENAME = "onnxruntime";
    private static final String SHARE_DEBUG_LOG_TITLE = "Share native pitch debug log";
    private static final String SHARE_DEBUG_LOG_SUBJECT = "GuitarHelio native pitch debug log";
    private static final String SHARE_DEBUG_LOG_TEXT = "GuitarHelio Android native pitch debug log";
    private static final int MAX_LOGGED_JSON_CHARS = 720;
    private static final int POLL_PROGRESS_LOG_EVERY = 80;
    private static final int UPDATE_CONTEXT_PROGRESS_LOG_EVERY = 50;
    private static final long START_CAPTURE_TIMEOUT_MS = 20_000L;
    private static final long START_CAPTURE_FRETNET_TIMEOUT_MS = 35_000L;
    private static final int DEFAULT_INCLUDE_DIAGNOSTICS_EVERY_POLL = 15;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ExecutorService nativeStartExecutor = Executors.newCachedThreadPool();

    private int pollTraceCount = 0;
    private int updateContextTraceCount = 0;
    private volatile boolean debugLoggingEnabled = false;
    private volatile boolean verboseNativePitchDiagnostics = false;
    private volatile boolean traceFretnetRuntime = false;
    private volatile boolean nativePitchFileLoggingEnabled = false;

    private static final class FretnetOrtResolution {
        final String configuredPath;
        final String resolutionStatus;

        FretnetOrtResolution(String configuredPath, String resolutionStatus) {
            this.configuredPath = configuredPath;
            this.resolutionStatus = resolutionStatus;
        }
    }

    private static native String nativeGetDiagnostics(
        int requestedSampleRate,
        int channelCount,
        int framesPerCallback,
        String requestedInputPreset,
        String performanceMode,
        String sharingMode,
        double captureSeconds,
        boolean supportUnprocessedProperty,
        int audioManagerSampleRate,
        int audioManagerFramesPerBuffer
    );

    private static native String nativeStartCapture(
        String backendName,
        int requestedSampleRate,
        int blockSize,
        int channelCount,
        int framesPerCallback,
        String requestedInputPreset,
        String performanceMode,
        String sharingMode,
        String audioInputMode,
        String spectralModelJson,
        String maspAssetsDir,
        String fretnetModelPath,
        String nativeLibraryDir,
        String fretnetOrtLibraryPath,
        boolean supportUnprocessedProperty,
        int audioManagerSampleRate,
        int audioManagerFramesPerBuffer,
        boolean debugLoggingEnabled,
        boolean verboseNativePitchDiagnostics,
        boolean traceFretnetRuntime
    );

    private static native String nativeStopCapture();

    private static native String nativePollResults(int maxResults, boolean includeDiagnostics);

    private static native String nativeUpdateGameplayContext(String contextJson);

    private static native String nativeResetDetector(boolean allowWhileRunning);

    private static native String nativeGetLastStartCheckpoint();

    private static native void nativeHandlePause();

    private static native void nativeHandleResume();

    @Override
    public void load() {
        super.load();
        NativePitchDebugLogger.configure(debugLoggingEnabled, nativePitchFileLoggingEnabled);
        logDebug(
            "Plugin loaded"
                + " | sdk=" + Build.VERSION.SDK_INT
                + " | abi=" + Build.SUPPORTED_ABIS[0]
                + " | debugLogEnabled=" + debugLoggingEnabled
                + " | fileLoggingEnabled=" + nativePitchFileLoggingEnabled
                + " | logFile=" + describePath(NativePitchDebugLogger.resolveCurrentLogFile(getContext()))
        );
    }

    @PluginMethod
    public void getDebugLogInfo(PluginCall call) {
        File currentLog = NativePitchDebugLogger.resolveCurrentLogFile(getContext());
        File shareableLog = NativePitchDebugLogger.resolveShareableLogFile(getContext());

        JSObject result = new JSObject();
        result.put("enabled", NativePitchDebugLogger.isFileLoggingEnabled());
        result.put("logPath", currentLog != null ? currentLog.getAbsolutePath() : null);
        result.put("exists", currentLog != null && currentLog.exists());
        result.put("bytes", currentLog != null && currentLog.exists() ? currentLog.length() : 0);
        result.put("shareableLogPath", shareableLog != null ? shareableLog.getAbsolutePath() : null);
        result.put("shareableExists", shareableLog != null && shareableLog.exists() && shareableLog.length() > 0);
        call.resolve(result);
    }

    @PluginMethod
    public void shareDebugLog(PluginCall call) {
        try {
            if (getActivity() == null) {
                call.reject("Android activity unavailable.");
                return;
            }

            File logFile = NativePitchDebugLogger.resolveShareableLogFile(getContext());
            if (logFile == null || !logFile.exists() || logFile.length() <= 0) {
                call.reject("Native pitch debug log not found.");
                return;
            }

            String authority = getContext().getPackageName() + ".fileprovider";
            Uri fileUri = FileProvider.getUriForFile(getContext(), authority, logFile);

            Intent shareIntent = new Intent(Intent.ACTION_SEND);
            shareIntent.setType("text/plain");
            shareIntent.putExtra(Intent.EXTRA_STREAM, fileUri);
            shareIntent.putExtra(Intent.EXTRA_SUBJECT, SHARE_DEBUG_LOG_SUBJECT);
            shareIntent.putExtra(Intent.EXTRA_TEXT, SHARE_DEBUG_LOG_TEXT);
            shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooserIntent = Intent.createChooser(shareIntent, SHARE_DEBUG_LOG_TITLE);
            chooserIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            logDebug("Share debug log requested | logFile=" + describePath(logFile));
            getActivity().startActivity(chooserIntent);

            JSObject result = new JSObject();
            result.put("shared", true);
            result.put("logPath", logFile.getAbsolutePath());
            call.resolve(result);
        } catch (ActivityNotFoundException error) {
            logDebug("Share debug log failed: no app can handle ACTION_SEND.", error);
            call.reject("No Android app can share this file.", error);
        } catch (IllegalArgumentException error) {
            logDebug("Share debug log failed: FileProvider rejected path.", error);
            call.reject("Native pitch debug log cannot be shared from this path.", error);
        } catch (Exception error) {
            logDebug("Share debug log failed.", error);
            call.reject("Failed to share native pitch debug log.", error);
        }
    }

    @PluginMethod
    public void requestMicrophonePermission(PluginCall call) {
        logDebug("IPC requestMicrophonePermission begin.");
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            logDebug("IPC requestMicrophonePermission success | alreadyGranted=true");
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
    }

    @PermissionCallback
    private void microphonePermissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        boolean granted = getPermissionState("microphone") == PermissionState.GRANTED;
        result.put("granted", granted);
        if (granted) {
            logDebug("IPC requestMicrophonePermission success | granted=true");
            call.resolve(result);
        } else {
            logDebug("IPC requestMicrophonePermission failed | granted=false");
            call.reject("Microphone permission denied.", (Exception) null, result);
        }
    }

    @PluginMethod
    public void getDiagnostics(PluginCall call) {
        if (!ensureMicrophonePermission(call)) {
            return;
        }
        JSObject config = buildNativeConfig(call, false);
        logDebug(
            "IPC getDiagnostics begin"
                + " | sr=" + config.optInt("requested_sample_rate", 48_000)
                + " | channels=" + config.optInt("channel_count", 1)
                + " | callbackFrames=" + config.optInt("frames_per_callback", 0)
                + " | captureSeconds=" + config.optDouble("capture_seconds", 2.0)
        );
        executeNativeJson(call, "getDiagnostics", () -> nativeGetDiagnostics(
            config.optInt("requested_sample_rate", 48_000),
            config.optInt("channel_count", 1),
            config.optInt("frames_per_callback", 0),
            config.optString("requested_input_preset", "unprocessed"),
            config.optString("performance_mode", "low_latency"),
            config.optString("sharing_mode", "exclusive"),
            config.optDouble("capture_seconds", 2.0),
            config.optBoolean("support_unprocessed_property", false),
            config.optInt("audio_manager_sample_rate", 0),
            config.optInt("audio_manager_frames_per_buffer", 0)
        ));
    }

    @PluginMethod
    public void startCapture(PluginCall call) {
        if (!ensureMicrophonePermission(call)) {
            return;
        }
        JSObject config = buildNativeConfig(call, true);
        String backendName = firstNonEmpty(config.getString("backend_name"), "ac14");
        long timeoutMs = resolveStartCaptureTimeoutMs(backendName);
        String fretnetOrtError = prepareFretnetOrtLibrary(config);
        if (fretnetOrtError != null) {
            logDebug("IPC startCapture rejected before native call: " + fretnetOrtError);
            call.reject(fretnetOrtError);
            return;
        }
        logDebug(
            "IPC startCapture begin"
                + " | backend=" + backendName
                + " | sr=" + config.optInt("requested_sample_rate", 48_000)
                + " | blockSize=" + config.optInt("block_size", 2048)
                + " | callbackFrames=" + config.optInt("frames_per_callback", 0)
                + " | preset=" + config.optString("requested_input_preset", "unprocessed")
                + " | perf=" + config.optString("performance_mode", "low_latency")
                + " | sharing=" + config.optString("sharing_mode", "exclusive")
                + " | audioMode=" + config.optString("audio_input_mode", "speaker")
                + " | fretnetOrt=" + firstNonEmpty(config.optString("fretnet_ort_library_path", ""), "<none>")
                + " | fretnetOrtResolution=" + firstNonEmpty(config.optString("fretnet_ort_resolution_status", ""), "<none>")
                + " | fretnetOrtLoad=" + firstNonEmpty(config.optString("fretnet_ort_load_status", ""), "<none>")
                + " | timeoutMs=" + timeoutMs
        );
        String assetError = validateRuntimeAssets(config);
        if (assetError != null) {
            logDebug("IPC startCapture rejected before native call: " + assetError);
            call.reject(assetError);
            return;
        }

        executor.execute(() -> {
            Future<String> startFuture = nativeStartExecutor.submit(() -> nativeStartCapture(
                backendName,
                config.optInt("requested_sample_rate", 48_000),
                config.optInt("block_size", 2048),
                config.optInt("channel_count", 1),
                config.optInt("frames_per_callback", 0),
                config.optString("requested_input_preset", "unprocessed"),
                config.optString("performance_mode", "low_latency"),
                config.optString("sharing_mode", "exclusive"),
                config.optString("audio_input_mode", "speaker"),
                config.optString("spectral_model_json", ""),
                config.optString("masp_assets_dir", ""),
                config.optString("fretnet_model_path", ""),
                config.optString("native_library_dir", ""),
                config.optString("fretnet_ort_library_path", ""),
                config.optBoolean("support_unprocessed_property", false),
                config.optInt("audio_manager_sample_rate", 0),
                config.optInt("audio_manager_frames_per_buffer", 0),
                config.optBoolean("debug_logging_enabled", false),
                config.optBoolean("verbose_native_pitch_diagnostics", false),
                config.optBoolean("trace_fretnet_runtime", false)
            ));
            try {
                String rawJson = startFuture.get(timeoutMs, TimeUnit.MILLISECONDS);
                resolveNativeJson(call, "startCapture", rawJson);
            } catch (TimeoutException timeoutError) {
                boolean cancelled = startFuture.cancel(true);
                String nativeCheckpoint = readNativeStartCheckpoint();
                String timeoutMessage =
                    "Native " + backendName + " start timed out after " + Math.max(1L, timeoutMs / 1000L) + "s.";
                logDebug(
                    "IPC startCapture timed out | backend=" + backendName
                        + " | timeoutMs=" + timeoutMs
                        + " | cancelAttempted=" + cancelled
                        + " | nativeCheckpoint=" + nativeCheckpoint
                );
                call.reject(timeoutMessage + " Last native checkpoint: " + nativeCheckpoint + ".");
            } catch (Exception error) {
                String nativeCheckpoint = readNativeStartCheckpoint();
                logDebug("IPC startCapture failed before JSON parsing. | nativeCheckpoint=" + nativeCheckpoint, error);
                call.reject("Native pitch runtime call failed. Last native checkpoint: " + nativeCheckpoint + ".", error);
            }
        });
    }

    @PluginMethod
    public void stopCapture(PluginCall call) {
        logDebug("IPC stopCapture begin.");
        executeNativeJson(call, "stopCapture", NativePitchInputPlugin::nativeStopCapture);
    }

    @PluginMethod
    public void pollResults(PluginCall call) {
        int maxResults = Math.max(1, call.getInt("maxResults", 4));
        int includeDiagnosticsEvery = verboseNativePitchDiagnostics ? 1 : DEFAULT_INCLUDE_DIAGNOSTICS_EVERY_POLL;
        pollTraceCount += 1;
        boolean includeDiagnostics = call.getBoolean("includeDiagnostics", false)
            || pollTraceCount == 1
            || (includeDiagnosticsEvery > 0 && pollTraceCount % includeDiagnosticsEvery == 0);
        if (pollTraceCount % POLL_PROGRESS_LOG_EVERY == 1) {
            logDebug(
                "IPC pollResults progress | count=" + pollTraceCount
                    + " | maxResults=" + maxResults
                    + " | includeDiagnostics=" + includeDiagnostics
            );
        }
        resolveNativeJson(call, "pollResults", nativePollResults(maxResults, includeDiagnostics));
    }

    @PluginMethod
    public void updateGameplayContext(PluginCall call) {
        JSObject payload = call.getData();
        updateContextTraceCount += 1;
        if (updateContextTraceCount % UPDATE_CONTEXT_PROGRESS_LOG_EVERY == 1) {
            logDebug("IPC updateGameplayContext progress | count=" + updateContextTraceCount);
        }
        executeNativeJson(call, "updateGameplayContext", () -> nativeUpdateGameplayContext(payload.toString()));
    }

    @PluginMethod
    public void resetDetector(PluginCall call) {
        boolean allowWhileRunning = call.getBoolean("allow_while_running", false);
        logDebug("IPC resetDetector begin. | allowWhileRunning=" + allowWhileRunning);
        executeNativeJson(call, "resetDetector", () -> nativeResetDetector(allowWhileRunning));
    }

    @Override
    protected void handleOnPause() {
        logDebug("Lifecycle handleOnPause.");
        nativeHandlePause();
        super.handleOnPause();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        logDebug("Lifecycle handleOnResume.");
        nativeHandleResume();
    }

    @Override
    protected void handleOnDestroy() {
        try {
            logDebug("Lifecycle handleOnDestroy: stopping native runtime.");
            nativeStopCapture();
        } catch (Exception error) {
            logDebug("Failed to stop native pitch runtime during destroy.", error);
        }
        nativeStartExecutor.shutdownNow();
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    private long resolveStartCaptureTimeoutMs(String backendName) {
        return "fretnet".equals(backendName)
            ? START_CAPTURE_FRETNET_TIMEOUT_MS
            : START_CAPTURE_TIMEOUT_MS;
    }

    private boolean ensureMicrophonePermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            return true;
        }
        logDebug("Rejecting call: microphone permission is required.");
        call.reject("Microphone permission is required.");
        return false;
    }

    private JSObject buildNativeConfig(PluginCall call, boolean includeRuntimeAssets) {
        JSObject payload = call.getData();
        File fretnetOrtLibrary = null;
        Context context = getContext();
        AudioManager audioManager = context != null
            ? (AudioManager) context.getSystemService(Context.AUDIO_SERVICE)
            : null;
        int propertySampleRate = parseIntegerProperty(audioManager, AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE);
        int propertyFramesPerBuffer = parseIntegerProperty(audioManager, AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER);

        payload.put("requested_input_preset", firstNonEmpty(payload.getString("requested_input_preset"), "unprocessed"));
        payload.put("performance_mode", firstNonEmpty(payload.getString("performance_mode"), "low_latency"));
        payload.put("sharing_mode", firstNonEmpty(payload.getString("sharing_mode"), "exclusive"));
        payload.put("requested_sample_rate", Math.max(8_000, payload.optInt("requested_sample_rate", 48_000)));
        payload.put("channel_count", Math.max(1, payload.optInt("channel_count", 1)));
        payload.put("frames_per_callback", Math.max(0, payload.optInt("frames_per_callback", 0)));
        payload.put("capture_seconds", Math.max(0.0, payload.optDouble("capture_seconds", 2.0)));
        payload.put("debug_logging_enabled", payload.optBoolean("debug_logging_enabled", false));
        payload.put("verbose_native_pitch_diagnostics", payload.optBoolean("verbose_native_pitch_diagnostics", false));
        payload.put("trace_fretnet_runtime", payload.optBoolean("trace_fretnet_runtime", false));
        payload.put("native_pitch_file_logging_enabled", payload.optBoolean("native_pitch_file_logging_enabled", false));
        payload.put("support_unprocessed_property", supportsUnprocessedInput(audioManager));
        payload.put("audio_manager_sample_rate", propertySampleRate);
        payload.put("audio_manager_frames_per_buffer", propertyFramesPerBuffer);
        applyRuntimeDebugConfig(payload);
        logDebug(
            "Native config resolved"
                + " | requestedSr=" + payload.optInt("requested_sample_rate", 48_000)
                + " | requestedChannels=" + payload.optInt("channel_count", 1)
                + " | requestedCallbackFrames=" + payload.optInt("frames_per_callback", 0)
                + " | requestedPreset=" + payload.optString("requested_input_preset", "unprocessed")
                + " | perf=" + payload.optString("performance_mode", "low_latency")
                + " | sharing=" + payload.optString("sharing_mode", "exclusive")
                + " | supportUnprocessed=" + payload.optBoolean("support_unprocessed_property", false)
                + " | audioManagerSr=" + propertySampleRate
                + " | audioManagerFramesPerBuffer=" + propertyFramesPerBuffer
                + " | debugLogging=" + debugLoggingEnabled
                + " | verboseDiagnostics=" + verboseNativePitchDiagnostics
                + " | traceFretnetRuntime=" + traceFretnetRuntime
                + " | fileLogging=" + nativePitchFileLoggingEnabled
        );

        if (context != null) {
            String nativeLibraryDir = context.getApplicationInfo().nativeLibraryDir;
            payload.put("native_library_dir", nativeLibraryDir);
            FretnetOrtResolution fretnetOrtResolution = resolveFretnetOrtLibrary(context, nativeLibraryDir);
            if (!fretnetOrtResolution.configuredPath.isEmpty()) {
                payload.put("fretnet_ort_library_path", fretnetOrtResolution.configuredPath);
                File candidate = new File(fretnetOrtResolution.configuredPath);
                fretnetOrtLibrary = candidate.isAbsolute()
                    ? candidate
                    : (nativeLibraryDir == null || nativeLibraryDir.trim().isEmpty()
                        ? candidate
                        : new File(nativeLibraryDir, candidate.getPath()));
            }
            payload.put("fretnet_ort_resolution_status", fretnetOrtResolution.resolutionStatus);
            payload.put("cache_dir", context.getCacheDir().getAbsolutePath());
            payload.put("files_dir", context.getFilesDir().getAbsolutePath());
        }

        if (includeRuntimeAssets) {
            File maspDir = copyAssetDirectoryIfPresent(MASP_ASSET_DIR, "native-pitch/masp");
            if (maspDir != null) {
                payload.put("masp_assets_dir", maspDir.getAbsolutePath());
            }
            File fretnetModel = copyAssetFileIfPresent(FRETNET_ASSET_MODEL, "native-pitch/fretnet/model.onnx");
            if (fretnetModel != null) {
                payload.put("fretnet_model_path", fretnetModel.getAbsolutePath());
            }
            logDebug(
                "Runtime assets staged"
                    + " | maspDir=" + describePath(maspDir)
                    + " | fretnetModel=" + describePath(fretnetModel)
                    + " | fretnetOrt=" + describePath(fretnetOrtLibrary)
                    + " | fretnetOrtResolution=" + firstNonEmpty(payload.optString("fretnet_ort_resolution_status", ""), "<none>")
            );
        }

        return payload;
    }

    @Nullable
    private String validateRuntimeAssets(JSObject config) {
        String backendName = firstNonEmpty(config.getString("backend_name"), "ac14");
        String modelPath = config.optString("fretnet_model_path", "").trim();
        if ("fretnet".equals(backendName) && modelPath.isEmpty()) {
            return "FRETNET model asset missing. Expected Android asset native-pitch/fretnet/model.onnx. "
                + "Stage the exported ONNX model before building the APK.";
        }
        if ("fretnet".equals(backendName)) {
            File modelFile = new File(modelPath);
            if (!modelFile.exists() || modelFile.length() <= 0) {
                return "FRETNET model asset staged to an invalid path: " + describePath(modelFile);
            }
            String ortPath = config.optString("fretnet_ort_library_path", "").trim();
            if (ortPath.isEmpty()) {
                return "FRETNET ONNX Runtime library missing. Expected Android JNI lib "
                    + FRETNET_ORT_LIBRARY_NAME + " (or fallback " + FRETNET_ORT_LIBRARY_FALLBACK_NAME + "). "
                    + "Resolution=" + firstNonEmpty(config.optString("fretnet_ort_resolution_status", ""), "unresolved")
                    + ". Load=" + firstNonEmpty(config.optString("fretnet_ort_load_status", ""), "not_attempted") + ".";
            }
            File ortFile = new File(ortPath);
            if (ortFile.isAbsolute() && !ortFile.exists()) {
                return "FRETNET ONNX Runtime library staged to an invalid path: " + describePath(ortFile);
            }
        }
        if (("masp".equals(backendName) || "masp_game_scene_ts_v1".equals(backendName))
            && config.optString("masp_assets_dir", "").trim().isEmpty()) {
            return "MASP assets missing. Expected Android assets under native-pitch/masp.";
        }
        return null;
    }

    private void executeNativeJson(PluginCall call, String methodName, NativeCall nativeCall) {
        executor.execute(() -> {
            try {
                resolveNativeJson(call, methodName, nativeCall.run());
            } catch (Exception error) {
                logDebug("IPC " + methodName + " failed before JSON parsing.", error);
                call.reject("Native pitch runtime call failed.", error);
            }
        });
    }

    private void resolveNativeJson(PluginCall call, String methodName, String rawJson) {
        String normalizedJson = rawJson == null ? "" : rawJson.trim();
        if (normalizedJson.isEmpty()) {
            normalizedJson = "{\"ok\":false,\"error\":\"Native pitch runtime returned empty JSON.\"}";
        }

        try {
            JSONObject payload = new JSONObject(normalizedJson);
            boolean ok = payload.optBoolean("ok", true);
            if (!ok) {
                String error = firstNonEmpty(payload.optString("error", null), "Native pitch runtime failed.");
                logDebug(
                    "IPC " + methodName + " failed"
                        + " | error=" + error
                        + " | payload=" + truncate(normalizedJson)
                );
                call.reject(error, (Exception) null, toJsObject(payload));
                return;
            }

            String successSummary = successSummary(methodName, payload);
            if (!successSummary.isEmpty()) {
                logDebug("IPC " + methodName + " success" + " | " + successSummary);
            }
            call.resolve(toJsObject(payload));
        } catch (JSONException error) {
            logDebug(
                "IPC " + methodName + " invalid JSON"
                    + " | payload=" + truncate(normalizedJson),
                error
            );
            call.reject("Native pitch runtime returned invalid JSON.", error);
        }
    }

    private String successSummary(String methodName, JSONObject payload) {
        if ("pollResults".equals(methodName)) {
            JSONArray results = payload.optJSONArray("results");
            int count = results != null ? results.length() : 0;
            boolean running = payload.optBoolean("running", true);
            JSONObject diagnostics = payload.optJSONObject("diagnostics");
            String fallbackReason = diagnostics != null ? diagnostics.optString("fallback_reason", "") : "";
            boolean hasError = diagnostics != null
                && !diagnostics.optString("last_error", "").isEmpty();
            if (!verboseNativePitchDiagnostics && running && fallbackReason.isEmpty() && !hasError) {
                return "";
            }
            return "running=" + running + " | results=" + count + (fallbackReason.isEmpty() ? "" : " | fallback=" + fallbackReason);
        }

        if ("updateGameplayContext".equals(methodName)) {
            return "";
        }

        if ("getDiagnostics".equals(methodName) || "startCapture".equals(methodName) || "stopCapture".equals(methodName)) {
            JSONObject diagnostics = payload.optJSONObject("diagnostics");
            if (diagnostics == null) {
                return "running=" + payload.optBoolean("running", false);
            }
            return "running=" + payload.optBoolean("running", false)
                + " | backend=" + diagnostics.optString("backend_name", "unknown")
                + " | state=" + diagnostics.optString("stream_state", "unknown")
                + " | audioApi=" + diagnostics.optString("audio_api", "unknown")
                + " | sr=" + diagnostics.optInt("sample_rate", 0)
                + " | runtimeSr=" + diagnostics.optInt("runtime_sample_rate", 0)
                + " | callback=" + diagnostics.optInt("frames_per_callback", 0)
                + " | callbacks=" + diagnostics.optLong("callback_count", 0L)
                + " | staged=" + diagnostics.optLong("staged_sample_count", 0L)
                + "/" + diagnostics.optLong("target_block_size", 0L)
                + " | signalCallbacks=" + diagnostics.optLong("signal_callback_count", 0L)
                + " | zeroCallbacks=" + diagnostics.optLong("all_zero_callback_count", 0L)
                + " | checks=" + diagnostics.optLong("process_condition_check_count", 0L)
                + " | passes=" + diagnostics.optLong("process_condition_pass_count", 0L)
                + " | processedBlocks=" + diagnostics.optLong("processed_block_count", 0L)
                + " | emittedResults=" + diagnostics.optLong("emitted_result_count", 0L)
                + " | lastProcessingState=" + diagnostics.optString("last_processing_state", "")
                + (diagnostics.optString("fallback_reason", "").isEmpty()
                ? ""
                : " | fallback=" + diagnostics.optString("fallback_reason", ""))
                + (diagnostics.optString("last_error", "").isEmpty()
                ? ""
                : " | lastError=" + diagnostics.optString("last_error", ""));
        }

        return "ok=true";
    }

    private JSObject toJsObject(JSONObject object) throws JSONException {
        JSObject out = new JSObject();
        JSONArray names = object.names();
        if (names == null) {
            return out;
        }
        for (int index = 0; index < names.length(); index += 1) {
            String key = names.getString(index);
            out.put(key, convertJsonValue(object.get(key)));
        }
        return out;
    }

    private Object convertJsonValue(Object value) throws JSONException {
        if (value == null || value == JSONObject.NULL) {
            return null;
        }
        if (value instanceof JSONObject) {
            return toJsObject((JSONObject) value);
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            JSArray out = new JSArray();
            for (int index = 0; index < array.length(); index += 1) {
                out.put(convertJsonValue(array.get(index)));
            }
            return out;
        }
        return value;
    }

    private void applyRuntimeDebugConfig(JSObject payload) {
        debugLoggingEnabled = payload.optBoolean("debug_logging_enabled", false);
        verboseNativePitchDiagnostics = payload.optBoolean("verbose_native_pitch_diagnostics", false);
        traceFretnetRuntime = payload.optBoolean("trace_fretnet_runtime", false);
        nativePitchFileLoggingEnabled = payload.optBoolean("native_pitch_file_logging_enabled", false);
        NativePitchDebugLogger.configure(debugLoggingEnabled, nativePitchFileLoggingEnabled);
    }

    private int parseIntegerProperty(@Nullable AudioManager audioManager, String property) {
        if (audioManager == null) {
            return 0;
        }
        try {
            String value = audioManager.getProperty(property);
            if (value == null || value.trim().isEmpty()) {
                return 0;
            }
            return Integer.parseInt(value.trim());
        } catch (Exception error) {
            logDebug("Failed to parse AudioManager property " + property, error);
            return 0;
        }
    }

    private boolean supportsUnprocessedInput(@Nullable AudioManager audioManager) {
        if (audioManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            return false;
        }
        try {
            return audioManager.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) != null;
        } catch (Exception error) {
            logDebug("Failed to query unprocessed-input support", error);
            return false;
        }
    }

    private FretnetOrtResolution resolveFretnetOrtLibrary(@Nullable Context context, @Nullable String nativeLibraryDir) {
        String normalizedDir = nativeLibraryDir == null ? "" : nativeLibraryDir.trim();
        if (!normalizedDir.isEmpty()) {
            File preferred = new File(normalizedDir, FRETNET_ORT_LIBRARY_NAME);
            if (preferred.exists()) {
                return new FretnetOrtResolution(
                    preferred.getAbsolutePath(),
                    "nativeLibraryDir:preferred_exists"
                );
            }
            File fallback = new File(normalizedDir, FRETNET_ORT_LIBRARY_FALLBACK_NAME);
            if (fallback.exists()) {
                return new FretnetOrtResolution(
                    fallback.getAbsolutePath(),
                    "nativeLibraryDir:fallback_exists"
                );
            }
        }

        FretnetOrtResolution packagedResolution = resolvePackagedFretnetOrtLibrary(context);
        if (packagedResolution != null) {
            return packagedResolution;
        }

        return new FretnetOrtResolution(
            "",
            normalizedDir.isEmpty()
                ? "nativeLibraryDir:missing"
                : "nativeLibraryDir:missing_required_ort_library"
        );
    }

    @Nullable
    private FretnetOrtResolution resolvePackagedFretnetOrtLibrary(@Nullable Context context) {
        if (context == null) {
            return null;
        }

        ApplicationInfo applicationInfo = context.getApplicationInfo();
        if (apkContainsNativeLibrary(applicationInfo.sourceDir, FRETNET_ORT_LIBRARY_NAME)) {
            return new FretnetOrtResolution(
                FRETNET_ORT_LIBRARY_NAME,
                "apk:preferred_packaged"
            );
        }
        if (apkContainsNativeLibrary(applicationInfo.sourceDir, FRETNET_ORT_LIBRARY_FALLBACK_NAME)) {
            return new FretnetOrtResolution(
                FRETNET_ORT_LIBRARY_FALLBACK_NAME,
                "apk:fallback_packaged"
            );
        }
        if (applicationInfo.splitSourceDirs != null) {
            for (String splitSourceDir : applicationInfo.splitSourceDirs) {
                if (apkContainsNativeLibrary(splitSourceDir, FRETNET_ORT_LIBRARY_NAME)) {
                    return new FretnetOrtResolution(
                        FRETNET_ORT_LIBRARY_NAME,
                        "apk:preferred_packaged"
                    );
                }
                if (apkContainsNativeLibrary(splitSourceDir, FRETNET_ORT_LIBRARY_FALLBACK_NAME)) {
                    return new FretnetOrtResolution(
                        FRETNET_ORT_LIBRARY_FALLBACK_NAME,
                        "apk:fallback_packaged"
                    );
                }
            }
        }
        return null;
    }

    private boolean apkContainsNativeLibrary(@Nullable String apkPath, String libraryName) {
        String normalizedApkPath = apkPath == null ? "" : apkPath.trim();
        if (normalizedApkPath.isEmpty()) {
            return false;
        }
        try (ZipFile zipFile = new ZipFile(normalizedApkPath)) {
            for (String abi : Build.SUPPORTED_ABIS) {
                String normalizedAbi = abi == null ? "" : abi.trim();
                if (normalizedAbi.isEmpty()) {
                    continue;
                }
                if (zipFile.getEntry("lib/" + normalizedAbi + "/" + libraryName) != null) {
                    return true;
                }
            }
        } catch (IOException error) {
            logDebug("Failed to inspect APK for native library " + libraryName + " at " + normalizedApkPath, error);
        }
        return false;
    }

    @Nullable
    private String prepareFretnetOrtLibrary(JSObject config) {
        String backendName = firstNonEmpty(config.getString("backend_name"), "ac14");
        if (!"fretnet".equals(backendName)) {
            return null;
        }

        String configuredPath = config.optString("fretnet_ort_library_path", "").trim();
        String resolutionStatus = firstNonEmpty(config.optString("fretnet_ort_resolution_status", ""), "unresolved");

        File candidate = new File(configuredPath);
        if (!configuredPath.isEmpty() && candidate.isAbsolute()) {
            if (!candidate.exists()) {
                logDebug("FRETNET ORT absolute candidate missing: " + candidate.getAbsolutePath());
                config.put("fretnet_ort_load_status", "failed:absolute_missing");
            } else {
                try {
                    System.load(candidate.getAbsolutePath());
                    config.put("fretnet_ort_load_status", "loaded:absolute");
                    return null;
                } catch (UnsatisfiedLinkError absoluteError) {
                    logDebug("FRETNET ORT absolute load failed: " + candidate.getAbsolutePath(), absoluteError);
                }
            }
        }

        try {
            System.loadLibrary(FRETNET_ORT_LIBRARY_BASENAME);
            config.put("fretnet_ort_library_path", FRETNET_ORT_LIBRARY_NAME);
            config.put("fretnet_ort_load_status", "loaded:library:" + FRETNET_ORT_LIBRARY_BASENAME);
            return null;
        } catch (UnsatisfiedLinkError preferredError) {
            logDebug("FRETNET ORT preferred library load failed.", preferredError);
            try {
                System.loadLibrary(FRETNET_ORT_LIBRARY_FALLBACK_BASENAME);
                config.put("fretnet_ort_library_path", FRETNET_ORT_LIBRARY_FALLBACK_NAME);
                config.put("fretnet_ort_load_status", "loaded:library:" + FRETNET_ORT_LIBRARY_FALLBACK_BASENAME);
                return null;
            } catch (UnsatisfiedLinkError fallbackError) {
                logDebug("FRETNET ORT fallback library load failed.", fallbackError);
                String message =
                    "FRETNET ONNX Runtime library unavailable on Android. Resolution=" + resolutionStatus
                        + ". Preferred load failed: " + preferredError.getMessage()
                        + ". Fallback load failed: " + fallbackError.getMessage()
                        + ". Expected " + FRETNET_ORT_LIBRARY_NAME + " or " + FRETNET_ORT_LIBRARY_FALLBACK_NAME
                        + " packaged in the APK or available from the app native library directory.";
                config.put("fretnet_ort_load_status", "failed");
                return message;
            }
        }
    }

    @Nullable
    private File copyAssetDirectoryIfPresent(String assetPath, String relativeOutputDir) {
        Context context = getContext();
        if (context == null) {
            return null;
        }
        try {
            AssetManager assetManager = context.getAssets();
            String[] children = assetManager.list(assetPath);
            if (children == null || children.length == 0) {
                return null;
            }
            File outputDir = new File(context.getFilesDir(), relativeOutputDir);
            if (!outputDir.exists() && !outputDir.mkdirs()) {
                throw new IOException("Could not create asset output directory: " + outputDir.getAbsolutePath());
            }
            copyAssetDirectoryRecursive(assetManager, assetPath, outputDir);
            return outputDir;
        } catch (IOException error) {
            logDebug("Failed to stage asset directory " + assetPath, error);
            return null;
        }
    }

    @Nullable
    private File copyAssetFileIfPresent(String assetPath, String relativeOutputPath) {
        Context context = getContext();
        if (context == null) {
            return null;
        }
        try {
            AssetManager assetManager = context.getAssets();
            try (InputStream input = assetManager.open(assetPath)) {
                File outputFile = new File(context.getFilesDir(), relativeOutputPath);
                File parent = outputFile.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) {
                    throw new IOException("Could not create asset parent directory: " + parent.getAbsolutePath());
                }
                copyToFile(input, outputFile);
                return outputFile;
            }
        } catch (IOException error) {
            logDebug("Optional asset not staged: " + assetPath);
            return null;
        }
    }

    private void copyAssetDirectoryRecursive(AssetManager assetManager, String assetPath, File outputDir) throws IOException {
        String[] children = Objects.requireNonNull(assetManager.list(assetPath));
        for (String child : children) {
            String childAssetPath = assetPath + "/" + child;
            String[] grandChildren = assetManager.list(childAssetPath);
            if (grandChildren != null && grandChildren.length > 0) {
                File childDir = new File(outputDir, child);
                if (!childDir.exists() && !childDir.mkdirs()) {
                    throw new IOException("Could not create directory: " + childDir.getAbsolutePath());
                }
                copyAssetDirectoryRecursive(assetManager, childAssetPath, childDir);
                continue;
            }
            try (InputStream input = assetManager.open(childAssetPath)) {
                copyToFile(input, new File(outputDir, child));
            }
        }
    }

    private void copyToFile(InputStream input, File outputFile) throws IOException {
        try (FileOutputStream output = new FileOutputStream(outputFile, false)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                output.write(buffer, 0, read);
            }
        }
    }

    private void logDebug(String message) {
        if (!debugLoggingEnabled && !shouldAlwaysLogInfo(message)) {
            return;
        }
        NativePitchDebugLogger.log(
            getContext(),
            "[GH][platform=android][scene=native-plugin][subsystem=native-pitch][INFO] [" + TAG + "] " + message
        );
    }

    private void logDebug(String message, Throwable error) {
        NativePitchDebugLogger.log(
            getContext(),
            "[GH][platform=android][scene=native-plugin][subsystem=native-pitch][ERROR] [" + TAG + "] " + message,
            error
        );
    }

    private boolean shouldAlwaysLogInfo(String message) {
        String text = message == null ? "" : message;
        return text.startsWith("IPC startCapture begin")
            || text.startsWith("IPC stopCapture begin")
            || text.startsWith("IPC resetDetector begin")
            || text.startsWith("IPC getDiagnostics begin")
            || text.startsWith("Lifecycle ")
            || text.contains(" timed out")
            || text.contains(" failed")
            || text.contains("invalid JSON")
            || text.contains(" rejected")
            || text.startsWith("Plugin loaded");
    }

    private String truncate(String value) {
        if (value == null) {
            return "";
        }
        String trimmed = value.trim();
        if (trimmed.length() <= MAX_LOGGED_JSON_CHARS) {
            return trimmed;
        }
        return trimmed.substring(0, MAX_LOGGED_JSON_CHARS) + "...";
    }

    private String describePath(@Nullable File file) {
        if (file == null) {
            return "<null>";
        }
        return file.getAbsolutePath() + " (exists=" + file.exists() + ", bytes=" + (file.exists() ? file.length() : 0L) + ")";
    }

    private String firstNonEmpty(String value, String fallback) {
        return value != null && !value.trim().isEmpty() ? value.trim() : fallback;
    }

    private String readNativeStartCheckpoint() {
        try {
            return firstNonEmpty(nativeGetLastStartCheckpoint(), "unknown");
        } catch (Exception error) {
            logDebug("Failed to query native start checkpoint.", error);
            return "unavailable";
        }
    }

    private interface NativeCall {
        String run();
    }
}

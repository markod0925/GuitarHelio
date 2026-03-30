package com.guitarhelio.app.pitch;

import android.Manifest;
import android.content.Context;
import android.content.res.AssetManager;
import android.media.AudioManager;
import android.os.Build;
import android.util.Log;

import androidx.annotation.Nullable;

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

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

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
        boolean supportUnprocessedProperty,
        int audioManagerSampleRate,
        int audioManagerFramesPerBuffer
    );
    private static native String nativeStopCapture();
    private static native String nativePollResults(int maxResults);
    private static native String nativeUpdateGameplayContext(String contextJson);
    private static native String nativeResetDetector();
    private static native void nativeHandlePause();
    private static native void nativeHandleResume();

    @PluginMethod
    public void requestMicrophonePermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
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
            call.resolve(result);
        } else {
            call.reject("Microphone permission denied.", (Exception) null, result);
        }
    }

    @PluginMethod
    public void getDiagnostics(PluginCall call) {
        if (!ensureMicrophonePermission(call)) {
            return;
        }
        JSObject config = buildNativeConfig(call, false);
        executor.execute(() -> resolveNativeJson(call, nativeGetDiagnostics(
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
        )));
    }

    @PluginMethod
    public void startCapture(PluginCall call) {
        if (!ensureMicrophonePermission(call)) {
            return;
        }
        JSObject config = buildNativeConfig(call, true);
        String assetError = validateRuntimeAssets(config);
        if (assetError != null) {
            call.reject(assetError);
            return;
        }
        executor.execute(() -> resolveNativeJson(call, nativeStartCapture(
            config.optString("backend_name", "ac14"),
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
            config.optBoolean("support_unprocessed_property", false),
            config.optInt("audio_manager_sample_rate", 0),
            config.optInt("audio_manager_frames_per_buffer", 0)
        )));
    }

    @PluginMethod
    public void stopCapture(PluginCall call) {
        executor.execute(() -> resolveNativeJson(call, nativeStopCapture()));
    }

    @PluginMethod
    public void pollResults(PluginCall call) {
        int maxResults = Math.max(1, call.getInt("maxResults", 4));
        resolveNativeJson(call, nativePollResults(maxResults));
    }

    @PluginMethod
    public void updateGameplayContext(PluginCall call) {
        JSObject payload = call.getData();
        executor.execute(() -> resolveNativeJson(call, nativeUpdateGameplayContext(payload.toString())));
    }

    @PluginMethod
    public void resetDetector(PluginCall call) {
        executor.execute(() -> resolveNativeJson(call, nativeResetDetector()));
    }

    @Override
    protected void handleOnPause() {
        nativeHandlePause();
        super.handleOnPause();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        nativeHandleResume();
    }

    @Override
    protected void handleOnDestroy() {
        try {
            nativeStopCapture();
        } catch (Exception error) {
            Log.w(TAG, "Failed to stop native pitch runtime during destroy", error);
        }
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    private boolean ensureMicrophonePermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            return true;
        }
        call.reject("Microphone permission is required.");
        return false;
    }

    private JSObject buildNativeConfig(PluginCall call, boolean includeRuntimeAssets) {
        JSObject payload = call.getData();
        AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        int propertySampleRate = parseIntegerProperty(audioManager, AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE);
        int propertyFramesPerBuffer = parseIntegerProperty(audioManager, AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER);

        payload.put("requested_input_preset", firstNonEmpty(payload.getString("requested_input_preset"), "unprocessed"));
        payload.put("performance_mode", firstNonEmpty(payload.getString("performance_mode"), "low_latency"));
        payload.put("sharing_mode", firstNonEmpty(payload.getString("sharing_mode"), "exclusive"));
        payload.put("requested_sample_rate", Math.max(8_000, payload.optInt("requested_sample_rate", 48_000)));
        payload.put("channel_count", Math.max(1, payload.optInt("channel_count", 1)));
        payload.put("frames_per_callback", Math.max(0, payload.optInt("frames_per_callback", 0)));
        payload.put("capture_seconds", Math.max(0.0, payload.optDouble("capture_seconds", 2.0)));
        payload.put("support_unprocessed_property", supportsUnprocessedInput(audioManager));
        payload.put("audio_manager_sample_rate", propertySampleRate);
        payload.put("audio_manager_frames_per_buffer", propertyFramesPerBuffer);
        payload.put("native_library_dir", getContext().getApplicationInfo().nativeLibraryDir);
        payload.put("cache_dir", getContext().getCacheDir().getAbsolutePath());
        payload.put("files_dir", getContext().getFilesDir().getAbsolutePath());

        if (includeRuntimeAssets) {
            File maspDir = copyAssetDirectoryIfPresent(MASP_ASSET_DIR, "native-pitch/masp");
            if (maspDir != null) {
                payload.put("masp_assets_dir", maspDir.getAbsolutePath());
            }
            File fretnetModel = copyAssetFileIfPresent(FRETNET_ASSET_MODEL, "native-pitch/fretnet/model.onnx");
            if (fretnetModel != null) {
                payload.put("fretnet_model_path", fretnetModel.getAbsolutePath());
            }
        }

        return payload;
    }

    @Nullable
    private String validateRuntimeAssets(JSObject config) {
        String backendName = firstNonEmpty(config.getString("backend_name"), "ac14");
        if ("fretnet".equals(backendName) && config.optString("fretnet_model_path", "").trim().isEmpty()) {
            return "FRETNET model asset missing. Expected Android asset native-pitch/fretnet/model.onnx. "
                + "Stage the exported ONNX model before building the APK.";
        }
        if (("masp".equals(backendName) || "masp_game_scene_ts_v1".equals(backendName))
            && config.optString("masp_assets_dir", "").trim().isEmpty()) {
            return "MASP assets missing. Expected Android assets under native-pitch/masp.";
        }
        return null;
    }

    private void resolveNativeJson(PluginCall call, String rawJson) {
        try {
            JSONObject payload = new JSONObject(rawJson);
            boolean ok = payload.optBoolean("ok", true);
            if (!ok) {
                String error = firstNonEmpty(payload.optString("error", null), "Native pitch runtime failed.");
                call.reject(error, (Exception) null, toJsObject(payload));
                return;
            }
            call.resolve(toJsObject(payload));
        } catch (JSONException error) {
            call.reject("Native pitch runtime returned invalid JSON.", error);
        }
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
            Log.w(TAG, "Failed to parse AudioManager property " + property, error);
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
            Log.w(TAG, "Failed to query unprocessed-input support", error);
            return false;
        }
    }

    @Nullable
    private File copyAssetDirectoryIfPresent(String assetPath, String relativeOutputDir) {
        try {
            AssetManager assetManager = getContext().getAssets();
            String[] children = assetManager.list(assetPath);
            if (children == null || children.length == 0) {
                return null;
            }
            File outputDir = new File(getContext().getFilesDir(), relativeOutputDir);
            if (!outputDir.exists() && !outputDir.mkdirs()) {
                throw new IOException("Could not create asset output directory: " + outputDir.getAbsolutePath());
            }
            copyAssetDirectoryRecursive(assetManager, assetPath, outputDir);
            return outputDir;
        } catch (IOException error) {
            Log.w(TAG, "Failed to stage asset directory " + assetPath, error);
            return null;
        }
    }

    @Nullable
    private File copyAssetFileIfPresent(String assetPath, String relativeOutputPath) {
        try {
            AssetManager assetManager = getContext().getAssets();
            try (InputStream input = assetManager.open(assetPath)) {
                File outputFile = new File(getContext().getFilesDir(), relativeOutputPath);
                File parent = outputFile.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) {
                    throw new IOException("Could not create asset parent directory: " + parent.getAbsolutePath());
                }
                copyToFile(input, outputFile);
                return outputFile;
            }
        } catch (IOException error) {
            Log.i(TAG, "Optional asset not staged: " + assetPath);
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

    private String firstNonEmpty(String value, String fallback) {
        return value != null && !value.trim().isEmpty() ? value.trim() : fallback;
    }
}

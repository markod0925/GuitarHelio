package com.guitarhelio.app.converter;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.AssetManager;
import android.net.Uri;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import androidx.core.content.FileProvider;

@CapacitorPlugin(name = "NeuralNoteConverter")
public class NeuralNoteConverterPlugin extends Plugin {
    static {
        System.loadLibrary("neuralnote_converter_jni");
    }

    private static final String TAG = "GHImportDebug";
    private static final String IMPORT_DEBUG_DIR_NAME = "import-debug";
    private static final String IMPORT_DEBUG_FILE_NAME = "song-import-debug.log";
    private static final String IMPORT_DEBUG_PREVIOUS_FILE_NAME = "song-import-debug.prev.log";
    private static final boolean IMPORT_DEBUG_LOG_ENABLED = false;
    private static final long IMPORT_DEBUG_MAX_FILE_BYTES = 2L * 1024L * 1024L;
    private static final long IMPORT_DEBUG_HEARTBEAT_LOG_MS = 5L * 1000L;
    private static final String IMPORT_DEBUG_SHARE_TITLE = "Share import debug log";
    private static final String IMPORT_DEBUG_SHARE_SUBJECT = "GuitarHelio import debug log";
    private static final String IMPORT_DEBUG_SHARE_TEXT = "GuitarHelio Android import debug log";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ExecutorService nativeExecutor = Executors.newCachedThreadPool();
    private final Map<String, JobState> jobs = new ConcurrentHashMap<>();
    private final Object importDebugLogLock = new Object();
    private static final long NATIVE_STAGE_TIMEOUT_MIN_MS = 60L * 1000L;
    private static final long NATIVE_STAGE_TIMEOUT_MAX_MS = 20L * 60L * 1000L;
    private static final long DEFAULT_TEMPO_TIMEOUT_MS = 2L * 60L * 1000L;
    private static final long DEFAULT_NEURAL_TIMEOUT_MS = 8L * 60L * 1000L;
    private static final long NATIVE_PROGRESS_TICK_MS = 1000L;

    private static native String runTranscription(
        String pcmPath,
        String tempoPcmPath,
        String modelDirPath,
        String tempoModelOnnxPath,
        String outputJsonPath
    );

    private static native String runNeuralNoteEvents(
        String pcmPath,
        String modelDirPath,
        String outputJsonPath
    );

    private static native String runTempoEstimation(
        String tempoPcmPath,
        String tempoModelOnnxPath,
        String outputJsonPath
    );

    @PluginMethod
    public void startTranscription(PluginCall call) {
        String pcmPathRaw = call.getString("pcmPath", "");
        String tempoPcmPathRaw = call.getString("tempoPcmPath", "");
        String preset = call.getString("preset", "balanced");

        if (pcmPathRaw == null || pcmPathRaw.trim().isEmpty()) {
            call.reject("Missing pcmPath");
            return;
        }

        if (tempoPcmPathRaw == null || tempoPcmPathRaw.trim().isEmpty()) {
            call.reject("Missing tempoPcmPath");
            return;
        }

        if (!"balanced".equals(preset)) {
            call.reject("Only preset 'balanced' is supported.");
            return;
        }

        final long tempoStageTimeoutMs = clampStageTimeoutMs(
            call.getInt("tempoTimeoutMs", (int) DEFAULT_TEMPO_TIMEOUT_MS),
            DEFAULT_TEMPO_TIMEOUT_MS
        );
        final long neuralStageTimeoutMs = clampStageTimeoutMs(
            call.getInt("neuralTimeoutMs", (int) DEFAULT_NEURAL_TIMEOUT_MS),
            DEFAULT_NEURAL_TIMEOUT_MS
        );
        final String pcmPath = resolveFilePath(pcmPathRaw);
        final String tempoPcmPath = resolveFilePath(tempoPcmPathRaw);
        final String jobId = UUID.randomUUID().toString();
        File debugLogFile = IMPORT_DEBUG_LOG_ENABLED ? resolveImportDebugLogFile() : null;
        if (IMPORT_DEBUG_LOG_ENABLED && debugLogFile != null) {
            appendImportDebugLog(
                jobId,
                "startTranscription requested"
                    + " | pcmPath=" + describePath(pcmPath)
                    + " | tempoPcmPath=" + describePath(tempoPcmPath)
                    + " | tempoTimeoutMs=" + tempoStageTimeoutMs
                    + " | neuralTimeoutMs=" + neuralStageTimeoutMs
                    + " | logFile=" + debugLogFile.getAbsolutePath()
            );
        }

        JobState initial = new JobState();
        initial.id = jobId;
        initial.status = "queued";
        initial.stage = "Queued...";
        initial.progress = 0.0;
        jobs.put(jobId, initial);

        JSObject result = new JSObject();
        result.put("jobId", jobId);
        if (debugLogFile != null) {
            result.put("debugLogPath", debugLogFile.getAbsolutePath());
        }
        call.resolve(result);

        executor.execute(() -> runJob(jobId, pcmPath, tempoPcmPath, tempoStageTimeoutMs, neuralStageTimeoutMs));
    }

    @PluginMethod
    public void getTranscriptionStatus(PluginCall call) {
        String jobId = call.getString("jobId", "");
        if (jobId == null || jobId.trim().isEmpty()) {
            call.reject("Missing jobId");
            return;
        }

        JobState state = jobs.get(jobId);
        if (state == null) {
            call.reject("Import job not found.");
            return;
        }

        call.resolve(state.toJsObject());
    }

    @PluginMethod
    public void shareImportDebugLog(PluginCall call) {
        try {
            if (!IMPORT_DEBUG_LOG_ENABLED) {
                call.reject("Import debug log is disabled in this build.");
                return;
            }

            if (getActivity() == null) {
                call.reject("Android activity unavailable.");
                return;
            }

            File logFile = resolveShareableImportDebugLogFile();
            if (logFile == null || !logFile.exists() || logFile.length() <= 0) {
                call.reject("Import debug log not found.");
                return;
            }

            String authority = getContext().getPackageName() + ".fileprovider";
            Uri fileUri = FileProvider.getUriForFile(getContext(), authority, logFile);

            Intent shareIntent = new Intent(Intent.ACTION_SEND);
            shareIntent.setType("text/plain");
            shareIntent.putExtra(Intent.EXTRA_STREAM, fileUri);
            shareIntent.putExtra(Intent.EXTRA_SUBJECT, IMPORT_DEBUG_SHARE_SUBJECT);
            shareIntent.putExtra(Intent.EXTRA_TEXT, IMPORT_DEBUG_SHARE_TEXT);
            shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooserIntent = Intent.createChooser(shareIntent, IMPORT_DEBUG_SHARE_TITLE);
            chooserIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            appendImportDebugLog("share", "Share requested | logFile=" + describePath(logFile.getAbsolutePath()));
            getActivity().startActivity(chooserIntent);

            JSObject result = new JSObject();
            result.put("shared", true);
            result.put("logPath", logFile.getAbsolutePath());
            call.resolve(result);
        } catch (ActivityNotFoundException error) {
            appendImportDebugLog("share", "Share failed: no app can handle ACTION_SEND.\n" + stackTraceToString(error));
            call.reject("No Android app can share this file.", error);
        } catch (IllegalArgumentException error) {
            appendImportDebugLog("share", "Share failed: FileProvider rejected path.\n" + stackTraceToString(error));
            call.reject("Import debug log cannot be shared from this path.", error);
        } catch (Exception error) {
            appendImportDebugLog("share", "Share failed.\n" + stackTraceToString(error));
            call.reject("Failed to share import debug log.", error);
        }
    }

    private void runJob(String jobId, String pcmPath, String tempoPcmPath, long tempoStageTimeoutMs, long neuralStageTimeoutMs) {
        JobState state = jobs.get(jobId);
        if (state == null) {
            return;
        }

        try {
            state.status = "processing";
            state.stage = "Preparing NeuralNote models...";
            state.progress = 0.12;
            appendImportDebugLog(jobId, "Job started. Preparing model assets.");

            String modelDir = ensureNeuralNoteModelDirectory();
            String tempoModelPath = ensureTempoModelPath();
            File tempoJson = new File(getContext().getCacheDir(), "tempo-estimate-" + jobId + ".json");
            File notesJson = new File(getContext().getCacheDir(), "nn-events-" + jobId + ".json");
            appendImportDebugLog(
                jobId,
                "Model paths ready"
                    + " | modelDir=" + describePath(modelDir)
                    + " | tempoModelPath=" + describePath(tempoModelPath)
                    + " | tempoJson=" + describePath(tempoJson.getAbsolutePath())
                    + " | notesJson=" + describePath(notesJson.getAbsolutePath())
            );

            state.stage = "Estimating tempo (Tempo-CNN ONNX)...";
            state.progress = 0.34;
            long tempoStageStartedAt = System.currentTimeMillis();
            appendImportDebugLog(jobId, "Tempo stage started.");
            String tempoError = runNativeStageWithWatchdog(
                state,
                () -> runTempoEstimation(
                    tempoPcmPath,
                    tempoModelPath,
                    tempoJson.getAbsolutePath()
                ),
                tempoStageTimeoutMs,
                "Estimating tempo (Tempo-CNN ONNX)...",
                0.34,
                0.56,
                "Tempo-CNN estimation timed out. Try a shorter track."
            );
            appendImportDebugLog(
                jobId,
                "Tempo stage completed in " + (System.currentTimeMillis() - tempoStageStartedAt) + "ms"
            );
            if (tempoError != null && !tempoError.trim().isEmpty()) {
                throw new RuntimeException(tempoError.trim());
            }

            state.stage = "Running NeuralNote transcription...";
            state.progress = 0.58;
            long neuralStageStartedAt = System.currentTimeMillis();
            appendImportDebugLog(jobId, "NeuralNote stage started.");
            String neuralError = runNativeStageWithWatchdog(
                state,
                () -> runNeuralNoteEvents(
                    pcmPath,
                    modelDir,
                    notesJson.getAbsolutePath()
                ),
                neuralStageTimeoutMs,
                "Running NeuralNote transcription...",
                0.58,
                0.9,
                "NeuralNote transcription timed out. Try a shorter track."
            );
            appendImportDebugLog(
                jobId,
                "NeuralNote stage completed in " + (System.currentTimeMillis() - neuralStageStartedAt) + "ms"
            );
            if (neuralError != null && !neuralError.trim().isEmpty()) {
                throw new RuntimeException(neuralError.trim());
            }

            state.stage = "Building note events and tempo metadata...";
            state.progress = 0.92;

            JSONObject parsedNotes = new JSONObject(readFileUtf8(notesJson));
            JSONObject parsedTempo = new JSONObject(readFileUtf8(tempoJson));

            JSONArray events = parsedNotes.optJSONArray("events");
            if (events == null) {
                events = new JSONArray();
            }
            appendImportDebugLog(jobId, "Parsed note events count=" + events.length());

            JSArray jsEvents = new JSArray();
            for (int i = 0; i < events.length(); i++) {
                jsEvents.put(events.getJSONObject(i));
            }

            JSObject result = new JSObject();
            result.put("events", jsEvents);

            if (parsedTempo.has("tempoBpm")) {
                result.put("tempoBpm", parsedTempo.optDouble("tempoBpm", 120.0));
                appendImportDebugLog(jobId, "Parsed tempoBpm=" + parsedTempo.optDouble("tempoBpm", 120.0));
            }

            JSONArray tempoMap = parsedTempo.optJSONArray("tempoMap");
            if (tempoMap == null) {
                tempoMap = parsedTempo.optJSONArray("tempo_map");
            }
            if (tempoMap != null) {
                JSArray jsTempoMap = new JSArray();
                for (int i = 0; i < tempoMap.length(); i++) {
                    jsTempoMap.put(tempoMap.getJSONObject(i));
                }
                result.put("tempoMap", jsTempoMap);
            }

            state.status = "completed";
            state.stage = "Conversion complete.";
            state.progress = 1.0;
            state.result = result;
            state.error = null;
            appendImportDebugLog(jobId, "Job completed successfully.");

            //noinspection ResultOfMethodCallIgnored
            notesJson.delete();
            //noinspection ResultOfMethodCallIgnored
            tempoJson.delete();
        } catch (Exception error) {
            state.status = "failed";
            state.stage = "Import failed.";
            state.progress = 1.0;
            state.error = error.getMessage() != null ? error.getMessage() : "Audio import failed.";
            state.result = null;
            appendImportDebugLog(jobId, "Job failed: " + state.error + "\n" + stackTraceToString(error));
        }
    }

    private String runNativeStageWithWatchdog(
        JobState state,
        Callable<String> nativeCall,
        long timeoutMs,
        String stageLabel,
        double progressStart,
        double progressEnd,
        String timeoutMessage
    ) throws Exception {
        Future<String> future = nativeExecutor.submit(nativeCall);
        final long startedAtMs = System.currentTimeMillis();
        long lastHeartbeatLoggedAtMs = 0L;
        appendImportDebugLog(state.id, "Native stage watchdog started: " + stageLabel + " timeoutMs=" + timeoutMs);
        try {
            while (true) {
                long elapsedMs = System.currentTimeMillis() - startedAtMs;
                if (elapsedMs > timeoutMs) {
                    future.cancel(true);
                    appendImportDebugLog(state.id, "Native stage timeout reached: " + stageLabel + " elapsedMs=" + elapsedMs);
                    throw new RuntimeException(timeoutMessage);
                }

                try {
                    String result = future.get(NATIVE_PROGRESS_TICK_MS, TimeUnit.MILLISECONDS);
                    appendImportDebugLog(
                        state.id,
                        "Native stage completed: " + stageLabel + " elapsedMs=" + (System.currentTimeMillis() - startedAtMs)
                    );
                    return result;
                } catch (TimeoutException ignored) {
                    double ratio = Math.min(1.0, Math.max(0.0, (double) elapsedMs / (double) timeoutMs));
                    state.progress = progressStart + (progressEnd - progressStart) * ratio;
                    long elapsedSeconds = Math.max(1L, elapsedMs / 1000L);
                    long timeoutSeconds = Math.max(1L, timeoutMs / 1000L);
                    state.stage = stageLabel + " (" + elapsedSeconds + "s/" + timeoutSeconds + "s)";
                    if (elapsedMs - lastHeartbeatLoggedAtMs >= IMPORT_DEBUG_HEARTBEAT_LOG_MS) {
                        appendImportDebugLog(
                            state.id,
                            "Native stage heartbeat: " + stageLabel + " elapsedSeconds=" + elapsedSeconds + "/" + timeoutSeconds
                        );
                        lastHeartbeatLoggedAtMs = elapsedMs;
                    }
                } catch (ExecutionException execError) {
                    Throwable cause = execError.getCause();
                    appendImportDebugLog(
                        state.id,
                        "Native stage execution error: " + stageLabel + " cause=" + (cause != null ? cause.getMessage() : "<null>")
                    );
                    if (cause instanceof Exception) {
                        throw (Exception) cause;
                    }
                    throw new RuntimeException(cause != null ? cause.getMessage() : "Native conversion failed.");
                }
            }
        }
        catch (InterruptedException interrupted) {
            future.cancel(true);
            Thread.currentThread().interrupt();
            appendImportDebugLog(state.id, "Native stage interrupted: " + stageLabel);
            throw new RuntimeException("Native conversion interrupted.");
        }
    }

    private String resolveFilePath(String value) {
        String raw = value.trim();
        if (raw.startsWith("file://")) {
            String parsed = Uri.parse(raw).getPath();
            return parsed != null ? parsed : raw;
        }
        return raw;
    }

    private long clampStageTimeoutMs(int timeoutMs, long fallbackMs) {
        long safe = Math.max(0L, timeoutMs);
        if (safe <= 0L) {
            return Math.max(NATIVE_STAGE_TIMEOUT_MIN_MS, Math.min(NATIVE_STAGE_TIMEOUT_MAX_MS, fallbackMs));
        }
        return Math.max(NATIVE_STAGE_TIMEOUT_MIN_MS, Math.min(NATIVE_STAGE_TIMEOUT_MAX_MS, safe));
    }

    private String ensureNeuralNoteModelDirectory() throws IOException {
        File modelDir = new File(getContext().getFilesDir(), "neuralnote-model");
        if (!modelDir.exists() && !modelDir.mkdirs()) {
            throw new IOException("Could not create model directory");
        }

        copyAssetIfMissing("neuralnote-model/features_model.onnx", new File(modelDir, "features_model.onnx"));
        copyAssetIfMissing("neuralnote-model/cnn_contour_model.json", new File(modelDir, "cnn_contour_model.json"));
        copyAssetIfMissing("neuralnote-model/cnn_note_model.json", new File(modelDir, "cnn_note_model.json"));
        copyAssetIfMissing("neuralnote-model/cnn_onset_1_model.json", new File(modelDir, "cnn_onset_1_model.json"));
        copyAssetIfMissing("neuralnote-model/cnn_onset_2_model.json", new File(modelDir, "cnn_onset_2_model.json"));

        return modelDir.getAbsolutePath();
    }

    private String ensureTempoModelPath() throws IOException {
        File tempoDir = new File(getContext().getFilesDir(), "tempo-model");
        if (!tempoDir.exists() && !tempoDir.mkdirs()) {
            throw new IOException("Could not create tempo model directory");
        }

        File modelFile = new File(tempoDir, "fcn.onnx");
        copyAssetIfMissing("tempo-model/fcn.onnx", modelFile);
        return modelFile.getAbsolutePath();
    }

    private void copyAssetIfMissing(String assetPath, File target) throws IOException {
        if (target.exists() && target.length() > 0) {
            return;
        }

        AssetManager assetManager = getContext().getAssets();
        try (InputStream input = assetManager.open(assetPath);
             FileOutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) > 0) {
                output.write(buffer, 0, read);
            }
            output.flush();
        }
    }

    private String readFileUtf8(File file) throws IOException {
        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) > 0) {
                output.write(buffer, 0, read);
            }
            return output.toString("UTF-8");
        }
    }

    private File resolveImportDebugLogFile() {
        File baseDir = getContext().getExternalFilesDir(null);
        if (baseDir == null) {
            baseDir = getContext().getFilesDir();
        }

        File logDir = new File(baseDir, IMPORT_DEBUG_DIR_NAME);
        if (!logDir.exists() && !logDir.mkdirs()) {
            Log.w(TAG, "Could not create debug log directory: " + logDir.getAbsolutePath());
        }
        return new File(logDir, IMPORT_DEBUG_FILE_NAME);
    }

    private File resolveShareableImportDebugLogFile() {
        File externalBase = getContext().getExternalFilesDir(null);
        File internalBase = getContext().getFilesDir();

        File externalCurrent = externalBase != null
            ? new File(new File(externalBase, IMPORT_DEBUG_DIR_NAME), IMPORT_DEBUG_FILE_NAME)
            : null;
        File externalPrevious = externalBase != null
            ? new File(new File(externalBase, IMPORT_DEBUG_DIR_NAME), IMPORT_DEBUG_PREVIOUS_FILE_NAME)
            : null;
        File internalCurrent = new File(new File(internalBase, IMPORT_DEBUG_DIR_NAME), IMPORT_DEBUG_FILE_NAME);
        File internalPrevious = new File(new File(internalBase, IMPORT_DEBUG_DIR_NAME), IMPORT_DEBUG_PREVIOUS_FILE_NAME);

        File[] candidates = new File[] {
            externalCurrent,
            externalPrevious,
            internalCurrent,
            internalPrevious
        };

        File best = null;
        for (File candidate : candidates) {
            if (candidate == null || !candidate.exists() || candidate.length() <= 0) {
                continue;
            }
            if (best == null || candidate.lastModified() > best.lastModified()) {
                best = candidate;
            }
        }

        if (best != null) return best;
        if (externalCurrent != null) return externalCurrent;
        return internalCurrent;
    }

    private void appendImportDebugLog(String jobId, String message) {
        if (!IMPORT_DEBUG_LOG_ENABLED) return;

        String safeJobId = (jobId == null || jobId.trim().isEmpty()) ? "-" : jobId.trim();
        String safeMessage = message == null ? "" : message.trim();
        String timestamp = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(new Date());
        String line = timestamp + " [job=" + safeJobId + "] " + safeMessage;
        Log.d(TAG, line);

        synchronized (importDebugLogLock) {
            try {
                File logFile = resolveImportDebugLogFile();
                rotateImportDebugLogIfNeeded(logFile);
                try (FileOutputStream output = new FileOutputStream(logFile, true)) {
                    output.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                    output.flush();
                }
            } catch (Exception error) {
                Log.e(TAG, "Failed to append import debug file log", error);
            }
        }
    }

    private void rotateImportDebugLogIfNeeded(File logFile) {
        if (!logFile.exists() || logFile.length() < IMPORT_DEBUG_MAX_FILE_BYTES) {
            return;
        }

        File previous = new File(logFile.getParentFile(), IMPORT_DEBUG_PREVIOUS_FILE_NAME);
        if (previous.exists()) {
            //noinspection ResultOfMethodCallIgnored
            previous.delete();
        }
        //noinspection ResultOfMethodCallIgnored
        logFile.renameTo(previous);
    }

    private String describePath(String path) {
        if (path == null || path.trim().isEmpty()) {
            return "<empty>";
        }
        File file = new File(path.trim());
        return file.getAbsolutePath() + " (exists=" + file.exists() + ", bytes=" + (file.exists() ? file.length() : 0L) + ")";
    }

    private String stackTraceToString(Throwable error) {
        if (error == null) return "";
        StringWriter writer = new StringWriter();
        PrintWriter printer = new PrintWriter(writer);
        error.printStackTrace(printer);
        printer.flush();
        return writer.toString();
    }

    private static class JobState {
        String id;
        String status;
        String stage;
        double progress;
        String error;
        JSObject result;

        JSObject toJsObject() {
            JSObject out = new JSObject();
            out.put("id", id);
            out.put("status", status);
            out.put("stage", stage);
            out.put("progress", progress);
            if (error != null) {
                out.put("error", error);
            }
            if (result != null) {
                out.put("result", result);
            }
            return out;
        }
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        executor.shutdownNow();
        nativeExecutor.shutdownNow();
    }
}

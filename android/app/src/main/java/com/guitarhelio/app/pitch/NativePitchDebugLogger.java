package com.guitarhelio.app.pitch;

import android.content.Context;
import android.util.Log;

import androidx.annotation.Nullable;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

final class NativePitchDebugLogger {
    private static final String TAG = "NativePitchDebug";
    private static final String LOG_DIR_NAME = "native-pitch-debug";
    private static final String LOG_FILE_NAME = "native-pitch-debug.log";
    private static final String LOG_PREVIOUS_FILE_NAME = "native-pitch-debug.prev.log";
    private static final long MAX_LOG_FILE_BYTES = 2L * 1024L * 1024L;
    private static final Object FILE_LOCK = new Object();
    private static volatile boolean verboseLoggingEnabled = false;
    private static volatile boolean fileLoggingEnabled = false;

    private NativePitchDebugLogger() {
    }

    static boolean isEnabled() {
        return verboseLoggingEnabled || fileLoggingEnabled;
    }

    static boolean isVerboseLoggingEnabled() {
        return verboseLoggingEnabled;
    }

    static boolean isFileLoggingEnabled() {
        return fileLoggingEnabled;
    }

    static void configure(boolean verboseEnabled, boolean fileEnabled) {
        verboseLoggingEnabled = verboseEnabled;
        fileLoggingEnabled = fileEnabled;
    }

    @Nullable
    static File resolveCurrentLogFile(@Nullable Context context) {
        if (context == null) {
            return null;
        }

        File baseDir = context.getExternalFilesDir(null);
        if (baseDir == null) {
            baseDir = context.getFilesDir();
        }
        if (baseDir == null) {
            return null;
        }

        File logDir = new File(baseDir, LOG_DIR_NAME);
        if (!logDir.exists() && !logDir.mkdirs()) {
            Log.w(TAG, "Could not create debug log directory: " + logDir.getAbsolutePath());
        }
        return new File(logDir, LOG_FILE_NAME);
    }

    @Nullable
    static File resolveShareableLogFile(@Nullable Context context) {
        if (context == null) {
            return null;
        }

        File externalBase = context.getExternalFilesDir(null);
        File internalBase = context.getFilesDir();

        File externalCurrent = externalBase != null
            ? new File(new File(externalBase, LOG_DIR_NAME), LOG_FILE_NAME)
            : null;
        File externalPrevious = externalBase != null
            ? new File(new File(externalBase, LOG_DIR_NAME), LOG_PREVIOUS_FILE_NAME)
            : null;
        File internalCurrent = new File(new File(internalBase, LOG_DIR_NAME), LOG_FILE_NAME);
        File internalPrevious = new File(new File(internalBase, LOG_DIR_NAME), LOG_PREVIOUS_FILE_NAME);

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

        if (best != null) {
            return best;
        }
        if (externalCurrent != null) {
            return externalCurrent;
        }
        return internalCurrent;
    }

    static void log(@Nullable Context context, String message) {
        log(context, message, null);
    }

    static void log(@Nullable Context context, String message, @Nullable Throwable error) {
        String safeMessage = message == null ? "" : message.trim();
        String timestamp = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(new Date());
        String line = timestamp + " " + safeMessage;
        if (error == null) {
            Log.d(TAG, line);
        } else {
            Log.e(TAG, line, error);
        }

        if (!fileLoggingEnabled || context == null) {
            return;
        }

        synchronized (FILE_LOCK) {
            try {
                File logFile = resolveCurrentLogFile(context);
                if (logFile == null) {
                    return;
                }
                rotateIfNeeded(logFile);
                try (FileOutputStream output = new FileOutputStream(logFile, true)) {
                    output.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                    if (error != null) {
                        output.write(stackTraceToString(error).getBytes(StandardCharsets.UTF_8));
                        output.write("\n".getBytes(StandardCharsets.UTF_8));
                    }
                    output.flush();
                }
            } catch (Exception appendError) {
                Log.e(TAG, "Failed to append native pitch debug log.", appendError);
            }
        }
    }

    private static void rotateIfNeeded(File logFile) {
        if (!logFile.exists() || logFile.length() < MAX_LOG_FILE_BYTES) {
            return;
        }

        File previous = new File(logFile.getParentFile(), LOG_PREVIOUS_FILE_NAME);
        if (previous.exists()) {
            //noinspection ResultOfMethodCallIgnored
            previous.delete();
        }
        //noinspection ResultOfMethodCallIgnored
        logFile.renameTo(previous);
    }

    private static String stackTraceToString(Throwable error) {
        StringWriter writer = new StringWriter();
        PrintWriter printer = new PrintWriter(writer);
        error.printStackTrace(printer);
        printer.flush();
        return writer.toString();
    }
}

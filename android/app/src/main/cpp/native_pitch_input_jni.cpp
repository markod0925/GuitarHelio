#include <jni.h>

#include <android/log.h>
#include <dlfcn.h>
#include <oboe/Oboe.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <limits>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

constexpr const char* kTag = "NativePitchInput";
constexpr int32_t kDefaultRequestedSampleRate = 48000;
constexpr int32_t kDefaultChannelCount = 1;
constexpr int32_t kDefaultBlockSize = 2048;
constexpr int32_t kDefaultRingBufferSeconds = 4;
constexpr int32_t kStartCallbackTimeoutMs = 800;

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, kTag, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, kTag, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, kTag, __VA_ARGS__)

std::mutex gStartCheckpointMutex;
std::string gLastStartCheckpoint = "idle";
std::string queryRustInitStageSnapshot();

void setLastStartCheckpoint(std::string value)
{
    std::string snapshot;
    {
        std::lock_guard<std::mutex> lock(gStartCheckpointMutex);
        gLastStartCheckpoint = std::move(value);
        snapshot = gLastStartCheckpoint;
    }
    LOGI("startCapture checkpoint: %s", snapshot.c_str());
}

std::string getLastStartCheckpoint()
{
    std::string checkpoint;
    {
        std::lock_guard<std::mutex> lock(gStartCheckpointMutex);
        checkpoint = gLastStartCheckpoint;
    }
    return checkpoint + " | " + queryRustInitStageSnapshot();
}

void writeThreadSafeString(std::mutex& mutex, std::string& target, std::string value)
{
    std::lock_guard<std::mutex> lock(mutex);
    target = std::move(value);
}

std::string readThreadSafeString(std::mutex& mutex, const std::string& target)
{
    std::lock_guard<std::mutex> lock(mutex);
    return target;
}

struct NativePitchRuntimeHandle;

using NativePitchRuntimeNewFn = NativePitchRuntimeHandle* (*)(const char*, char**);
using NativePitchRuntimeDestroyFn = void (*)(NativePitchRuntimeHandle*);
using NativePitchRuntimeResetFn = void (*)(NativePitchRuntimeHandle*);
using NativePitchRuntimeUpdateGameplayContextFn = char* (*)(NativePitchRuntimeHandle*, const char*);
using NativePitchRuntimeProcessAudioBlockFn =
    char* (*)(NativePitchRuntimeHandle*, const float*, size_t, double, char**);
using NativePitchRuntimeFreeStringFn = void (*)(char*);
using NativePitchRuntimeGetLastInitStageFn = char* (*)();

std::string queryRustInitStageSnapshot()
{
    void* libraryHandle = dlopen("libnative_pitch_runtime.so", RTLD_NOW | RTLD_LOCAL);
    if (libraryHandle == nullptr) {
        return "rust_init_stage=dlopen_failed";
    }

    auto getter = reinterpret_cast<NativePitchRuntimeGetLastInitStageFn>(
        dlsym(libraryHandle, "gh_native_pitch_runtime_get_last_init_stage"));
    auto freeString = reinterpret_cast<NativePitchRuntimeFreeStringFn>(
        dlsym(libraryHandle, "gh_native_pitch_runtime_free_string"));
    if (getter == nullptr) {
        return "rust_init_stage=getter_missing";
    }

    char* stage = getter();
    if (stage == nullptr) {
        return "rust_init_stage=null";
    }

    std::string out(stage);
    if (freeString != nullptr) {
        freeString(stage);
    }
    if (out.empty()) {
        return "rust_init_stage=empty";
    }
    return "rust_init_stage=" + out;
}

class RustRuntimeBindings {
public:
    bool ensureLoaded()
    {
        if (attempted_) {
            return loaded_;
        }
        attempted_ = true;

        libraryHandle_ = dlopen("libnative_pitch_runtime.so", RTLD_NOW | RTLD_LOCAL);
        if (libraryHandle_ == nullptr) {
            loadError_ = dlerror();
            if (loadError_.empty()) {
                loadError_ = "dlopen(libnative_pitch_runtime.so) failed";
            }
            return false;
        }

        newRuntime_ = reinterpret_cast<NativePitchRuntimeNewFn>(
            dlsym(libraryHandle_, "gh_native_pitch_runtime_new"));
        destroyRuntime_ = reinterpret_cast<NativePitchRuntimeDestroyFn>(
            dlsym(libraryHandle_, "gh_native_pitch_runtime_destroy"));
        resetRuntime_ = reinterpret_cast<NativePitchRuntimeResetFn>(
            dlsym(libraryHandle_, "gh_native_pitch_runtime_reset"));
        updateGameplayContext_ = reinterpret_cast<NativePitchRuntimeUpdateGameplayContextFn>(
            dlsym(libraryHandle_, "gh_native_pitch_runtime_update_gameplay_context"));
        processAudioBlock_ = reinterpret_cast<NativePitchRuntimeProcessAudioBlockFn>(
            dlsym(libraryHandle_, "gh_native_pitch_runtime_process_audio_block"));
        freeString_ = reinterpret_cast<NativePitchRuntimeFreeStringFn>(
            dlsym(libraryHandle_, "gh_native_pitch_runtime_free_string"));

        if (newRuntime_ == nullptr || destroyRuntime_ == nullptr || resetRuntime_ == nullptr
            || updateGameplayContext_ == nullptr || processAudioBlock_ == nullptr
            || freeString_ == nullptr) {
            loadError_ = "libnative_pitch_runtime.so is missing one or more exported symbols";
            dlclose(libraryHandle_);
            libraryHandle_ = nullptr;
            return false;
        }

        loaded_ = true;
        return true;
    }

    const std::string& loadError() const { return loadError_; }

    NativePitchRuntimeHandle* newRuntime(const char* configJson, char** errorOut) const
    {
        return newRuntime_(configJson, errorOut);
    }

    void destroyRuntime(NativePitchRuntimeHandle* handle) const
    {
        destroyRuntime_(handle);
    }

    void resetRuntime(NativePitchRuntimeHandle* handle) const
    {
        resetRuntime_(handle);
    }

    char* updateGameplayContext(NativePitchRuntimeHandle* handle, const char* contextJson) const
    {
        return updateGameplayContext_(handle, contextJson);
    }

    char* processAudioBlock(
        NativePitchRuntimeHandle* handle,
        const float* samples,
        size_t sampleCount,
        double captureTimeSec,
        char** resultJsonOut) const
    {
        return processAudioBlock_(handle, samples, sampleCount, captureTimeSec, resultJsonOut);
    }

    void freeString(char* value) const
    {
        freeString_(value);
    }

private:
    bool attempted_{false};
    bool loaded_{false};
    void* libraryHandle_{nullptr};
    std::string loadError_;
    NativePitchRuntimeNewFn newRuntime_{nullptr};
    NativePitchRuntimeDestroyFn destroyRuntime_{nullptr};
    NativePitchRuntimeResetFn resetRuntime_{nullptr};
    NativePitchRuntimeUpdateGameplayContextFn updateGameplayContext_{nullptr};
    NativePitchRuntimeProcessAudioBlockFn processAudioBlock_{nullptr};
    NativePitchRuntimeFreeStringFn freeString_{nullptr};
};

struct StartConfig {
    std::string backendName = "ac14";
    int32_t requestedSampleRate = kDefaultRequestedSampleRate;
    int32_t blockSize = kDefaultBlockSize;
    int32_t channelCount = kDefaultChannelCount;
    int32_t framesPerCallback = 0;
    std::string requestedInputPreset = "unprocessed";
    std::string performanceMode = "low_latency";
    std::string sharingMode = "exclusive";
    std::string audioInputMode = "speaker";
    std::string spectralModelJson;
    std::string maspAssetsDir;
    std::string fretnetModelPath;
    std::string nativeLibraryDir;
    std::string fretnetOrtLibraryPath;
    bool supportUnprocessedProperty = false;
    int32_t audioManagerSampleRate = 0;
    int32_t audioManagerFramesPerBuffer = 0;
    bool debugLoggingEnabled = false;
    bool verboseNativePitchDiagnostics = false;
    bool traceFretnetRuntime = false;
};

struct DiagnosticsConfig {
    int32_t requestedSampleRate = kDefaultRequestedSampleRate;
    int32_t channelCount = kDefaultChannelCount;
    int32_t framesPerCallback = 0;
    std::string requestedInputPreset = "unprocessed";
    std::string performanceMode = "low_latency";
    std::string sharingMode = "exclusive";
    double captureSeconds = 2.0;
    bool supportUnprocessedProperty = false;
    int32_t audioManagerSampleRate = 0;
    int32_t audioManagerFramesPerBuffer = 0;
};

struct DiagnosticsSnapshot {
    std::string backendName = "unknown";
    std::string requestedInputPreset = "unprocessed";
    std::string actualInputPreset = "unknown";
    std::string audioApi = "unknown";
    std::string sharingMode = "unknown";
    std::string performanceMode = "unknown";
    int32_t sampleRate = 0;
    int32_t hardwareSampleRate = 0;
    int32_t channelCount = 0;
    int32_t hardwareChannelCount = 0;
    std::string format = "unknown";
    int32_t framesPerBurst = 0;
    int32_t framesPerCallback = 0;
    int32_t deviceId = 0;
    bool supportUnprocessedProperty = false;
    std::string streamState = "closed";
    int32_t xRunCount = 0;
    std::string fallbackReason;
    double rms = 0.0;
    double peak = 0.0;
    double noiseFloor = 0.0;
    double averageAbs = 0.0;
    uint64_t callbackCount = 0;
    uint64_t droppedBlocks = 0;
    uint64_t totalCallbackSamples = 0;
    uint64_t totalStagedSamples = 0;
    uint64_t stagedSampleCount = 0;
    uint64_t allZeroCallbackCount = 0;
    uint64_t silentCallbackCount = 0;
    uint64_t signalCallbackCount = 0;
    int32_t runtimeSampleRate = 0;
    int32_t targetBlockSize = 0;
    uint64_t processConditionCheckCount = 0;
    uint64_t processConditionPassCount = 0;
    uint64_t processSkipInsufficientSamplesCount = 0;
    uint64_t processSkipRuntimeNotReadyCount = 0;
    uint64_t processedBlockCount = 0;
    uint64_t submittedSampleCount = 0;
    uint64_t runtimeProcessCallCount = 0;
    uint64_t runtimeProcessNullResultCount = 0;
    uint64_t runtimeProcessErrorCount = 0;
    uint64_t emittedResultCount = 0;
    uint64_t detectorQueueDepth = 0;
    uint64_t discardedSampleCount = 0;
    uint64_t stopRequestCount = 0;
    uint64_t stopNoopCount = 0;
    uint64_t resetRequestCount = 0;
    uint64_t resetWhileRunningCount = 0;
    uint64_t pendingSamplesOnLastStop = 0;
    uint64_t pendingSamplesOnLastReset = 0;
    bool detectorReady = false;
    std::string lastProcessingState;
    std::string lastDiscardReason;
    std::string lastError;
};

struct QueuedDetectionResult {
    std::string detectorJson;
    double callbackToResultLatencyMs = 0.0;
    double processingTimeMs = 0.0;
    uint64_t detectorQueueDepth = 0;
    uint64_t droppedBlocks = 0;
    bool overrun = false;
};

static std::string jsonEscape(const std::string& value)
{
    std::ostringstream out;
    for (char ch : value) {
        switch (ch) {
        case '\\':
            out << "\\\\";
            break;
        case '"':
            out << "\\\"";
            break;
        case '\n':
            out << "\\n";
            break;
        case '\r':
            out << "\\r";
            break;
        case '\t':
            out << "\\t";
            break;
        default:
            out << ch;
            break;
        }
    }
    return out.str();
}

static std::string quote(const std::string& value)
{
    return "\"" + jsonEscape(value) + "\"";
}

static const char* boolString(bool value)
{
    return value ? "true" : "false";
}

static std::string mergeDetectorJson(const QueuedDetectionResult& item)
{
    std::string base = item.detectorJson;
    if (base.empty() || base.front() != '{' || base.back() != '}') {
        return "{}";
    }
    base.pop_back();
    std::ostringstream out;
    out << base
        << ",\"callback_to_result_latency_ms\":" << item.callbackToResultLatencyMs
        << ",\"processing_time_ms\":" << item.processingTimeMs
        << ",\"detector_queue_depth\":" << item.detectorQueueDepth
        << ",\"dropped_blocks\":" << item.droppedBlocks
        << ",\"overrun\":" << boolString(item.overrun)
        << "}";
    return out.str();
}

static std::string diagnosticsToJson(const DiagnosticsSnapshot& diagnostics)
{
    std::ostringstream out;
    out << "{"
        << "\"backend_name\":" << quote(diagnostics.backendName)
        << ","
        << "\"requested_input_preset\":" << quote(diagnostics.requestedInputPreset)
        << ",\"actual_input_preset\":" << quote(diagnostics.actualInputPreset)
        << ",\"audio_api\":" << quote(diagnostics.audioApi)
        << ",\"sharing_mode\":" << quote(diagnostics.sharingMode)
        << ",\"performance_mode\":" << quote(diagnostics.performanceMode)
        << ",\"sample_rate\":" << diagnostics.sampleRate
        << ",\"hardware_sample_rate\":" << diagnostics.hardwareSampleRate
        << ",\"channel_count\":" << diagnostics.channelCount
        << ",\"hardware_channel_count\":" << diagnostics.hardwareChannelCount
        << ",\"format\":" << quote(diagnostics.format)
        << ",\"frames_per_burst\":" << diagnostics.framesPerBurst
        << ",\"frames_per_callback\":" << diagnostics.framesPerCallback
        << ",\"device_id\":" << diagnostics.deviceId
        << ",\"support_unprocessed_property\":" << boolString(diagnostics.supportUnprocessedProperty)
        << ",\"stream_state\":" << quote(diagnostics.streamState)
        << ",\"xrun_count\":" << diagnostics.xRunCount
        << ",\"fallback_reason\":"
        << (diagnostics.fallbackReason.empty() ? "null" : quote(diagnostics.fallbackReason))
        << ",\"rms\":" << diagnostics.rms
        << ",\"peak\":" << diagnostics.peak
        << ",\"noise_floor\":" << diagnostics.noiseFloor
        << ",\"average_abs\":" << diagnostics.averageAbs
        << ",\"callback_count\":" << diagnostics.callbackCount
        << ",\"dropped_blocks\":" << diagnostics.droppedBlocks
        << ",\"total_callback_samples\":" << diagnostics.totalCallbackSamples
        << ",\"total_staged_samples\":" << diagnostics.totalStagedSamples
        << ",\"staged_sample_count\":" << diagnostics.stagedSampleCount
        << ",\"all_zero_callback_count\":" << diagnostics.allZeroCallbackCount
        << ",\"silent_callback_count\":" << diagnostics.silentCallbackCount
        << ",\"signal_callback_count\":" << diagnostics.signalCallbackCount
        << ",\"runtime_sample_rate\":" << diagnostics.runtimeSampleRate
        << ",\"target_block_size\":" << diagnostics.targetBlockSize
        << ",\"process_condition_check_count\":" << diagnostics.processConditionCheckCount
        << ",\"process_condition_pass_count\":" << diagnostics.processConditionPassCount
        << ",\"process_skip_insufficient_samples_count\":"
        << diagnostics.processSkipInsufficientSamplesCount
        << ",\"process_skip_runtime_not_ready_count\":"
        << diagnostics.processSkipRuntimeNotReadyCount
        << ",\"processed_block_count\":" << diagnostics.processedBlockCount
        << ",\"submitted_sample_count\":" << diagnostics.submittedSampleCount
        << ",\"runtime_process_call_count\":" << diagnostics.runtimeProcessCallCount
        << ",\"runtime_process_null_result_count\":" << diagnostics.runtimeProcessNullResultCount
        << ",\"runtime_process_error_count\":" << diagnostics.runtimeProcessErrorCount
        << ",\"emitted_result_count\":" << diagnostics.emittedResultCount
        << ",\"detector_queue_depth\":" << diagnostics.detectorQueueDepth
        << ",\"discarded_sample_count\":" << diagnostics.discardedSampleCount
        << ",\"stop_request_count\":" << diagnostics.stopRequestCount
        << ",\"stop_noop_count\":" << diagnostics.stopNoopCount
        << ",\"reset_request_count\":" << diagnostics.resetRequestCount
        << ",\"reset_while_running_count\":" << diagnostics.resetWhileRunningCount
        << ",\"pending_samples_on_last_stop\":" << diagnostics.pendingSamplesOnLastStop
        << ",\"pending_samples_on_last_reset\":" << diagnostics.pendingSamplesOnLastReset
        << ",\"detector_ready\":" << boolString(diagnostics.detectorReady)
        << ",\"last_processing_state\":"
        << (diagnostics.lastProcessingState.empty() ? "null" : quote(diagnostics.lastProcessingState))
        << ",\"last_discard_reason\":"
        << (diagnostics.lastDiscardReason.empty() ? "null" : quote(diagnostics.lastDiscardReason))
        << ",\"last_error\":"
        << (diagnostics.lastError.empty() ? "null" : quote(diagnostics.lastError))
        << "}";
    return out.str();
}

static std::string okEnvelope(const std::string& payload)
{
    return std::string("{\"ok\":true,") + payload + "}";
}

static std::string errorEnvelope(const std::string& message, const DiagnosticsSnapshot* diagnostics = nullptr)
{
    std::ostringstream out;
    out << "{\"ok\":false,\"error\":" << quote(message);
    if (diagnostics != nullptr) {
        out << ",\"diagnostics\":" << diagnosticsToJson(*diagnostics);
    }
    out << "}";
    return out.str();
}

class FloatRingBuffer {
public:
    explicit FloatRingBuffer(size_t capacity)
        : capacity_(std::max<size_t>(capacity, 1024)),
          data_(capacity_)
    {
    }

    void reset()
    {
        readIndex_.store(0);
        writeIndex_.store(0);
    }

    size_t availableToRead() const
    {
        const uint64_t write = writeIndex_.load(std::memory_order_acquire);
        const uint64_t read = readIndex_.load(std::memory_order_acquire);
        return static_cast<size_t>(write - read);
    }

    size_t availableToWrite() const
    {
        return capacity_ - availableToRead();
    }

    bool push(const float* samples, size_t sampleCount)
    {
        if (sampleCount == 0) {
            return true;
        }
        if (sampleCount > availableToWrite()) {
            return false;
        }

        uint64_t write = writeIndex_.load(std::memory_order_relaxed);
        for (size_t index = 0; index < sampleCount; ++index) {
            data_[(write + index) % capacity_] = samples[index];
        }
        writeIndex_.store(write + sampleCount, std::memory_order_release);
        return true;
    }

    size_t pop(float* out, size_t sampleCount)
    {
        const size_t available = availableToRead();
        const size_t toRead = std::min(available, sampleCount);
        if (toRead == 0) {
            return 0;
        }
        uint64_t read = readIndex_.load(std::memory_order_relaxed);
        for (size_t index = 0; index < toRead; ++index) {
            out[index] = data_[(read + index) % capacity_];
        }
        readIndex_.store(read + toRead, std::memory_order_release);
        return toRead;
    }

private:
    size_t capacity_;
    std::vector<float> data_;
    std::atomic<uint64_t> readIndex_{0};
    std::atomic<uint64_t> writeIndex_{0};
};

static oboe::InputPreset parseInputPreset(const std::string& value)
{
    if (value == "voice_recognition") {
        return oboe::InputPreset::VoiceRecognition;
    }
    if (value == "voice_performance") {
        return oboe::InputPreset::VoicePerformance;
    }
    if (value == "camcorder") {
        return oboe::InputPreset::Camcorder;
    }
    if (value == "generic") {
        return oboe::InputPreset::Generic;
    }
    return oboe::InputPreset::Unprocessed;
}

static oboe::SharingMode parseSharingMode(const std::string& value)
{
    if (value == "shared") {
        return oboe::SharingMode::Shared;
    }
    return oboe::SharingMode::Exclusive;
}

static oboe::PerformanceMode parsePerformanceMode(const std::string& value)
{
    if (value == "none") {
        return oboe::PerformanceMode::None;
    }
    if (value == "power_saving") {
        return oboe::PerformanceMode::PowerSaving;
    }
    return oboe::PerformanceMode::LowLatency;
}

class NativePitchInputEngine final : public oboe::AudioStreamDataCallback, public oboe::AudioStreamErrorCallback {
public:
    NativePitchInputEngine() = default;

    ~NativePitchInputEngine() override
    {
        stopCapture();
    }

    std::string getDiagnostics(const DiagnosticsConfig& config)
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        stopCaptureLocked("diagnostics_probe");

        DiagnosticsSnapshot diagnostics;
        diagnostics.requestedInputPreset = config.requestedInputPreset;
        diagnostics.supportUnprocessedProperty = config.supportUnprocessedProperty;
        resetCaptureCountersLocked();

        const std::string openError = openStreamLocked(
            config.requestedSampleRate,
            config.channelCount,
            config.framesPerCallback,
            config.requestedInputPreset,
            config.performanceMode,
            config.sharingMode,
            diagnostics);
        if (!openError.empty()) {
            diagnostics.fallbackReason = openError;
            return errorEnvelope(openError, &diagnostics);
        }

        if (config.captureSeconds > 0.0) {
            stream_->requestStart();
            const auto sleepDuration = std::chrono::milliseconds(
                static_cast<int64_t>(config.captureSeconds * 1000.0));
            std::this_thread::sleep_for(sleepDuration);
            stream_->requestStop();
            std::this_thread::sleep_for(std::chrono::milliseconds(40));
        }

        updateSanityMetricsLocked(diagnostics);
        logDiagnostics(diagnostics);
        closeStreamLocked();
        return okEnvelope(
            "\"running\":false,\"diagnostics\":" + diagnosticsToJson(diagnostics));
    }

    std::string startCapture(const StartConfig& config)
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        const auto startCaptureStartedAt = std::chrono::steady_clock::now();
        setLastStartCheckpoint("enter backend=" + config.backendName);
        LOGI(
            "startCapture: enter backend=%s sr=%d block=%d ch=%d callback=%d preset=%s perf=%s sharing=%s audioMode=%s",
            config.backendName.c_str(),
            config.requestedSampleRate,
            config.blockSize,
            config.channelCount,
            config.framesPerCallback,
            config.requestedInputPreset.c_str(),
            config.performanceMode.c_str(),
            config.sharingMode.c_str(),
            config.audioInputMode.c_str());
        setLastStartCheckpoint("before stopCaptureLocked");
        stopCaptureLocked("restart_before_start");
        setLastStartCheckpoint("after stopCaptureLocked");
        lastConfig_ = config;
        debugLoggingEnabled_.store(config.debugLoggingEnabled, std::memory_order_relaxed);
        verboseNativePitchDiagnostics_.store(config.verboseNativePitchDiagnostics, std::memory_order_relaxed);
        traceFretnetRuntime_.store(config.traceFretnetRuntime, std::memory_order_relaxed);
        DiagnosticsSnapshot diagnostics;
        diagnostics.backendName = config.backendName;
        diagnostics.requestedInputPreset = config.requestedInputPreset;
        diagnostics.supportUnprocessedProperty = config.supportUnprocessedProperty;

        resetCaptureCountersLocked();

        setLastStartCheckpoint("before ensureLoaded");
        LOGI("startCapture: ensuring Rust runtime bindings are loaded.");
        if (!rustBindings_.ensureLoaded()) {
            diagnostics.fallbackReason = rustBindings_.loadError();
            setLastStartCheckpoint("error ensureLoaded: " + diagnostics.fallbackReason);
            LOGE("startCapture: Rust runtime bindings load failed: %s", diagnostics.fallbackReason.c_str());
            return errorEnvelope(diagnostics.fallbackReason, &diagnostics);
        }
        setLastStartCheckpoint("after ensureLoaded");
        LOGI("startCapture: Rust runtime bindings loaded.");

        setLastStartCheckpoint("before openStreamLocked");
        LOGI("startCapture: opening Oboe input stream.");
        const std::string openError = openStreamLocked(
            config.requestedSampleRate,
            config.channelCount,
            config.framesPerCallback,
            config.requestedInputPreset,
            config.performanceMode,
            config.sharingMode,
            diagnostics);
        if (!openError.empty()) {
            diagnostics.fallbackReason = openError;
            setLastStartCheckpoint("error openStreamLocked: " + diagnostics.fallbackReason);
            LOGE("startCapture: openStream failed: %s", diagnostics.fallbackReason.c_str());
            return errorEnvelope(openError, &diagnostics);
        }
        setLastStartCheckpoint("after openStreamLocked");
        LOGI(
            "startCapture: stream opened sr=%d callback=%d api=%s state=%s",
            diagnostics.sampleRate,
            diagnostics.framesPerCallback,
            diagnostics.audioApi.c_str(),
            diagnostics.streamState.c_str());

        blockSize_ = std::max(256, config.blockSize);
        ringBuffer_ = std::make_unique<FloatRingBuffer>(
            static_cast<size_t>(std::max(8'000, diagnostics.sampleRate)) * kDefaultRingBufferSeconds);
        workerScratch_.assign(static_cast<size_t>(blockSize_), 0.0f);
        detectorQueue_.clear();
        lastProcessedSamples_ = 0;
        diagnostics.targetBlockSize = blockSize_;
        LOGI(
            "startCapture: staging prepared blockSize=%d ringBufferSeconds=%d backend=%s.",
            blockSize_,
            kDefaultRingBufferSeconds,
            config.backendName.c_str());

        setLastStartCheckpoint("before requestStart");
        LOGI("startCapture: requesting stream start.");
        const oboe::Result startResult = stream_->requestStart();
        if (startResult != oboe::Result::OK) {
            const std::string error = std::string("Failed to start Oboe input stream: ")
                + oboe::convertToText(startResult);
            stopCaptureLocked("start_request_failed");
            diagnostics.fallbackReason = error;
            setLastStartCheckpoint("error requestStart: " + diagnostics.fallbackReason);
            LOGE("startCapture: requestStart failed: %s", diagnostics.fallbackReason.c_str());
            return errorEnvelope(error, &diagnostics);
        }
        setLastStartCheckpoint("after requestStart");
        if (!waitForFirstCallbackLocked(kStartCallbackTimeoutMs)) {
            updateSanityMetricsLocked(diagnostics);
            const std::string error =
                "Oboe input stream started but no audio callbacks arrived within "
                + std::to_string(kStartCallbackTimeoutMs) + " ms.";
            diagnostics.fallbackReason = error;
            diagnostics.lastError = error;
            writeThreadSafeString(errorMutex_, lastError_, error);
            setLastStartCheckpoint("error noAudioCallbacks");
            LOGE("startCapture: no audio callbacks after stream start.");
            stopCaptureLocked("start_no_callbacks");
            return errorEnvelope(error, &diagnostics);
        }
        setLastStartCheckpoint("after firstCallback");

        const std::string runtimeConfigJson =
            buildRustRuntimeConfigJson(config, std::max(8'000, diagnostics.sampleRate));
        char* runtimeError = nullptr;
        const auto runtimeCreateStartedAt = std::chrono::steady_clock::now();
        setLastStartCheckpoint("before newRuntime");
        LOGI("startCapture: creating Rust runtime instance.");
        rustRuntime_ = rustBindings_.newRuntime(runtimeConfigJson.c_str(), &runtimeError);
        if (rustRuntime_ == nullptr) {
            std::string error = runtimeError != nullptr ? runtimeError : "Failed to create Rust detector runtime.";
            if (runtimeError != nullptr) {
                rustBindings_.freeString(runtimeError);
            }
            diagnostics.fallbackReason = error;
            diagnostics.lastError = error;
            writeThreadSafeString(errorMutex_, lastError_, error);
            setLastStartCheckpoint("error newRuntime: " + diagnostics.fallbackReason);
            LOGE("startCapture: Rust runtime creation failed: %s", diagnostics.fallbackReason.c_str());
            stopCaptureLocked("runtime_create_failed");
            return errorEnvelope(error, &diagnostics);
        }
        setLastStartCheckpoint("after newRuntime");
        diagnostics.runtimeSampleRate = std::max(8'000, diagnostics.sampleRate);
        diagnostics.detectorReady = true;
        diagnostics.targetBlockSize = blockSize_;
        LOGI(
            "startCapture: Rust runtime created in %.2f ms with runtimeSampleRate=%d.",
            std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - runtimeCreateStartedAt)
                .count(),
            diagnostics.runtimeSampleRate);

        workerRunning_.store(true);
        workerThread_ = std::thread([this]() { workerLoop(); });

        running_.store(true);
        updateSanityMetricsLocked(diagnostics);
        logDiagnostics(diagnostics);
        setLastStartCheckpoint("completed ok backend=" + config.backendName);
        LOGI(
            "startCapture: success backend=%s elapsed=%.2f ms.",
            config.backendName.c_str(),
            std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - startCaptureStartedAt)
                .count());
        return okEnvelope(
            "\"running\":true,\"diagnostics\":" + diagnosticsToJson(diagnostics));
    }

    std::string stopCapture()
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        stopCaptureLocked("ipc_stop_capture");
        return okEnvelope(
            "\"running\":false,\"diagnostics\":" + diagnosticsToJson(lastDiagnostics_));
    }

    std::string pollResults(int32_t maxResults, bool includeDiagnostics)
    {
        DiagnosticsSnapshot diagnostics;
        if (includeDiagnostics) {
            std::lock_guard<std::mutex> stateLock(stateMutex_);
            diagnostics = lastDiagnostics_;
            updateSanityMetricsLocked(diagnostics);
        }
        std::lock_guard<std::mutex> lock(resultsMutex_);
        std::ostringstream out;
        out << "{\"ok\":true,\"results\":[";
        int32_t emitted = 0;
        while (!detectorQueue_.empty() && emitted < maxResults) {
            if (emitted > 0) {
                out << ",";
            }
            out << mergeDetectorJson(detectorQueue_.front());
            detectorQueue_.pop_front();
            emitted += 1;
        }
        out << "],\"running\":" << boolString(running_.load());
        if (includeDiagnostics) {
            out << ",\"diagnostics\":" << diagnosticsToJson(diagnostics);
        }
        out << "}";
        return out.str();
    }

    std::string updateGameplayContext(const std::string& contextJson)
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (rustRuntime_ == nullptr) {
            return errorEnvelope("Native detector runtime is not running.", &lastDiagnostics_);
        }
        char* error = rustBindings_.updateGameplayContext(
            rustRuntime_,
            contextJson.c_str());
        if (error != nullptr) {
            std::string message(error);
            rustBindings_.freeString(error);
            return errorEnvelope(message, &lastDiagnostics_);
        }
        return okEnvelope("\"updated\":true");
    }

    std::string resetDetector(bool allowWhileRunning)
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        resetRequestCount_.fetch_add(1, std::memory_order_relaxed);
        const bool running = running_.load(std::memory_order_relaxed);
        if (running && !allowWhileRunning) {
            writeThreadSafeString(
                workerStateMutex_,
                lastProcessingState_,
                "reset_blocked_while_running");
            updateSanityMetricsLocked(lastDiagnostics_);
            return okEnvelope("\"reset\":false,\"blocked_while_running\":true");
        }
        const uint64_t pendingSamples = ringBuffer_ != nullptr ? ringBuffer_->availableToRead() : 0;
        pendingSamplesOnLastReset_.store(pendingSamples, std::memory_order_relaxed);
        if (running) {
            resetWhileRunningCount_.fetch_add(1, std::memory_order_relaxed);
            writeThreadSafeString(
                workerStateMutex_,
                lastProcessingState_,
                "reset_requested_while_running pending=" + std::to_string(pendingSamples));
            LOGW(
                "resetDetector: runtime reset requested while capture active pendingSamples=%llu.",
                static_cast<unsigned long long>(pendingSamples));
        } else {
            writeThreadSafeString(
                workerStateMutex_,
                lastProcessingState_,
                "reset_requested_while_stopped pending=" + std::to_string(pendingSamples));
        }
        if (pendingSamples > 0 && ringBuffer_ != nullptr) {
            ringBuffer_->reset();
            discardedSampleCount_.fetch_add(pendingSamples, std::memory_order_relaxed);
            lastProcessedSamples_ = totalCapturedSamples_.load(std::memory_order_relaxed);
            {
                std::lock_guard<std::mutex> resultsLock(resultsMutex_);
                detectorQueue_.clear();
            }
            writeThreadSafeString(
                discardReasonMutex_,
                lastDiscardReason_,
                "reset_cleared_pending_samples count=" + std::to_string(pendingSamples));
        }
        if (rustRuntime_ != nullptr) {
            rustBindings_.resetRuntime(rustRuntime_);
        }
        updateSanityMetricsLocked(lastDiagnostics_);
        return okEnvelope("\"reset\":true,\"blocked_while_running\":false");
    }

    void handlePause()
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        restartOnResume_ = running_.load();
        stopCaptureLocked("lifecycle_pause");
    }

    void handleResume()
    {
        StartConfig config;
        bool shouldRestart = false;
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            if (!restartOnResume_) {
                return;
            }
            restartOnResume_ = false;
            config = lastConfig_;
        }
        startCapture(config);
    }

    oboe::DataCallbackResult onAudioReady(
        oboe::AudioStream* audioStream,
        void* audioData,
        int32_t numFrames) override
    {
        const int32_t channelCount = std::max<int32_t>(1, audioStream->getChannelCount());
        const size_t inputSampleCount = static_cast<size_t>(numFrames) * static_cast<size_t>(channelCount);
        framesPerCallbackActual_.store(numFrames, std::memory_order_relaxed);
        const uint64_t callbackCount = callbackCount_.fetch_add(1, std::memory_order_relaxed) + 1;
        totalCallbackInputSamples_.fetch_add(inputSampleCount, std::memory_order_relaxed);

        const float* input = static_cast<const float*>(audioData);
        const float* samplesForDetector = input;
        size_t detectorSampleCount = inputSampleCount;
        if (channelCount > 1) {
            if (callbackMonoScratch_.size() < static_cast<size_t>(numFrames)) {
                callbackMonoScratch_.resize(static_cast<size_t>(numFrames), 0.0f);
            }
            for (int32_t frame = 0; frame < numFrames; ++frame) {
                double sum = 0.0;
                for (int32_t channel = 0; channel < channelCount; ++channel) {
                    sum += input[static_cast<size_t>(frame) * static_cast<size_t>(channelCount)
                        + static_cast<size_t>(channel)];
                }
                callbackMonoScratch_[static_cast<size_t>(frame)] =
                    static_cast<float>(sum / static_cast<double>(channelCount));
            }
            samplesForDetector = callbackMonoScratch_.data();
            detectorSampleCount = static_cast<size_t>(numFrames);
        }

        if (ringBuffer_ != nullptr) {
            if (ringBuffer_->push(samplesForDetector, detectorSampleCount)) {
                totalCapturedSamples_.fetch_add(detectorSampleCount, std::memory_order_relaxed);
            } else {
                droppedBlocks_.fetch_add(1, std::memory_order_relaxed);
                discardedSampleCount_.fetch_add(detectorSampleCount, std::memory_order_relaxed);
                writeThreadSafeString(
                    discardReasonMutex_,
                    lastDiscardReason_,
                    "ring_buffer_overflow appended=0 samples=" + std::to_string(detectorSampleCount)
                        + " staged=" + std::to_string(ringBuffer_->availableToRead()));
            }
        }

        double sumSquares = 0.0;
        double sumAbs = 0.0;
        double peak = 0.0;
        for (size_t index = 0; index < inputSampleCount; ++index) {
            const double sample = input[index];
            sumSquares += sample * sample;
            sumAbs += std::abs(sample);
            peak = std::max(peak, std::abs(sample));
        }
        const double rms = inputSampleCount > 0
            ? std::sqrt(sumSquares / static_cast<double>(inputSampleCount))
            : 0.0;
        const bool allZero = peak <= 1e-9;
        const bool silent = rms <= 1e-4;
        if (allZero) {
            allZeroCallbackCount_.fetch_add(1, std::memory_order_relaxed);
        }
        if (silent) {
            silentCallbackCount_.fetch_add(1, std::memory_order_relaxed);
        } else {
            signalCallbackCount_.fetch_add(1, std::memory_order_relaxed);
        }
        peak_.store(std::max(peak_.load(std::memory_order_relaxed), peak), std::memory_order_relaxed);
        rmsAccumulator_.store(rms, std::memory_order_relaxed);
        avgAbsAccumulator_.store(
            inputSampleCount > 0 ? sumAbs / static_cast<double>(inputSampleCount) : 0.0,
            std::memory_order_relaxed);
        if (rms > 0.0) {
            const double currentNoiseFloor = noiseFloor_.load(std::memory_order_relaxed);
            noiseFloor_.store(std::min(currentNoiseFloor, rms), std::memory_order_relaxed);
        }
        if (shouldLogVerboseWorkerDetails()
            && (callbackCount == 1 || callbackCount % 120 == 0)) {
            const size_t stagedSampleCount = ringBuffer_ != nullptr ? ringBuffer_->availableToRead() : 0;
            LOGI(
                "audio callback summary callbacks=%llu frames=%d inputSamples=%zu detectorSamples=%zu staged=%zu stagedTotal=%llu rms=%.6f peak=%.6f silent=%d allZero=%d dropped=%llu discardedSamples=%llu",
                static_cast<unsigned long long>(callbackCount),
                numFrames,
                inputSampleCount,
                detectorSampleCount,
                stagedSampleCount,
                static_cast<unsigned long long>(totalCapturedSamples_.load(std::memory_order_relaxed)),
                rms,
                peak,
                silent ? 1 : 0,
                allZero ? 1 : 0,
                static_cast<unsigned long long>(droppedBlocks_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(discardedSampleCount_.load(std::memory_order_relaxed)));
        }

        return oboe::DataCallbackResult::Continue;
    }

    void onErrorAfterClose(oboe::AudioStream*, oboe::Result error) override
    {
        LOGW("Oboe stream closed after error: %s", oboe::convertToText(error));
        droppedBlocks_.fetch_add(1, std::memory_order_relaxed);
        writeThreadSafeString(
            errorMutex_,
            lastError_,
            std::string("Oboe stream closed after error: ") + oboe::convertToText(error));
    }

private:
    std::string buildRustRuntimeConfigJson(const StartConfig& config, int32_t runtimeSampleRate) const
    {
        std::ostringstream out;
        out << "{"
            << "\"backend_name\":" << quote(config.backendName)
            << ",\"sample_rate\":" << std::max(8000, runtimeSampleRate)
            << ",\"block_size\":" << std::max(256, config.blockSize)
            << ",\"audio_input_mode\":" << quote(config.audioInputMode)
            << ",\"spectral_model_json\":"
            << (config.spectralModelJson.empty() ? "null" : quote(config.spectralModelJson))
            << ",\"masp_assets_dir\":"
            << (config.maspAssetsDir.empty() ? "null" : quote(config.maspAssetsDir))
            << ",\"fretnet_model_path\":"
            << (config.fretnetModelPath.empty() ? "null" : quote(config.fretnetModelPath))
            << ",\"native_library_dir\":"
            << (config.nativeLibraryDir.empty() ? "null" : quote(config.nativeLibraryDir))
            << ",\"fretnet_ort_library_path\":"
            << (config.fretnetOrtLibraryPath.empty() ? "null" : quote(config.fretnetOrtLibraryPath))
            << "}";
        return out.str();
    }

    void resetCaptureCountersLocked()
    {
        detectorQueue_.clear();
        droppedBlocks_.store(0);
        callbackCount_.store(0);
        totalCallbackInputSamples_.store(0);
        totalCapturedSamples_.store(0);
        lastProcessedSamples_ = 0;
        peak_.store(0.0);
        avgAbsAccumulator_.store(0.0);
        rmsAccumulator_.store(0.0);
        noiseFloor_.store(std::numeric_limits<double>::max());
        framesPerCallbackActual_.store(0);
        allZeroCallbackCount_.store(0);
        silentCallbackCount_.store(0);
        signalCallbackCount_.store(0);
        processConditionCheckCount_.store(0);
        processConditionPassCount_.store(0);
        processSkipInsufficientSamplesCount_.store(0);
        processSkipRuntimeNotReadyCount_.store(0);
        processedBlockCount_.store(0);
        submittedSampleCount_.store(0);
        runtimeProcessCallCount_.store(0);
        runtimeProcessNullResultCount_.store(0);
        runtimeProcessErrorCount_.store(0);
        emittedResultCount_.store(0);
        discardedSampleCount_.store(0);
        stopRequestCount_.store(0);
        stopNoopCount_.store(0);
        resetRequestCount_.store(0);
        resetWhileRunningCount_.store(0);
        pendingSamplesOnLastStop_.store(0);
        pendingSamplesOnLastReset_.store(0);
        writeThreadSafeString(errorMutex_, lastError_, "");
        writeThreadSafeString(workerStateMutex_, lastProcessingState_, "idle");
        writeThreadSafeString(discardReasonMutex_, lastDiscardReason_, "");
    }

    bool waitForFirstCallbackLocked(int32_t timeoutMs)
    {
        const auto started = std::chrono::steady_clock::now();
        while (std::chrono::duration_cast<std::chrono::milliseconds>(
                   std::chrono::steady_clock::now() - started)
                   .count()
               < timeoutMs) {
            if (callbackCount_.load(std::memory_order_relaxed) > 0) {
                return true;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        return callbackCount_.load(std::memory_order_relaxed) > 0;
    }

    std::string openStreamLocked(
        int32_t requestedSampleRate,
        int32_t channelCount,
        int32_t framesPerCallback,
        const std::string& requestedInputPreset,
        const std::string& performanceMode,
        const std::string& sharingMode,
        DiagnosticsSnapshot& diagnostics)
    {
        oboe::AudioStreamBuilder builder;
        builder.setDirection(oboe::Direction::Input);
        builder.setFormat(oboe::AudioFormat::Float);
        builder.setChannelCount(std::max(1, channelCount));
        builder.setSampleRate(std::max(8000, requestedSampleRate));
        builder.setInputPreset(parseInputPreset(requestedInputPreset));
        builder.setPerformanceMode(parsePerformanceMode(performanceMode));
        builder.setSharingMode(parseSharingMode(sharingMode));
        builder.setDataCallback(this);
        builder.setErrorCallback(this);
        if (framesPerCallback > 0) {
            builder.setFramesPerDataCallback(framesPerCallback);
        }

        const oboe::Result result = builder.openStream(stream_);
        if (result != oboe::Result::OK || stream_ == nullptr) {
            return std::string("Failed to open Oboe input stream: ") + oboe::convertToText(result);
        }

        diagnostics.actualInputPreset = requestedInputPreset;
        diagnostics.audioApi = oboe::convertToText(stream_->getAudioApi());
        diagnostics.sharingMode = oboe::convertToText(stream_->getSharingMode());
        diagnostics.performanceMode = oboe::convertToText(stream_->getPerformanceMode());
        diagnostics.sampleRate = stream_->getSampleRate();
        diagnostics.hardwareSampleRate = stream_->getHardwareSampleRate();
        diagnostics.channelCount = stream_->getChannelCount();
        diagnostics.hardwareChannelCount = stream_->getHardwareChannelCount();
        diagnostics.format = oboe::convertToText(stream_->getFormat());
        diagnostics.framesPerBurst = stream_->getFramesPerBurst();
        diagnostics.framesPerCallback = framesPerCallback > 0 ? framesPerCallback : stream_->getFramesPerBurst();
        diagnostics.deviceId = stream_->getDeviceId();
        diagnostics.streamState = oboe::convertToText(stream_->getState());
        lastDiagnostics_ = diagnostics;
        return {};
    }

    void updateSanityMetricsLocked(DiagnosticsSnapshot& diagnostics)
    {
        diagnostics.backendName = lastConfig_.backendName.empty() ? diagnostics.backendName : lastConfig_.backendName;
        diagnostics.framesPerCallback = framesPerCallbackActual_.load(std::memory_order_relaxed) > 0
            ? framesPerCallbackActual_.load(std::memory_order_relaxed)
            : diagnostics.framesPerCallback;
        diagnostics.callbackCount = callbackCount_.load(std::memory_order_relaxed);
        diagnostics.droppedBlocks = droppedBlocks_.load(std::memory_order_relaxed);
        diagnostics.totalCallbackSamples = totalCallbackInputSamples_.load(std::memory_order_relaxed);
        diagnostics.totalStagedSamples = totalCapturedSamples_.load(std::memory_order_relaxed);
        diagnostics.stagedSampleCount = ringBuffer_ != nullptr ? ringBuffer_->availableToRead() : 0;
        diagnostics.allZeroCallbackCount = allZeroCallbackCount_.load(std::memory_order_relaxed);
        diagnostics.silentCallbackCount = silentCallbackCount_.load(std::memory_order_relaxed);
        diagnostics.signalCallbackCount = signalCallbackCount_.load(std::memory_order_relaxed);
        diagnostics.rms = rmsAccumulator_.load(std::memory_order_relaxed);
        diagnostics.averageAbs = avgAbsAccumulator_.load(std::memory_order_relaxed);
        diagnostics.peak = peak_.load(std::memory_order_relaxed);
        diagnostics.runtimeSampleRate = diagnostics.runtimeSampleRate > 0
            ? diagnostics.runtimeSampleRate
            : std::max(0, lastDiagnostics_.runtimeSampleRate);
        diagnostics.targetBlockSize = blockSize_;
        diagnostics.processConditionCheckCount = processConditionCheckCount_.load(std::memory_order_relaxed);
        diagnostics.processConditionPassCount = processConditionPassCount_.load(std::memory_order_relaxed);
        diagnostics.processSkipInsufficientSamplesCount =
            processSkipInsufficientSamplesCount_.load(std::memory_order_relaxed);
        diagnostics.processSkipRuntimeNotReadyCount =
            processSkipRuntimeNotReadyCount_.load(std::memory_order_relaxed);
        diagnostics.processedBlockCount = processedBlockCount_.load(std::memory_order_relaxed);
        diagnostics.submittedSampleCount = submittedSampleCount_.load(std::memory_order_relaxed);
        diagnostics.runtimeProcessCallCount = runtimeProcessCallCount_.load(std::memory_order_relaxed);
        diagnostics.runtimeProcessNullResultCount =
            runtimeProcessNullResultCount_.load(std::memory_order_relaxed);
        diagnostics.runtimeProcessErrorCount = runtimeProcessErrorCount_.load(std::memory_order_relaxed);
        diagnostics.emittedResultCount = emittedResultCount_.load(std::memory_order_relaxed);
        diagnostics.discardedSampleCount = discardedSampleCount_.load(std::memory_order_relaxed);
        diagnostics.stopRequestCount = stopRequestCount_.load(std::memory_order_relaxed);
        diagnostics.stopNoopCount = stopNoopCount_.load(std::memory_order_relaxed);
        diagnostics.resetRequestCount = resetRequestCount_.load(std::memory_order_relaxed);
        diagnostics.resetWhileRunningCount = resetWhileRunningCount_.load(std::memory_order_relaxed);
        diagnostics.pendingSamplesOnLastStop = pendingSamplesOnLastStop_.load(std::memory_order_relaxed);
        diagnostics.pendingSamplesOnLastReset = pendingSamplesOnLastReset_.load(std::memory_order_relaxed);
        diagnostics.detectorReady = rustRuntime_ != nullptr;
        diagnostics.lastProcessingState = readThreadSafeString(workerStateMutex_, lastProcessingState_);
        diagnostics.lastDiscardReason = readThreadSafeString(discardReasonMutex_, lastDiscardReason_);
        diagnostics.lastError = readThreadSafeString(errorMutex_, lastError_);
        const double noiseFloor = noiseFloor_.load(std::memory_order_relaxed);
        diagnostics.noiseFloor = std::isfinite(noiseFloor) ? noiseFloor : 0.0;
        diagnostics.streamState = stream_ != nullptr ? oboe::convertToText(stream_->getState()) : "closed";
        {
            std::lock_guard<std::mutex> resultsLock(resultsMutex_);
            diagnostics.detectorQueueDepth = detectorQueue_.size();
        }
        lastDiagnostics_ = diagnostics;
    }

    void logDiagnostics(const DiagnosticsSnapshot& diagnostics) const
    {
        LOGI(
            "Oboe diagnostics backend=%s preset=%s audioApi=%s sharing=%s perf=%s sr=%d hwSr=%d runtimeSr=%d ch=%d hwCh=%d fmt=%s burst=%d callback=%d block=%d device=%d state=%s callbacks=%llu callbackSamples=%llu stagedTotal=%llu stagedNow=%llu signal=%llu silent=%llu allZero=%llu checks=%llu passes=%llu processed=%llu runtimeCalls=%llu nullResults=%llu emitted=%llu queue=%llu dropped=%llu discardedSamples=%llu peak=%.6f rms=%.6f lastProc=%s lastDiscard=%s lastError=%s",
            diagnostics.backendName.c_str(),
            diagnostics.actualInputPreset.c_str(),
            diagnostics.audioApi.c_str(),
            diagnostics.sharingMode.c_str(),
            diagnostics.performanceMode.c_str(),
            diagnostics.sampleRate,
            diagnostics.hardwareSampleRate,
            diagnostics.runtimeSampleRate,
            diagnostics.channelCount,
            diagnostics.hardwareChannelCount,
            diagnostics.format.c_str(),
            diagnostics.framesPerBurst,
            diagnostics.framesPerCallback,
            diagnostics.targetBlockSize,
            diagnostics.deviceId,
            diagnostics.streamState.c_str(),
            static_cast<unsigned long long>(diagnostics.callbackCount),
            static_cast<unsigned long long>(diagnostics.totalCallbackSamples),
            static_cast<unsigned long long>(diagnostics.totalStagedSamples),
            static_cast<unsigned long long>(diagnostics.stagedSampleCount),
            static_cast<unsigned long long>(diagnostics.signalCallbackCount),
            static_cast<unsigned long long>(diagnostics.silentCallbackCount),
            static_cast<unsigned long long>(diagnostics.allZeroCallbackCount),
            static_cast<unsigned long long>(diagnostics.processConditionCheckCount),
            static_cast<unsigned long long>(diagnostics.processConditionPassCount),
            static_cast<unsigned long long>(diagnostics.processedBlockCount),
            static_cast<unsigned long long>(diagnostics.runtimeProcessCallCount),
            static_cast<unsigned long long>(diagnostics.runtimeProcessNullResultCount),
            static_cast<unsigned long long>(diagnostics.emittedResultCount),
            static_cast<unsigned long long>(diagnostics.detectorQueueDepth),
            static_cast<unsigned long long>(diagnostics.droppedBlocks),
            static_cast<unsigned long long>(diagnostics.discardedSampleCount),
            diagnostics.peak,
            diagnostics.rms,
            diagnostics.lastProcessingState.empty() ? "<none>" : diagnostics.lastProcessingState.c_str(),
            diagnostics.lastDiscardReason.empty() ? "<none>" : diagnostics.lastDiscardReason.c_str(),
            diagnostics.lastError.empty() ? "<none>" : diagnostics.lastError.c_str());
    }

    void workerLoop()
    {
        while (workerRunning_.load(std::memory_order_acquire)) {
            if (ringBuffer_ == nullptr || rustRuntime_ == nullptr) {
                const uint64_t skipCount =
                    processSkipRuntimeNotReadyCount_.fetch_add(1, std::memory_order_relaxed) + 1;
                if (skipCount == 1 || skipCount % 120 == 0) {
                    writeThreadSafeString(
                        workerStateMutex_,
                        lastProcessingState_,
                        std::string("waiting_for_runtime ring=")
                            + (ringBuffer_ == nullptr ? "0" : "1")
                            + " runtime=" + (rustRuntime_ == nullptr ? "0" : "1"));
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(4));
                continue;
            }

            const size_t available = ringBuffer_->availableToRead();
            const uint64_t checkCount =
                processConditionCheckCount_.fetch_add(1, std::memory_order_relaxed) + 1;
            if (available < workerScratch_.size()) {
                const uint64_t skipCount =
                    processSkipInsufficientSamplesCount_.fetch_add(1, std::memory_order_relaxed) + 1;
                if (shouldLogVerboseWorkerDetails()
                    && (checkCount == 1 || skipCount == 1 || skipCount % 160 == 0)) {
                    writeThreadSafeString(
                        workerStateMutex_,
                        lastProcessingState_,
                        "waiting_for_full_block staged=" + std::to_string(available)
                            + " target=" + std::to_string(workerScratch_.size()));
                    LOGI(
                        "detector worker waiting staged=%zu target=%zu checks=%llu skips=%llu backend=%s",
                        available,
                        workerScratch_.size(),
                        static_cast<unsigned long long>(checkCount),
                        static_cast<unsigned long long>(skipCount),
                        lastConfig_.backendName.c_str());
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
                continue;
            }

            processConditionPassCount_.fetch_add(1, std::memory_order_relaxed);
            const size_t samplesRead = ringBuffer_->pop(workerScratch_.data(), workerScratch_.size());
            if (samplesRead < workerScratch_.size()) {
                discardedSampleCount_.fetch_add(samplesRead, std::memory_order_relaxed);
                writeThreadSafeString(
                    discardReasonMutex_,
                    lastDiscardReason_,
                    "short_ring_pop expected=" + std::to_string(workerScratch_.size())
                        + " got=" + std::to_string(samplesRead));
                writeThreadSafeString(
                    workerStateMutex_,
                    lastProcessingState_,
                    "short_ring_pop expected=" + std::to_string(workerScratch_.size())
                        + " got=" + std::to_string(samplesRead));
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
                continue;
            }

            lastProcessedSamples_ += samplesRead;
            submittedSampleCount_.fetch_add(samplesRead, std::memory_order_relaxed);
            const uint64_t processedBlockCount =
                processedBlockCount_.fetch_add(1, std::memory_order_relaxed) + 1;
            const double captureTimeSec = static_cast<double>(lastProcessedSamples_)
                / static_cast<double>(std::max(1, lastDiagnostics_.sampleRate));
            char* detectorJson = nullptr;
            const auto started = std::chrono::steady_clock::now();
            runtimeProcessCallCount_.fetch_add(1, std::memory_order_relaxed);
            char* error = rustBindings_.processAudioBlock(
                rustRuntime_,
                workerScratch_.data(),
                workerScratch_.size(),
                captureTimeSec,
                &detectorJson);
            const double processingMs = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - started)
                .count();

            if (error != nullptr) {
                runtimeProcessErrorCount_.fetch_add(1, std::memory_order_relaxed);
                std::string message(error);
                rustBindings_.freeString(error);
                writeThreadSafeString(errorMutex_, lastError_, message);
                writeThreadSafeString(
                    workerStateMutex_,
                    lastProcessingState_,
                    "rust_error " + message);
                LOGW("Rust detector processing failed: %s", message.c_str());
                continue;
            }
            if (detectorJson == nullptr) {
                const uint64_t nullResultCount =
                    runtimeProcessNullResultCount_.fetch_add(1, std::memory_order_relaxed) + 1;
                if (shouldLogVerboseWorkerDetails()
                    && (nullResultCount == 1 || nullResultCount % 64 == 0)) {
                    writeThreadSafeString(
                        workerStateMutex_,
                        lastProcessingState_,
                        "rust_returned_no_result backend=" + lastConfig_.backendName
                            + " processed=" + std::to_string(processedBlockCount));
                    LOGI(
                        "detector worker no-result backend=%s processed=%llu nullResults=%llu submitted=%llu",
                        lastConfig_.backendName.c_str(),
                        static_cast<unsigned long long>(processedBlockCount),
                        static_cast<unsigned long long>(nullResultCount),
                        static_cast<unsigned long long>(submittedSampleCount_.load(std::memory_order_relaxed)));
                }
                continue;
            }
            writeThreadSafeString(errorMutex_, lastError_, "");

            QueuedDetectionResult item;
            item.detectorJson = detectorJson;
            item.processingTimeMs = processingMs;
            const uint64_t currentCapturedSamples = totalCapturedSamples_.load(std::memory_order_relaxed);
            item.callbackToResultLatencyMs = std::max(
                0.0,
                (static_cast<double>(currentCapturedSamples - lastProcessedSamples_)
                    / static_cast<double>(std::max(1, lastDiagnostics_.sampleRate)))
                    * 1000.0);
            item.droppedBlocks = droppedBlocks_.load(std::memory_order_relaxed);
            item.overrun = item.droppedBlocks > 0;
            size_t queueDepthAfterPush = 0;
            const double callbackLatencyMs = item.callbackToResultLatencyMs;
            {
                std::lock_guard<std::mutex> lock(resultsMutex_);
                item.detectorQueueDepth = detectorQueue_.size();
                detectorQueue_.push_back(std::move(item));
                while (detectorQueue_.size() > 64) {
                    detectorQueue_.pop_front();
                }
                queueDepthAfterPush = detectorQueue_.size();
            }
            const uint64_t emittedResultCount =
                emittedResultCount_.fetch_add(1, std::memory_order_relaxed) + 1;
            writeThreadSafeString(
                workerStateMutex_,
                lastProcessingState_,
                "result_enqueued backend=" + lastConfig_.backendName
                    + " processed=" + std::to_string(processedBlockCount)
                    + " emitted=" + std::to_string(emittedResultCount));
            if (shouldLogVerboseWorkerDetails()
                && (processedBlockCount == 1 || processedBlockCount % 32 == 0 || emittedResultCount == 1)) {
                LOGI(
                    "detector worker summary backend=%s processed=%llu emitted=%llu latencyMs=%.2f queue=%zu staged=%zu submitted=%llu nullResults=%llu runtimeErrors=%llu dropped=%llu",
                    lastConfig_.backendName.c_str(),
                    static_cast<unsigned long long>(processedBlockCount),
                    static_cast<unsigned long long>(emittedResultCount),
                    callbackLatencyMs,
                    queueDepthAfterPush,
                    ringBuffer_ != nullptr ? ringBuffer_->availableToRead() : 0,
                    static_cast<unsigned long long>(submittedSampleCount_.load(std::memory_order_relaxed)),
                    static_cast<unsigned long long>(runtimeProcessNullResultCount_.load(std::memory_order_relaxed)),
                    static_cast<unsigned long long>(runtimeProcessErrorCount_.load(std::memory_order_relaxed)),
                    static_cast<unsigned long long>(droppedBlocks_.load(std::memory_order_relaxed)));
            }
            rustBindings_.freeString(detectorJson);
        }
    }

    void closeStreamLocked()
    {
        if (stream_ == nullptr) {
            return;
        }
        stream_->close();
        stream_.reset();
    }

    void destroyRustRuntimeLocked()
    {
        if (rustRuntime_ != nullptr) {
            rustBindings_.destroyRuntime(rustRuntime_);
            rustRuntime_ = nullptr;
        }
    }

    void stopCaptureLocked(const char* reason)
    {
        stopRequestCount_.fetch_add(1, std::memory_order_relaxed);
        const uint64_t pendingSamples = ringBuffer_ != nullptr ? ringBuffer_->availableToRead() : 0;
        pendingSamplesOnLastStop_.store(pendingSamples, std::memory_order_relaxed);
        const bool alreadyIdle = !running_.load(std::memory_order_relaxed)
            && stream_ == nullptr
            && !workerThread_.joinable()
            && rustRuntime_ == nullptr
            && pendingSamples == 0;
        if (alreadyIdle) {
            stopNoopCount_.fetch_add(1, std::memory_order_relaxed);
            writeThreadSafeString(
                workerStateMutex_,
                lastProcessingState_,
                std::string("stop_noop reason=") + (reason == nullptr ? "unknown" : reason));
            updateSanityMetricsLocked(lastDiagnostics_);
            return;
        }
        writeThreadSafeString(
            workerStateMutex_,
            lastProcessingState_,
            std::string("stopping reason=") + (reason == nullptr ? "unknown" : reason)
                + " pending=" + std::to_string(pendingSamples));
        running_.store(false);
        workerRunning_.store(false);
        if (stream_ != nullptr) {
            stream_->requestStop();
        }
        if (workerThread_.joinable()) {
            workerThread_.join();
        }
        closeStreamLocked();
        destroyRustRuntimeLocked();
        if (ringBuffer_ != nullptr) {
            ringBuffer_->reset();
        }
        writeThreadSafeString(
            workerStateMutex_,
            lastProcessingState_,
            std::string("stopped reason=") + (reason == nullptr ? "unknown" : reason)
                + " pendingDiscarded=" + std::to_string(pendingSamples));
        updateSanityMetricsLocked(lastDiagnostics_);
    }

    std::mutex stateMutex_;
    std::mutex resultsMutex_;
    StartConfig lastConfig_;
    DiagnosticsSnapshot lastDiagnostics_;
    std::shared_ptr<oboe::AudioStream> stream_;
    std::unique_ptr<FloatRingBuffer> ringBuffer_;
    std::thread workerThread_;
    std::vector<float> workerScratch_;
    std::deque<QueuedDetectionResult> detectorQueue_;
    std::atomic<bool> workerRunning_{false};
    std::atomic<bool> running_{false};
    bool restartOnResume_{false};
    std::atomic<uint64_t> callbackCount_{0};
    std::atomic<uint64_t> droppedBlocks_{0};
    std::atomic<uint64_t> totalCallbackInputSamples_{0};
    std::atomic<uint64_t> totalCapturedSamples_{0};
    std::atomic<uint64_t> allZeroCallbackCount_{0};
    std::atomic<uint64_t> silentCallbackCount_{0};
    std::atomic<uint64_t> signalCallbackCount_{0};
    std::atomic<uint64_t> processConditionCheckCount_{0};
    std::atomic<uint64_t> processConditionPassCount_{0};
    std::atomic<uint64_t> processSkipInsufficientSamplesCount_{0};
    std::atomic<uint64_t> processSkipRuntimeNotReadyCount_{0};
    std::atomic<uint64_t> processedBlockCount_{0};
    std::atomic<uint64_t> submittedSampleCount_{0};
    std::atomic<uint64_t> runtimeProcessCallCount_{0};
    std::atomic<uint64_t> runtimeProcessNullResultCount_{0};
    std::atomic<uint64_t> runtimeProcessErrorCount_{0};
    std::atomic<uint64_t> emittedResultCount_{0};
    std::atomic<uint64_t> discardedSampleCount_{0};
    std::atomic<uint64_t> stopRequestCount_{0};
    std::atomic<uint64_t> stopNoopCount_{0};
    std::atomic<uint64_t> resetRequestCount_{0};
    std::atomic<uint64_t> resetWhileRunningCount_{0};
    std::atomic<bool> debugLoggingEnabled_{false};
    std::atomic<bool> verboseNativePitchDiagnostics_{false};
    std::atomic<bool> traceFretnetRuntime_{false};
    std::atomic<uint64_t> pendingSamplesOnLastStop_{0};
    std::atomic<uint64_t> pendingSamplesOnLastReset_{0};
    uint64_t lastProcessedSamples_{0};
    std::atomic<int32_t> framesPerCallbackActual_{0};
    std::atomic<double> peak_{0.0};
    std::atomic<double> rmsAccumulator_{0.0};
    std::atomic<double> avgAbsAccumulator_{0.0};
    std::atomic<double> noiseFloor_{std::numeric_limits<double>::max()};
    std::mutex errorMutex_;
    std::mutex workerStateMutex_;
    std::mutex discardReasonMutex_;
    std::string lastError_;
    std::string lastProcessingState_;
    std::string lastDiscardReason_;
    int32_t blockSize_{kDefaultBlockSize};
    std::vector<float> callbackMonoScratch_;
    RustRuntimeBindings rustBindings_;
    NativePitchRuntimeHandle* rustRuntime_{nullptr};

    bool shouldLogVerboseWorkerDetails() const
    {
        if (verboseNativePitchDiagnostics_.load(std::memory_order_relaxed)) {
            return true;
        }
        return traceFretnetRuntime_.load(std::memory_order_relaxed)
            && lastConfig_.backendName == "fretnet";
    }
};

NativePitchInputEngine& engine()
{
    static NativePitchInputEngine instance;
    return instance;
}

static std::string fromJString(JNIEnv* env, jstring value)
{
    if (value == nullptr) {
        return {};
    }
    const char* chars = env->GetStringUTFChars(value, nullptr);
    if (chars == nullptr) {
        return {};
    }
    std::string out(chars);
    env->ReleaseStringUTFChars(value, chars);
    return out;
}

} // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_guitarhelio_app_pitch_NativePitchInputPlugin_nativeGetDiagnostics(
    JNIEnv* env,
    jclass,
    jint requestedSampleRate,
    jint channelCount,
    jint framesPerCallback,
    jstring requestedInputPreset,
    jstring performanceMode,
    jstring sharingMode,
    jdouble captureSeconds,
    jboolean supportUnprocessedProperty,
    jint audioManagerSampleRate,
    jint audioManagerFramesPerBuffer)
{
    DiagnosticsConfig config;
    config.requestedSampleRate = requestedSampleRate;
    config.channelCount = channelCount;
    config.framesPerCallback = framesPerCallback;
    config.requestedInputPreset = fromJString(env, requestedInputPreset);
    config.performanceMode = fromJString(env, performanceMode);
    config.sharingMode = fromJString(env, sharingMode);
    config.captureSeconds = captureSeconds;
    config.supportUnprocessedProperty = supportUnprocessedProperty;
    config.audioManagerSampleRate = audioManagerSampleRate;
    config.audioManagerFramesPerBuffer = audioManagerFramesPerBuffer;
    const std::string result = engine().getDiagnostics(config);
    return env->NewStringUTF(result.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_guitarhelio_app_pitch_NativePitchInputPlugin_nativeStartCapture(
    JNIEnv* env,
    jclass,
    jstring backendName,
    jint requestedSampleRate,
    jint blockSize,
    jint channelCount,
    jint framesPerCallback,
    jstring requestedInputPreset,
    jstring performanceMode,
    jstring sharingMode,
    jstring audioInputMode,
    jstring spectralModelJson,
    jstring maspAssetsDir,
    jstring fretnetModelPath,
    jstring nativeLibraryDir,
    jstring fretnetOrtLibraryPath,
    jboolean supportUnprocessedProperty,
    jint audioManagerSampleRate,
    jint audioManagerFramesPerBuffer,
    jboolean debugLoggingEnabled,
    jboolean verboseNativePitchDiagnostics,
    jboolean traceFretnetRuntime)
{
    StartConfig config;
    config.backendName = fromJString(env, backendName);
    config.requestedSampleRate = requestedSampleRate;
    config.blockSize = blockSize;
    config.channelCount = channelCount;
    config.framesPerCallback = framesPerCallback;
    config.requestedInputPreset = fromJString(env, requestedInputPreset);
    config.performanceMode = fromJString(env, performanceMode);
    config.sharingMode = fromJString(env, sharingMode);
    config.audioInputMode = fromJString(env, audioInputMode);
    config.spectralModelJson = fromJString(env, spectralModelJson);
    config.maspAssetsDir = fromJString(env, maspAssetsDir);
    config.fretnetModelPath = fromJString(env, fretnetModelPath);
    config.nativeLibraryDir = fromJString(env, nativeLibraryDir);
    config.fretnetOrtLibraryPath = fromJString(env, fretnetOrtLibraryPath);
    config.supportUnprocessedProperty = supportUnprocessedProperty;
    config.audioManagerSampleRate = audioManagerSampleRate;
    config.audioManagerFramesPerBuffer = audioManagerFramesPerBuffer;
    config.debugLoggingEnabled = debugLoggingEnabled;
    config.verboseNativePitchDiagnostics = verboseNativePitchDiagnostics;
    config.traceFretnetRuntime = traceFretnetRuntime;
    LOGI(
        "JNI nativeStartCapture begin backend=%s sr=%d block=%d ch=%d callback=%d",
        config.backendName.c_str(),
        config.requestedSampleRate,
        config.blockSize,
        config.channelCount,
        config.framesPerCallback);
    const auto jniStartStartedAt = std::chrono::steady_clock::now();
    const std::string result = engine().startCapture(config);
    LOGI(
        "JNI nativeStartCapture end backend=%s elapsed=%.2f ms ok=%d",
        config.backendName.c_str(),
        std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - jniStartStartedAt)
            .count(),
        result.find("\"ok\":true") != std::string::npos ? 1 : 0);
    return env->NewStringUTF(result.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_guitarhelio_app_pitch_NativePitchInputPlugin_nativeStopCapture(JNIEnv* env, jclass)
{
    const std::string result = engine().stopCapture();
    return env->NewStringUTF(result.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_guitarhelio_app_pitch_NativePitchInputPlugin_nativePollResults(
    JNIEnv* env,
    jclass,
    jint maxResults,
    jboolean includeDiagnostics)
{
    const std::string result = engine().pollResults(std::max(1, maxResults), includeDiagnostics);
    return env->NewStringUTF(result.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_guitarhelio_app_pitch_NativePitchInputPlugin_nativeUpdateGameplayContext(
    JNIEnv* env,
    jclass,
    jstring contextJson)
{
    const std::string result = engine().updateGameplayContext(fromJString(env, contextJson));
    return env->NewStringUTF(result.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_guitarhelio_app_pitch_NativePitchInputPlugin_nativeResetDetector(
    JNIEnv* env,
    jclass,
    jboolean allowWhileRunning)
{
    const std::string result = engine().resetDetector(allowWhileRunning);
    return env->NewStringUTF(result.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_guitarhelio_app_pitch_NativePitchInputPlugin_nativeGetLastStartCheckpoint(
    JNIEnv* env,
    jclass)
{
    const std::string checkpoint = getLastStartCheckpoint();
    return env->NewStringUTF(checkpoint.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_com_guitarhelio_app_pitch_NativePitchInputPlugin_nativeHandlePause(JNIEnv*, jclass)
{
    engine().handlePause();
}

extern "C" JNIEXPORT void JNICALL
Java_com_guitarhelio_app_pitch_NativePitchInputPlugin_nativeHandleResume(JNIEnv*, jclass)
{
    engine().handleResume();
}

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

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, kTag, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, kTag, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, kTag, __VA_ARGS__)

struct NativePitchRuntimeHandle;

using NativePitchRuntimeNewFn = NativePitchRuntimeHandle* (*)(const char*, char**);
using NativePitchRuntimeDestroyFn = void (*)(NativePitchRuntimeHandle*);
using NativePitchRuntimeResetFn = void (*)(NativePitchRuntimeHandle*);
using NativePitchRuntimeUpdateGameplayContextFn = char* (*)(NativePitchRuntimeHandle*, const char*);
using NativePitchRuntimeProcessAudioBlockFn =
    char* (*)(NativePitchRuntimeHandle*, const float*, size_t, double, char**);
using NativePitchRuntimeFreeStringFn = void (*)(char*);

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
    bool supportUnprocessedProperty = false;
    int32_t audioManagerSampleRate = 0;
    int32_t audioManagerFramesPerBuffer = 0;
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
        stopCaptureLocked();

        DiagnosticsSnapshot diagnostics;
        diagnostics.requestedInputPreset = config.requestedInputPreset;
        diagnostics.supportUnprocessedProperty = config.supportUnprocessedProperty;

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
        stopCaptureLocked();
        lastConfig_ = config;
        DiagnosticsSnapshot diagnostics;
        diagnostics.requestedInputPreset = config.requestedInputPreset;
        diagnostics.supportUnprocessedProperty = config.supportUnprocessedProperty;

        if (!rustBindings_.ensureLoaded()) {
            diagnostics.fallbackReason = rustBindings_.loadError();
            return errorEnvelope(diagnostics.fallbackReason, &diagnostics);
        }

        const std::string runtimeConfigJson = buildRustRuntimeConfigJson(config);
        char* runtimeError = nullptr;
        rustRuntime_ = rustBindings_.newRuntime(runtimeConfigJson.c_str(), &runtimeError);
        if (rustRuntime_ == nullptr) {
            std::string error = runtimeError != nullptr ? runtimeError : "Failed to create Rust detector runtime.";
            if (runtimeError != nullptr) {
                rustBindings_.freeString(runtimeError);
            }
            diagnostics.fallbackReason = error;
            return errorEnvelope(error, &diagnostics);
        }

        const std::string openError = openStreamLocked(
            config.requestedSampleRate,
            config.channelCount,
            config.framesPerCallback,
            config.requestedInputPreset,
            config.performanceMode,
            config.sharingMode,
            diagnostics);
        if (!openError.empty()) {
            destroyRustRuntimeLocked();
            diagnostics.fallbackReason = openError;
            return errorEnvelope(openError, &diagnostics);
        }

        blockSize_ = std::max(256, config.blockSize);
        ringBuffer_ = std::make_unique<FloatRingBuffer>(
            static_cast<size_t>(diagnostics.sampleRate) * kDefaultRingBufferSeconds);
        workerScratch_.assign(static_cast<size_t>(blockSize_), 0.0f);
        detectorQueue_.clear();
        droppedBlocks_.store(0);
        callbackCount_.store(0);
        totalCapturedSamples_.store(0);
        lastProcessedSamples_ = 0;
        peak_.store(0.0);
        avgAbsAccumulator_.store(0.0);
        rmsAccumulator_.store(0.0);
        noiseFloor_.store(std::numeric_limits<double>::max());
        framesPerCallbackActual_.store(0);

        workerRunning_.store(true);
        workerThread_ = std::thread([this]() { workerLoop(); });
        const oboe::Result startResult = stream_->requestStart();
        if (startResult != oboe::Result::OK) {
            const std::string error = std::string("Failed to start Oboe input stream: ")
                + oboe::convertToText(startResult);
            stopCaptureLocked();
            diagnostics.fallbackReason = error;
            return errorEnvelope(error, &diagnostics);
        }

        running_.store(true);
        logDiagnostics(diagnostics);
        return okEnvelope(
            "\"running\":true,\"diagnostics\":" + diagnosticsToJson(diagnostics));
    }

    std::string stopCapture()
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        stopCaptureLocked();
        return okEnvelope(
            "\"running\":false,\"diagnostics\":" + diagnosticsToJson(lastDiagnostics_));
    }

    std::string pollResults(int32_t maxResults)
    {
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
        out << "],\"diagnostics\":" << diagnosticsToJson(lastDiagnostics_)
            << ",\"running\":" << boolString(running_.load()) << "}";
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

    std::string resetDetector()
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (rustRuntime_ != nullptr) {
            rustBindings_.resetRuntime(rustRuntime_);
        }
        return okEnvelope("\"reset\":true");
    }

    void handlePause()
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        restartOnResume_ = running_.load();
        stopCaptureLocked();
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
        const size_t sampleCount = static_cast<size_t>(numFrames) * static_cast<size_t>(channelCount);
        framesPerCallbackActual_.store(numFrames, std::memory_order_relaxed);
        callbackCount_.fetch_add(1, std::memory_order_relaxed);
        totalCapturedSamples_.fetch_add(sampleCount, std::memory_order_relaxed);

        const float* input = static_cast<const float*>(audioData);
        if (ringBuffer_ != nullptr && !ringBuffer_->push(input, sampleCount)) {
            droppedBlocks_.fetch_add(1, std::memory_order_relaxed);
        }

        double sumSquares = 0.0;
        double sumAbs = 0.0;
        double peak = 0.0;
        for (size_t index = 0; index < sampleCount; ++index) {
            const double sample = input[index];
            sumSquares += sample * sample;
            sumAbs += std::abs(sample);
            peak = std::max(peak, std::abs(sample));
        }
        const double rms = sampleCount > 0 ? std::sqrt(sumSquares / static_cast<double>(sampleCount)) : 0.0;
        peak_.store(std::max(peak_.load(std::memory_order_relaxed), peak), std::memory_order_relaxed);
        rmsAccumulator_.store(rms, std::memory_order_relaxed);
        avgAbsAccumulator_.store(
            sampleCount > 0 ? sumAbs / static_cast<double>(sampleCount) : 0.0,
            std::memory_order_relaxed);
        if (rms > 0.0) {
            const double currentNoiseFloor = noiseFloor_.load(std::memory_order_relaxed);
            noiseFloor_.store(std::min(currentNoiseFloor, rms), std::memory_order_relaxed);
        }

        return oboe::DataCallbackResult::Continue;
    }

    void onErrorAfterClose(oboe::AudioStream*, oboe::Result error) override
    {
        LOGW("Oboe stream closed after error: %s", oboe::convertToText(error));
        droppedBlocks_.fetch_add(1, std::memory_order_relaxed);
    }

private:
    std::string buildRustRuntimeConfigJson(const StartConfig& config) const
    {
        std::ostringstream out;
        out << "{"
            << "\"backend_name\":" << quote(config.backendName)
            << ",\"sample_rate\":" << std::max(8000, lastDiagnostics_.sampleRate)
            << ",\"block_size\":" << std::max(256, config.blockSize)
            << ",\"audio_input_mode\":" << quote(config.audioInputMode)
            << ",\"spectral_model_json\":"
            << (config.spectralModelJson.empty() ? "null" : quote(config.spectralModelJson))
            << ",\"masp_assets_dir\":"
            << (config.maspAssetsDir.empty() ? "null" : quote(config.maspAssetsDir))
            << ",\"fretnet_model_path\":"
            << (config.fretnetModelPath.empty() ? "null" : quote(config.fretnetModelPath))
            << "}";
        return out.str();
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
        diagnostics.framesPerCallback = framesPerCallbackActual_.load(std::memory_order_relaxed) > 0
            ? framesPerCallbackActual_.load(std::memory_order_relaxed)
            : diagnostics.framesPerCallback;
        diagnostics.callbackCount = callbackCount_.load(std::memory_order_relaxed);
        diagnostics.droppedBlocks = droppedBlocks_.load(std::memory_order_relaxed);
        diagnostics.rms = rmsAccumulator_.load(std::memory_order_relaxed);
        diagnostics.averageAbs = avgAbsAccumulator_.load(std::memory_order_relaxed);
        diagnostics.peak = peak_.load(std::memory_order_relaxed);
        const double noiseFloor = noiseFloor_.load(std::memory_order_relaxed);
        diagnostics.noiseFloor = std::isfinite(noiseFloor) ? noiseFloor : 0.0;
        diagnostics.streamState = stream_ != nullptr ? oboe::convertToText(stream_->getState()) : "closed";
        lastDiagnostics_ = diagnostics;
    }

    void logDiagnostics(const DiagnosticsSnapshot& diagnostics) const
    {
        LOGI(
            "Oboe open: preset=%s audioApi=%s sharing=%s perf=%s sr=%d hwSr=%d ch=%d hwCh=%d fmt=%s burst=%d callback=%d device=%d state=%s dropped=%llu peak=%.6f rms=%.6f",
            diagnostics.actualInputPreset.c_str(),
            diagnostics.audioApi.c_str(),
            diagnostics.sharingMode.c_str(),
            diagnostics.performanceMode.c_str(),
            diagnostics.sampleRate,
            diagnostics.hardwareSampleRate,
            diagnostics.channelCount,
            diagnostics.hardwareChannelCount,
            diagnostics.format.c_str(),
            diagnostics.framesPerBurst,
            diagnostics.framesPerCallback,
            diagnostics.deviceId,
            diagnostics.streamState.c_str(),
            static_cast<unsigned long long>(diagnostics.droppedBlocks),
            diagnostics.peak,
            diagnostics.rms);
    }

    void workerLoop()
    {
        while (workerRunning_.load(std::memory_order_acquire)) {
            if (ringBuffer_ == nullptr || rustRuntime_ == nullptr) {
                std::this_thread::sleep_for(std::chrono::milliseconds(4));
                continue;
            }

            const size_t samplesRead = ringBuffer_->pop(workerScratch_.data(), workerScratch_.size());
            if (samplesRead < workerScratch_.size()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
                continue;
            }

            lastProcessedSamples_ += samplesRead;
            const double captureTimeSec = static_cast<double>(lastProcessedSamples_)
                / static_cast<double>(std::max(1, lastDiagnostics_.sampleRate));
            char* detectorJson = nullptr;
            const auto started = std::chrono::steady_clock::now();
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
                std::string message(error);
                rustBindings_.freeString(error);
                LOGW("Rust detector processing failed: %s", message.c_str());
                continue;
            }
            if (detectorJson == nullptr) {
                continue;
            }

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
            {
                std::lock_guard<std::mutex> lock(resultsMutex_);
                item.detectorQueueDepth = detectorQueue_.size();
                detectorQueue_.push_back(std::move(item));
                while (detectorQueue_.size() > 64) {
                    detectorQueue_.pop_front();
                }
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

    void stopCaptureLocked()
    {
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
    std::atomic<uint64_t> totalCapturedSamples_{0};
    uint64_t lastProcessedSamples_{0};
    std::atomic<int32_t> framesPerCallbackActual_{0};
    std::atomic<double> peak_{0.0};
    std::atomic<double> rmsAccumulator_{0.0};
    std::atomic<double> avgAbsAccumulator_{0.0};
    std::atomic<double> noiseFloor_{std::numeric_limits<double>::max()};
    int32_t blockSize_{kDefaultBlockSize};
    RustRuntimeBindings rustBindings_;
    NativePitchRuntimeHandle* rustRuntime_{nullptr};
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
    jboolean supportUnprocessedProperty,
    jint audioManagerSampleRate,
    jint audioManagerFramesPerBuffer)
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
    config.supportUnprocessedProperty = supportUnprocessedProperty;
    config.audioManagerSampleRate = audioManagerSampleRate;
    config.audioManagerFramesPerBuffer = audioManagerFramesPerBuffer;
    const std::string result = engine().startCapture(config);
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
    jint maxResults)
{
    const std::string result = engine().pollResults(std::max(1, maxResults));
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
Java_com_guitarhelio_app_pitch_NativePitchInputPlugin_nativeResetDetector(JNIEnv* env, jclass)
{
    const std::string result = engine().resetDetector();
    return env->NewStringUTF(result.c_str());
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

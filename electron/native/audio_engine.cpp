#include "audio_engine.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <sstream>
#include <thread>

#ifdef _WIN32
#include <pa_win_wasapi.h>
#endif

namespace gh::native_pitch {
namespace {

constexpr int kDefaultSampleRate = 48000;
constexpr int kDefaultBlockSize = 2048;
constexpr int kMinBufferFrames = 64;
constexpr int kMaxQueueDepth = 128;
constexpr int kRingBufferSeconds = 4;

std::string quoteJson(const std::string& value)
{
    std::ostringstream out;
    out << '"';
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
    out << '"';
    return out.str();
}

std::string sanitizePortAudioError(PaError error)
{
    if (error == paNoError) {
        return {};
    }
    const char* text = Pa_GetErrorText(error);
    if (text == nullptr || std::strlen(text) == 0) {
        return "Unknown PortAudio error";
    }
    return text;
}

int sanitizeSampleRate(int value)
{
    if (value <= 0) {
        return kDefaultSampleRate;
    }
    return std::max(8000, value);
}

int sanitizeBufferFrames(int value)
{
    if (value <= 0) {
        return kDefaultBlockSize;
    }
    return std::max(kMinBufferFrames, value);
}

bool validateDetectorRuntimeConfig(const StartCaptureConfig& config, std::string& error)
{
    if ((config.detector == "masp" || config.detector == "masp_game_scene_ts_v1")
        && config.maspAssetsDir.empty()) {
        error =
            "MASP backend requires maspAssetsDir. Windows package currently does not bundle MASP assets by default.";
        return false;
    }

    if (config.detector == "fretnet" && config.fretnetModelPath.empty()) {
        error = "FretNet backend requires fretnetModelPath.";
        return false;
    }

    if (config.detector == "spectral_game_runtime_unified_v3" && config.spectralModelJson.empty()) {
        error = "Spectral backend requires spectralModelJson.";
        return false;
    }

    return true;
}

} // namespace

AudioEngine& AudioEngine::instance()
{
    static AudioEngine engine;
    return engine;
}

AudioEngine::AudioEngine()
{
    diagnostics_.streamState = "stopped";
}

AudioEngine::~AudioEngine()
{
    shutdown();
}

bool AudioEngine::startCapture(const StartCaptureConfig& config, std::string& error)
{
    std::lock_guard<std::mutex> lock(stateMutex_);
    return startCaptureLocked(config, error);
}

bool AudioEngine::startCaptureLocked(const StartCaptureConfig& config, std::string& error)
{
    stopCaptureLocked();

    if (!ensurePortAudioInitialized(error)) {
        return false;
    }

    lastStartConfig_ = config;
    if (lastStartConfig_.detector.empty()) {
        lastStartConfig_.detector = "ac14";
    }
    lastStartConfig_.sampleRateHint = sanitizeSampleRate(lastStartConfig_.sampleRateHint);
    lastStartConfig_.bufferFrames = sanitizeBufferFrames(lastStartConfig_.bufferFrames);

    if (!validateDetectorRuntimeConfig(lastStartConfig_, error)) {
        diagnostics_.streamState = "error";
        diagnostics_.fallbackReason = error;
        return false;
    }

    diagnostics_.backendRequested = "WASAPI Exclusive";
    diagnostics_.sampleRateRequested = lastStartConfig_.sampleRateHint;
    diagnostics_.bufferFramesRequested = lastStartConfig_.bufferFrames;
    diagnostics_.streamState = "opening";
    diagnostics_.fallbackReason.clear();

    if (!openInputStreamLocked(lastStartConfig_, error, false)) {
        diagnostics_.streamState = "error";
        diagnostics_.fallbackReason = error;
        return false;
    }

    if (!createRustRuntimeLocked(lastStartConfig_, error)) {
        diagnostics_.fallbackReason = error;
        closeInputStreamLocked();
        diagnostics_.streamState = "error";
        return false;
    }

    ringCapacity_ = static_cast<std::size_t>(
        std::max(kDefaultSampleRate, diagnostics_.sampleRateObtained) * kRingBufferSeconds);
    ringBuffer_ = std::make_unique<float[]>(ringCapacity_);
    ringReadIndex_.store(0, std::memory_order_relaxed);
    ringWriteIndex_.store(0, std::memory_order_relaxed);

    {
        std::lock_guard<std::mutex> resultLock(resultsMutex_);
        detectionQueue_.clear();
    }

    workerScratch_.assign(static_cast<std::size_t>(lastStartConfig_.bufferFrames), 0.0f);
    resetRuntimeMeters();

    startWorkerLocked();
    callbackRunning_.store(true, std::memory_order_release);

    const PaError startResult = Pa_StartStream(stream_);
    if (startResult != paNoError) {
        error = "Failed to start input stream: " + sanitizePortAudioError(startResult);
        diagnostics_.fallbackReason = error;
        stopCaptureLocked();
        return false;
    }

    running_ = true;
    diagnostics_.streamState = "running";
    return true;
}

void AudioEngine::stopCapture()
{
    std::lock_guard<std::mutex> lock(stateMutex_);
    stopCaptureLocked();
}

void AudioEngine::stopCaptureLocked()
{
    callbackRunning_.store(false, std::memory_order_release);
    running_ = false;
    diagnosticsOnlyMode_.store(false, std::memory_order_release);

    stopWorkerLocked();

    if (stream_ != nullptr) {
        if (Pa_IsStreamActive(stream_) == 1) {
            Pa_StopStream(stream_);
        }
    }
    closeInputStreamLocked();

    destroyRustRuntimeLocked();

    ringBuffer_.reset();
    ringCapacity_ = 0;
    ringReadIndex_.store(0, std::memory_order_relaxed);
    ringWriteIndex_.store(0, std::memory_order_relaxed);

    diagnostics_.streamState = "stopped";
    diagnostics_.framesPerCallback = framesPerCallbackActual_.load(std::memory_order_relaxed);
    diagnostics_.callbackCount = callbackCount_.load(std::memory_order_relaxed);
    diagnostics_.droppedBlocks = droppedBlocks_.load(std::memory_order_relaxed);
    diagnostics_.rms = rms_.load(std::memory_order_relaxed);
    diagnostics_.peak = peak_.load(std::memory_order_relaxed);
    diagnostics_.noiseFloor = noiseFloor_.load(std::memory_order_relaxed);
    diagnostics_.averageAbs = avgAbs_.load(std::memory_order_relaxed);
}

void AudioEngine::shutdown()
{
    std::lock_guard<std::mutex> lock(stateMutex_);
    stopCaptureLocked();
    if (portAudioInitialized_) {
        Pa_Terminate();
        portAudioInitialized_ = false;
    }
}

bool AudioEngine::ensurePortAudioInitialized(std::string& error)
{
    if (portAudioInitialized_) {
        return true;
    }
    const PaError result = Pa_Initialize();
    if (result != paNoError) {
        error = "Pa_Initialize failed: " + sanitizePortAudioError(result);
        return false;
    }
    portAudioInitialized_ = true;
    return true;
}

bool AudioEngine::createRustRuntimeLocked(const StartCaptureConfig& config, std::string& error)
{
    std::ostringstream runtimeCfg;
    runtimeCfg << "{";
    runtimeCfg << "\"backend_name\":" << quoteJson(config.detector);
    runtimeCfg << ",\"sample_rate\":" << std::max(8000, diagnostics_.sampleRateObtained);
    runtimeCfg << ",\"block_size\":" << std::max(kMinBufferFrames, config.bufferFrames);
    runtimeCfg << ",\"audio_input_mode\":" << quoteJson(config.audioInputMode.empty() ? "speaker" : config.audioInputMode);
    runtimeCfg << ",\"spectral_model_json\":"
               << (config.spectralModelJson.empty() ? "null" : quoteJson(config.spectralModelJson));
    runtimeCfg << ",\"masp_assets_dir\":"
               << (config.maspAssetsDir.empty() ? "null" : quoteJson(config.maspAssetsDir));
    runtimeCfg << ",\"fretnet_model_path\":"
               << (config.fretnetModelPath.empty() ? "null" : quoteJson(config.fretnetModelPath));
    runtimeCfg << "}";

    char* runtimeError = nullptr;
    {
        std::lock_guard<std::mutex> runtimeLock(rustRuntimeMutex_);
        rustRuntime_ = gh_native_pitch_runtime_new(runtimeCfg.str().c_str(), &runtimeError);
    }
    if (rustRuntime_ != nullptr) {
        return true;
    }

    error = runtimeError != nullptr
        ? std::string(runtimeError)
        : "Failed to initialize native Rust detector runtime.";
    if (runtimeError != nullptr) {
        gh_native_pitch_runtime_free_string(runtimeError);
    }
    return false;
}

void AudioEngine::destroyRustRuntimeLocked()
{
    if (rustRuntime_ == nullptr) {
        return;
    }
    std::lock_guard<std::mutex> runtimeLock(rustRuntimeMutex_);
    if (rustRuntime_ != nullptr) {
        gh_native_pitch_runtime_destroy(rustRuntime_);
        rustRuntime_ = nullptr;
    }
}

bool AudioEngine::openInputStreamLocked(const StartCaptureConfig& config, std::string& error, bool diagnosticsOnly)
{
    diagnosticsOnlyMode_.store(diagnosticsOnly, std::memory_order_release);

    PaDeviceIndex deviceIndex = paNoDevice;
    std::string deviceSelectionFallback;
#ifdef _WIN32
    const PaHostApiIndex wasapiHostApiIndex = Pa_HostApiTypeIdToHostApiIndex(paWASAPI);
    if (wasapiHostApiIndex >= 0) {
        const PaHostApiInfo* wasapiHostApiInfo = Pa_GetHostApiInfo(wasapiHostApiIndex);
        if (wasapiHostApiInfo != nullptr && wasapiHostApiInfo->defaultInputDevice != paNoDevice) {
            deviceIndex = wasapiHostApiInfo->defaultInputDevice;
        } else {
            deviceSelectionFallback = "WASAPI default input device unavailable. Using PortAudio default input device.";
        }
    } else {
        deviceSelectionFallback = "WASAPI host API unavailable in PortAudio. Using PortAudio default input device.";
    }
#endif
    if (deviceIndex == paNoDevice) {
        deviceIndex = Pa_GetDefaultInputDevice();
    }
    if (deviceIndex == paNoDevice) {
        error = "No default input audio device available.";
        return false;
    }

    const PaDeviceInfo* deviceInfo = Pa_GetDeviceInfo(deviceIndex);
    if (deviceInfo == nullptr) {
        error = "Failed to inspect selected input audio device.";
        return false;
    }

    PaStreamParameters inputParams{};
    inputParams.device = deviceIndex;
    inputParams.channelCount = 1;
    inputParams.sampleFormat = paFloat32;
    inputParams.suggestedLatency = deviceInfo->defaultLowInputLatency;
    inputParams.hostApiSpecificStreamInfo = nullptr;

    const auto requestedSampleRate = static_cast<double>(sanitizeSampleRate(config.sampleRateHint));
    const auto requestedFrames = static_cast<unsigned long>(sanitizeBufferFrames(config.bufferFrames));

    diagnostics_.deviceId = static_cast<int>(deviceIndex);
    diagnostics_.deviceName = deviceInfo->name != nullptr ? deviceInfo->name : "unknown";
    diagnostics_.sampleRateRequested = static_cast<int>(requestedSampleRate);
    diagnostics_.bufferFramesRequested = static_cast<int>(requestedFrames);
    diagnostics_.fallbackReason.clear();
    if (!deviceSelectionFallback.empty()) {
        diagnostics_.fallbackReason = deviceSelectionFallback;
        std::cerr << "[NativePitch] " << diagnostics_.fallbackReason << std::endl;
    }

    PaError openResult = paUnanticipatedHostError;
    bool opened = false;

    const PaHostApiInfo* hostApi = Pa_GetHostApiInfo(deviceInfo->hostApi);
    const auto hostType = hostApi != nullptr ? hostApi->type : paInDevelopment;
#ifdef _WIN32
    if (hostType != paWASAPI && diagnostics_.fallbackReason.empty()) {
        diagnostics_.fallbackReason =
            "Selected input host API is not WASAPI (" +
            std::string(hostApi != nullptr && hostApi->name != nullptr ? hostApi->name : "unknown") +
            ").";
        std::cerr << "[NativePitch] " << diagnostics_.fallbackReason << std::endl;
    }
#endif

#ifdef _WIN32
    if (hostType == paWASAPI) {
        PaWasapiStreamInfo wasapiInfo{};
        wasapiInfo.size = sizeof(PaWasapiStreamInfo);
        wasapiInfo.hostApiType = paWASAPI;
        wasapiInfo.version = 1;
        wasapiInfo.flags = paWinWasapiExclusive;
        inputParams.hostApiSpecificStreamInfo = &wasapiInfo;

        openResult = Pa_OpenStream(
            &stream_,
            &inputParams,
            nullptr,
            requestedSampleRate,
            requestedFrames,
            paNoFlag,
            &AudioEngine::portAudioCallback,
            this);

        if (openResult == paNoError) {
            opened = true;
            diagnostics_.backendEffective = "WASAPI Exclusive";
            diagnostics_.preprocessingActive = false;
        } else {
            diagnostics_.fallbackReason =
                "WASAPI Exclusive failed: " + sanitizePortAudioError(openResult) + ". Falling back to Shared.";
            std::cerr << "[NativePitch] " << diagnostics_.fallbackReason << std::endl;

            wasapiInfo.flags = 0;
            inputParams.hostApiSpecificStreamInfo = &wasapiInfo;
            openResult = Pa_OpenStream(
                &stream_,
                &inputParams,
                nullptr,
                requestedSampleRate,
                requestedFrames,
                paNoFlag,
                &AudioEngine::portAudioCallback,
                this);
            if (openResult == paNoError) {
                opened = true;
                diagnostics_.backendEffective = "WASAPI Shared";
                diagnostics_.preprocessingActive = true;
            }
        }
    }
#endif

    if (!opened) {
        inputParams.hostApiSpecificStreamInfo = nullptr;
        openResult = Pa_OpenStream(
            &stream_,
            &inputParams,
            nullptr,
            requestedSampleRate,
            requestedFrames,
            paNoFlag,
            &AudioEngine::portAudioCallback,
            this);

        if (openResult == paNoError) {
            opened = true;
            if (hostType == paASIO) {
                diagnostics_.backendEffective = "ASIO";
                diagnostics_.preprocessingActive = false;
            } else {
                diagnostics_.backendEffective =
                    hostApi != nullptr && hostApi->name != nullptr ? hostApi->name : "PortAudio";
                diagnostics_.preprocessingActive = true;
            }
        }
    }

    if (!opened) {
        error = "Failed to open input stream: " + sanitizePortAudioError(openResult);
        return false;
    }

    Pa_SetStreamFinishedCallback(stream_, &AudioEngine::streamFinishedCallback);

    const PaStreamInfo* streamInfo = Pa_GetStreamInfo(stream_);
    diagnostics_.sampleRateObtained = streamInfo != nullptr
        ? static_cast<int>(std::round(streamInfo->sampleRate))
        : static_cast<int>(requestedSampleRate);
    runtimeSampleRate_.store(diagnostics_.sampleRateObtained, std::memory_order_relaxed);
    diagnostics_.latencyMs = streamInfo != nullptr ? streamInfo->inputLatency * 1000.0 : 0.0;
    diagnostics_.framesPerCallback = static_cast<int>(requestedFrames);
    diagnostics_.streamState = diagnosticsOnly ? "sanity_capture" : "opened";

    return true;
}

void AudioEngine::closeInputStreamLocked()
{
    if (stream_ == nullptr) {
        return;
    }
    Pa_CloseStream(stream_);
    stream_ = nullptr;
}

void AudioEngine::startWorkerLocked()
{
    workerRunning_.store(true, std::memory_order_release);
    workerThread_ = std::thread([this]() { workerLoop(); });
}

void AudioEngine::stopWorkerLocked()
{
    workerRunning_.store(false, std::memory_order_release);
    if (workerThread_.joinable()) {
        workerThread_.join();
    }
}

void AudioEngine::resetRuntimeMeters()
{
    framesPerCallbackActual_.store(0, std::memory_order_relaxed);
    callbackCount_.store(0, std::memory_order_relaxed);
    droppedBlocks_.store(0, std::memory_order_relaxed);
    totalCapturedSamples_.store(0, std::memory_order_relaxed);
    processedSamples_.store(0, std::memory_order_relaxed);
    peak_.store(0.0, std::memory_order_relaxed);
    rms_.store(0.0, std::memory_order_relaxed);
    avgAbs_.store(0.0, std::memory_order_relaxed);
    noiseFloor_.store(1.0, std::memory_order_relaxed);
    streamEndedUnexpectedly_.store(false, std::memory_order_relaxed);
}

bool AudioEngine::updateGameplayContext(const std::string& contextJson, std::string& error)
{
    std::lock_guard<std::mutex> lock(stateMutex_);
    if (rustRuntime_ == nullptr) {
        error = "Native detector runtime is not running.";
        return false;
    }

    char* runtimeError = nullptr;
    {
        std::lock_guard<std::mutex> runtimeLock(rustRuntimeMutex_);
        if (rustRuntime_ == nullptr) {
            error = "Native detector runtime is not running.";
            return false;
        }
        runtimeError = gh_native_pitch_runtime_update_gameplay_context(rustRuntime_, contextJson.c_str());
    }
    if (runtimeError == nullptr) {
        return true;
    }

    error = runtimeError;
    gh_native_pitch_runtime_free_string(runtimeError);
    return false;
}

bool AudioEngine::resetDetector(std::string& error)
{
    std::lock_guard<std::mutex> lock(stateMutex_);
    if (rustRuntime_ == nullptr) {
        return true;
    }
    {
        std::lock_guard<std::mutex> runtimeLock(rustRuntimeMutex_);
        if (rustRuntime_ == nullptr) {
            return true;
        }
        gh_native_pitch_runtime_reset(rustRuntime_);
    }
    return true;
}

std::vector<DetectionResult> AudioEngine::pollDetections(std::size_t maxResults)
{
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        maybeRecoverStreamLocked();
    }

    const auto toTake = std::max<std::size_t>(1, maxResults);
    std::vector<DetectionResult> out;
    out.reserve(toTake);

    std::lock_guard<std::mutex> lock(resultsMutex_);
    while (!detectionQueue_.empty() && out.size() < toTake) {
        out.push_back(std::move(detectionQueue_.front()));
        detectionQueue_.pop_front();
    }
    return out;
}

void AudioEngine::maybeRecoverStreamLocked()
{
    if (!running_ || stream_ == nullptr) {
        return;
    }

    const bool streamFinished = streamEndedUnexpectedly_.load(std::memory_order_acquire);
    const PaError activeState = Pa_IsStreamActive(stream_);
    if (!streamFinished && activeState == 1) {
        return;
    }

    const std::string reason = streamFinished
        ? "Input device disconnected; attempting stream restart."
        : "Input stream became inactive; attempting stream restart.";
    StartCaptureConfig restartConfig = lastStartConfig_;

    std::string restartError;
    stopCaptureLocked();
    if (!startCaptureLocked(restartConfig, restartError)) {
        diagnostics_.fallbackReason = reason + " Restart failed: " + restartError;
        diagnostics_.streamState = "error";
        return;
    }
    diagnostics_.fallbackReason = reason + " Restart succeeded.";
}

DiagnosticsSnapshot AudioEngine::getDiagnostics()
{
    std::lock_guard<std::mutex> lock(stateMutex_);
    diagnostics_.framesPerCallback = std::max(
        diagnostics_.framesPerCallback,
        framesPerCallbackActual_.load(std::memory_order_relaxed));
    diagnostics_.callbackCount = callbackCount_.load(std::memory_order_relaxed);
    diagnostics_.droppedBlocks = droppedBlocks_.load(std::memory_order_relaxed);
    diagnostics_.rms = rms_.load(std::memory_order_relaxed);
    diagnostics_.peak = peak_.load(std::memory_order_relaxed);
    diagnostics_.averageAbs = avgAbs_.load(std::memory_order_relaxed);
    diagnostics_.noiseFloor = noiseFloor_.load(std::memory_order_relaxed);
    if (!running_) {
        diagnostics_.streamState = "stopped";
    }
    return diagnostics_;
}

bool AudioEngine::runSanityTest(double captureSeconds, SanitySnapshot& out, std::string& error)
{
    const double seconds = std::clamp(captureSeconds, 0.5, 5.0);

    bool startedTemporarily = false;

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (!running_) {
            std::string initError;
            if (!ensurePortAudioInitialized(initError)) {
                error = initError;
                return false;
            }
            StartCaptureConfig sanityConfig = lastStartConfig_;
            sanityConfig.sampleRateHint = sanityConfig.sampleRateHint <= 0 ? kDefaultSampleRate : sanityConfig.sampleRateHint;
            sanityConfig.bufferFrames = sanityConfig.bufferFrames <= 0 ? 512 : sanityConfig.bufferFrames;

            if (!openInputStreamLocked(sanityConfig, error, true)) {
                return false;
            }

            resetRuntimeMeters();
            callbackRunning_.store(true, std::memory_order_release);
            const PaError startResult = Pa_StartStream(stream_);
            if (startResult != paNoError) {
                error = "Failed to start sanity capture: " + sanitizePortAudioError(startResult);
                callbackRunning_.store(false, std::memory_order_release);
                closeInputStreamLocked();
                return false;
            }
            startedTemporarily = true;
        } else {
            resetRuntimeMeters();
        }
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(static_cast<int>(seconds * 1000.0)));

    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        if (startedTemporarily) {
            callbackRunning_.store(false, std::memory_order_release);
            if (stream_ != nullptr && Pa_IsStreamActive(stream_) == 1) {
                Pa_StopStream(stream_);
            }
            closeInputStreamLocked();
            diagnosticsOnlyMode_.store(false, std::memory_order_release);
        }
        out = collectSanitySnapshot(seconds);
        diagnostics_.rms = out.rms;
        diagnostics_.peak = out.peak;
        diagnostics_.noiseFloor = out.noiseFloor;
        diagnostics_.averageAbs = out.averageAbs;
        diagnostics_.callbackCount = out.callbackCount;
    }

    return true;
}

SanitySnapshot AudioEngine::collectSanitySnapshot(double captureSeconds) const
{
    SanitySnapshot out;
    out.captureSeconds = captureSeconds;
    out.rms = rms_.load(std::memory_order_relaxed);
    out.peak = peak_.load(std::memory_order_relaxed);
    out.noiseFloor = noiseFloor_.load(std::memory_order_relaxed);
    out.averageAbs = avgAbs_.load(std::memory_order_relaxed);
    out.callbackCount = callbackCount_.load(std::memory_order_relaxed);
    return out;
}

bool AudioEngine::isRunning() const
{
    std::lock_guard<std::mutex> lock(stateMutex_);
    return running_;
}

int AudioEngine::portAudioCallback(
    const void* input,
    void* /*output*/,
    unsigned long frameCount,
    const PaStreamCallbackTimeInfo* timeInfo,
    PaStreamCallbackFlags statusFlags,
    void* userData)
{
    auto* engine = static_cast<AudioEngine*>(userData);
    if (engine == nullptr) {
        return paAbort;
    }
    return engine->handlePortAudioCallback(input, frameCount, timeInfo, statusFlags);
}

void AudioEngine::streamFinishedCallback(void* userData)
{
    auto* engine = static_cast<AudioEngine*>(userData);
    if (engine == nullptr) {
        return;
    }
    engine->streamEndedUnexpectedly_.store(true, std::memory_order_release);
}

int AudioEngine::handlePortAudioCallback(
    const void* input,
    unsigned long frameCount,
    const PaStreamCallbackTimeInfo* /*timeInfo*/,
    PaStreamCallbackFlags statusFlags)
{
    if (!callbackRunning_.load(std::memory_order_acquire)) {
        return paComplete;
    }

    framesPerCallbackActual_.store(static_cast<int>(frameCount), std::memory_order_relaxed);
    callbackCount_.fetch_add(1, std::memory_order_relaxed);
    totalCapturedSamples_.fetch_add(frameCount, std::memory_order_relaxed);

    if ((statusFlags & paInputOverflow) != 0) {
        droppedBlocks_.fetch_add(1, std::memory_order_relaxed);
    }

    const float* samples = static_cast<const float*>(input);
    if (samples == nullptr) {
        return paContinue;
    }

    if (!diagnosticsOnlyMode_.load(std::memory_order_acquire) && ringBuffer_ != nullptr && ringCapacity_ > 0) {
        const auto sampleCount = static_cast<std::size_t>(frameCount);
        uint64_t write = ringWriteIndex_.load(std::memory_order_relaxed);
        const uint64_t read = ringReadIndex_.load(std::memory_order_acquire);
        const std::size_t available = ringCapacity_ - static_cast<std::size_t>(write - read);

        if (sampleCount > available) {
            droppedBlocks_.fetch_add(1, std::memory_order_relaxed);
        } else {
            for (std::size_t index = 0; index < sampleCount; ++index) {
                ringBuffer_[(write + index) % ringCapacity_] = samples[index];
            }
            ringWriteIndex_.store(write + sampleCount, std::memory_order_release);
        }
    }

    double sumSquares = 0.0;
    double sumAbs = 0.0;
    double peakSample = 0.0;
    for (unsigned long index = 0; index < frameCount; ++index) {
        const double value = static_cast<double>(samples[index]);
        sumSquares += value * value;
        const double absValue = std::abs(value);
        sumAbs += absValue;
        peakSample = std::max(peakSample, absValue);
    }

    const double rms = frameCount > 0 ? std::sqrt(sumSquares / static_cast<double>(frameCount)) : 0.0;
    peak_.store(std::max(peak_.load(std::memory_order_relaxed), peakSample), std::memory_order_relaxed);
    rms_.store(rms, std::memory_order_relaxed);
    avgAbs_.store(frameCount > 0 ? sumAbs / static_cast<double>(frameCount) : 0.0, std::memory_order_relaxed);
    if (rms > 0.0) {
        noiseFloor_.store(
            std::min(noiseFloor_.load(std::memory_order_relaxed), rms),
            std::memory_order_relaxed);
    }

    return paContinue;
}

void AudioEngine::workerLoop()
{
    while (workerRunning_.load(std::memory_order_acquire)) {
        if (ringBuffer_ == nullptr || ringCapacity_ == 0 || rustRuntime_ == nullptr) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }

        const std::size_t blockSize = workerScratch_.size();
        if (blockSize == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }

        const uint64_t write = ringWriteIndex_.load(std::memory_order_acquire);
        const uint64_t read = ringReadIndex_.load(std::memory_order_relaxed);
        const std::size_t available = static_cast<std::size_t>(write - read);
        if (available < blockSize) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            continue;
        }

        for (std::size_t index = 0; index < blockSize; ++index) {
            workerScratch_[index] = ringBuffer_[(read + index) % ringCapacity_];
        }
        ringReadIndex_.store(read + blockSize, std::memory_order_release);

        const uint64_t processed = processedSamples_.fetch_add(blockSize, std::memory_order_relaxed) + blockSize;
        const int sampleRate = std::max(1, runtimeSampleRate_.load(std::memory_order_relaxed));
        const double captureTimeSec = static_cast<double>(processed) / static_cast<double>(sampleRate);

        char* resultJson = nullptr;
        const auto startedAt = std::chrono::steady_clock::now();
        char* runtimeError = nullptr;
        {
            std::lock_guard<std::mutex> runtimeLock(rustRuntimeMutex_);
            if (rustRuntime_ == nullptr) {
                continue;
            }
            runtimeError = gh_native_pitch_runtime_process_audio_block(
                rustRuntime_,
                workerScratch_.data(),
                workerScratch_.size(),
                captureTimeSec,
                &resultJson);
        }

        const double processingMs = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - startedAt)
                                        .count();

        if (runtimeError != nullptr) {
            gh_native_pitch_runtime_free_string(runtimeError);
            continue;
        }

        if (resultJson == nullptr) {
            continue;
        }

        DetectionResult item;
        item.detectorJson = resultJson;
        item.processingTimeMs = processingMs;

        const uint64_t captured = totalCapturedSamples_.load(std::memory_order_relaxed);
        const uint64_t latencySamples = captured > processed ? (captured - processed) : 0;
        item.callbackToResultLatencyMs =
            (static_cast<double>(latencySamples) / static_cast<double>(sampleRate)) * 1000.0;
        item.droppedBlocks = droppedBlocks_.load(std::memory_order_relaxed);
        item.overrun = item.droppedBlocks > 0;

        {
            std::lock_guard<std::mutex> lock(resultsMutex_);
            item.detectorQueueDepth = detectionQueue_.size();
            detectionQueue_.push_back(std::move(item));
            while (detectionQueue_.size() > kMaxQueueDepth) {
                detectionQueue_.pop_front();
            }
        }

        gh_native_pitch_runtime_free_string(resultJson);
    }
}

} // namespace gh::native_pitch

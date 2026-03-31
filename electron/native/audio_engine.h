#pragma once

#include <atomic>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <portaudio.h>

#include "rust_detector_bridge.h"

namespace gh::native_pitch {

struct StartCaptureConfig {
    std::string detector{"ac14"};
    int sampleRateHint{48000};
    int bufferFrames{256};
    std::string audioInputMode{"speaker"};
    std::string spectralModelJson;
    std::string maspAssetsDir;
    std::string fretnetModelPath;
};

struct DiagnosticsSnapshot {
    std::string backendRequested{"WASAPI Exclusive"};
    std::string backendEffective{"unknown"};
    int sampleRateRequested{0};
    int sampleRateObtained{0};
    int bufferFramesRequested{0};
    int framesPerCallback{0};
    int deviceId{-1};
    std::string deviceName;
    double latencyMs{0.0};
    bool preprocessingActive{true};
    std::string streamState{"stopped"};
    std::string fallbackReason;
    double rms{0.0};
    double peak{0.0};
    double noiseFloor{0.0};
    double averageAbs{0.0};
    uint64_t callbackCount{0};
    uint64_t droppedBlocks{0};
};

struct SanitySnapshot {
    double captureSeconds{0.0};
    double rms{0.0};
    double peak{0.0};
    double noiseFloor{0.0};
    double averageAbs{0.0};
    uint64_t callbackCount{0};
};

struct DetectionResult {
    std::string detectorJson;
    double callbackToResultLatencyMs{0.0};
    double processingTimeMs{0.0};
    uint64_t detectorQueueDepth{0};
    uint64_t droppedBlocks{0};
    bool overrun{false};
};

class AudioEngine {
public:
    static AudioEngine& instance();

    bool startCapture(const StartCaptureConfig& config, std::string& error);
    void stopCapture();
    void shutdown();

    bool updateGameplayContext(const std::string& contextJson, std::string& error);
    bool resetDetector(std::string& error);

    std::vector<DetectionResult> pollDetections(std::size_t maxResults);

    DiagnosticsSnapshot getDiagnostics();
    bool runSanityTest(double captureSeconds, SanitySnapshot& out, std::string& error);

    bool isRunning() const;

private:
    AudioEngine();
    ~AudioEngine();

    AudioEngine(const AudioEngine&) = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;

    bool ensurePortAudioInitialized(std::string& error);

    bool startCaptureLocked(const StartCaptureConfig& config, std::string& error);
    void stopCaptureLocked();

    bool createRustRuntimeLocked(const StartCaptureConfig& config, std::string& error);
    void destroyRustRuntimeLocked();

    bool openInputStreamLocked(const StartCaptureConfig& config, std::string& error, bool diagnosticsOnly);
    void closeInputStreamLocked();

    void maybeRecoverStreamLocked();

    void startWorkerLocked();
    void stopWorkerLocked();
    void workerLoop();

    void resetRuntimeMeters();
    SanitySnapshot collectSanitySnapshot(double captureSeconds) const;

    static int portAudioCallback(
        const void* input,
        void* output,
        unsigned long frameCount,
        const PaStreamCallbackTimeInfo* timeInfo,
        PaStreamCallbackFlags statusFlags,
        void* userData);

    static void streamFinishedCallback(void* userData);

    int handlePortAudioCallback(
        const void* input,
        unsigned long frameCount,
        const PaStreamCallbackTimeInfo* timeInfo,
        PaStreamCallbackFlags statusFlags);

private:
    mutable std::mutex stateMutex_;
    std::mutex resultsMutex_;
    std::mutex rustRuntimeMutex_;

    bool portAudioInitialized_{false};
    bool running_{false};

    StartCaptureConfig lastStartConfig_;
    DiagnosticsSnapshot diagnostics_;

    PaStream* stream_{nullptr};
    NativePitchRuntimeHandle* rustRuntime_{nullptr};

    std::unique_ptr<float[]> ringBuffer_;
    std::size_t ringCapacity_{0};
    std::atomic<uint64_t> ringReadIndex_{0};
    std::atomic<uint64_t> ringWriteIndex_{0};

    std::thread workerThread_;
    std::atomic<bool> workerRunning_{false};
    std::vector<float> workerScratch_;

    std::deque<DetectionResult> detectionQueue_;

    std::atomic<bool> callbackRunning_{false};
    std::atomic<bool> diagnosticsOnlyMode_{false};
    std::atomic<int> runtimeSampleRate_{48000};
    std::atomic<int> framesPerCallbackActual_{0};
    std::atomic<uint64_t> callbackCount_{0};
    std::atomic<uint64_t> droppedBlocks_{0};
    std::atomic<uint64_t> totalCapturedSamples_{0};
    std::atomic<uint64_t> processedSamples_{0};

    std::atomic<double> peak_{0.0};
    std::atomic<double> rms_{0.0};
    std::atomic<double> avgAbs_{0.0};
    std::atomic<double> noiseFloor_{1.0};

    std::atomic<bool> streamEndedUnexpectedly_{false};
};

} // namespace gh::native_pitch

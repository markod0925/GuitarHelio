#ifndef TEMPOCNN_CORE_TEMPO_CNN_H
#define TEMPOCNN_CORE_TEMPO_CNN_H

#include <string>
#include <vector>

#include <onnxruntime_cxx_api.h>

struct TempoPoint {
    double timeSeconds = 0.0;
    double bpm = 0.0;
};

struct TempoEstimateOptions {
    bool interpolate = false;
    bool localTempo = false;
};

struct TempoEstimateResult {
    double bpm = 120.0;
    std::vector<TempoPoint> tempoMap;
};

class TempoCnn {
public:
    explicit TempoCnn(const std::string& modelPath);

    TempoEstimateResult estimate(const std::vector<float>& monoSamples, const TempoEstimateOptions& options);

private:
    std::vector<float> runModel(const std::vector<float>& inputData, int numWindows);

    Ort::SessionOptions mSessionOptions;
    Ort::Env mEnv;
    Ort::Session mSession;
    Ort::MemoryInfo mMemoryInfo;
    std::string mInputName;
    std::string mOutputName;
};

#endif

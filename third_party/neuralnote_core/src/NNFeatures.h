#ifndef NNFeatures_h
#define NNFeatures_h

#include <array>
#include <string>
#include <vector>

#include <onnxruntime_cxx_api.h>

#include "BasicPitchConstants.h"

class Features
{
public:
    explicit Features(const std::string& modelPath);

    ~Features() = default;

    const float* computeFeatures(float* inAudio, size_t inNumSamples, size_t& outNumFrames);

private:
    std::vector<Ort::Value> mInput;
    std::vector<Ort::Value> mOutput;

    std::array<int64_t, 3> mInputShape {};

    const char* mInputNames[1] = {"input_1"};
    const char* mOutputNames[1] = {"harmonic_stacking"};

    Ort::MemoryInfo mMemoryInfo;
    Ort::SessionOptions mSessionOptions;
    Ort::Env mEnv;
    Ort::Session mSession;
    Ort::RunOptions mRunOptions;
};

#endif // NNFeatures_h

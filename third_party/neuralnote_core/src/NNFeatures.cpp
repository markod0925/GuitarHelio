#include "NNFeatures.h"

#include <sstream>
#include <stdexcept>

#include "Utils.h"

Features::Features(const std::string& modelPath)
    : mMemoryInfo(nullptr)
    , mEnv(ORT_LOGGING_LEVEL_WARNING, "neuralnote-core")
    , mSession(nullptr)
{
    mMemoryInfo = Ort::MemoryInfo::CreateCpu(OrtDeviceAllocator, OrtMemTypeCPU);

    mSessionOptions.SetInterOpNumThreads(1);
    mSessionOptions.SetIntraOpNumThreads(1);

#if defined(_WIN32)
    const std::wstring wideModelPath(modelPath.begin(), modelPath.end());
    mSession = Ort::Session(mEnv, wideModelPath.c_str(), mSessionOptions);
#else
    mSession = Ort::Session(mEnv, modelPath.c_str(), mSessionOptions);
#endif
}

const float* Features::computeFeatures(float* inAudio, size_t inNumSamples, size_t& outNumFrames)
{
    {
        std::ostringstream detail;
        detail << "samples=" << inNumSamples;
        NeuralNoteDiag::emit("features", "compute_start", detail.str(), 0.48);
    }

    mInputShape[0] = 1;
    mInputShape[1] = static_cast<int64_t>(inNumSamples);
    mInputShape[2] = 1;

    mInput.clear();
    mInput.push_back(Ort::Value::CreateTensor<float>(mMemoryInfo, inAudio, inNumSamples, mInputShape.data(), mInputShape.size()));

    NeuralNoteDiag::emit("features", "session_run_start", "", 0.5);
    mOutput = mSession.Run(mRunOptions, mInputNames, mInput.data(), 1, mOutputNames, 1);
    NeuralNoteDiag::emit("features", "session_run_done", "", 0.62);

    auto outShape = mOutput[0].GetTensorTypeAndShapeInfo().GetShape();
    if (!(outShape.size() == 4 && outShape[0] == 1 && outShape[2] == NUM_FREQ_IN && outShape[3] == NUM_HARMONICS)) {
        throw std::runtime_error("Unexpected ONNX features output shape");
    }

    outNumFrames = static_cast<size_t>(outShape[1]);
    NeuralNoteDiag::emit("features",
                         "shape_validated",
                         "frames=" + std::to_string(outNumFrames),
                         0.64);
    mInput.clear();

    return mOutput[0].GetTensorData<float>();
}

#include "TempoCnn.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <numeric>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr int kSampleRate = 11025;
constexpr int kNfft = 1024;
constexpr int kStftHopLength = 512;
constexpr int kMelBands = 40;
constexpr double kMelMinHz = 20.0;
constexpr double kMelMaxHz = 5000.0;
constexpr int kTempoClasses = 256;

constexpr int kWindowFrames = 256;
constexpr int kGlobalHopFrames = 128;
constexpr int kLocalHopFrames = 32;
constexpr int kLocalSmoothingWindow = 5;

constexpr double kTempoMinBpm = 20.0;
constexpr double kTempoMaxBpm = 300.0;
constexpr double kLocalTempoMinTimeDelta = 0.7;
constexpr double kLocalTempoMinBpmDelta = 0.75;
constexpr double kFeatureFrameSeconds = 512.0 / 11025.0;

constexpr double kPi = 3.14159265358979323846;

struct FeatureTensor {
    std::vector<float> data;
    int totalFrames = 0;
};

struct SlidingWindowTensor {
    std::vector<float> data;
    int numWindows = 0;
};

double clampDouble(double value, double minValue, double maxValue)
{
    return std::max(minValue, std::min(maxValue, value));
}

double roundToDecimals(double value, int decimals)
{
    const int safeDecimals = std::max(0, std::min(9, decimals));
    const double scale = std::pow(10.0, static_cast<double>(safeDecimals));
    return std::round(value * scale) / scale;
}

double hzToMelSlaney(double hz)
{
    constexpr double fSp = 200.0 / 3.0;
    constexpr double minLogHz = 1000.0;
    constexpr double minLogMel = minLogHz / fSp;
    const double logStep = std::log(6.4) / 27.0;

    if (hz < minLogHz) {
        return hz / fSp;
    }
    return minLogMel + (std::log(hz / minLogHz) / logStep);
}

double melToHzSlaney(double mel)
{
    constexpr double fSp = 200.0 / 3.0;
    constexpr double minLogHz = 1000.0;
    constexpr double minLogMel = minLogHz / fSp;
    const double logStep = std::log(6.4) / 27.0;

    if (mel < minLogMel) {
        return mel * fSp;
    }
    return minLogHz * std::exp(logStep * (mel - minLogMel));
}

std::vector<double> makeMelFrequencies(int count, double minHz, double maxHz)
{
    std::vector<double> frequencies;
    frequencies.resize(static_cast<size_t>(count));

    const double melMin = hzToMelSlaney(minHz);
    const double melMax = hzToMelSlaney(maxHz);

    for (int i = 0; i < count; ++i) {
        const double ratio = (count <= 1) ? 0.0 : static_cast<double>(i) / static_cast<double>(count - 1);
        const double melValue = melMin + (melMax - melMin) * ratio;
        frequencies[static_cast<size_t>(i)] = melToHzSlaney(melValue);
    }

    return frequencies;
}

std::vector<double> makeMelFilterBank()
{
    const int fftBins = kNfft / 2 + 1;
    const auto melFrequencies = makeMelFrequencies(kMelBands + 2, kMelMinHz, kMelMaxHz);

    std::vector<double> fftFrequencies;
    fftFrequencies.resize(static_cast<size_t>(fftBins));
    for (int i = 0; i < fftBins; ++i) {
        fftFrequencies[static_cast<size_t>(i)] = (static_cast<double>(i) * static_cast<double>(kSampleRate)) / static_cast<double>(kNfft);
    }

    std::vector<double> fdiff;
    fdiff.resize(static_cast<size_t>(kMelBands + 1));
    for (int i = 0; i < kMelBands + 1; ++i) {
        fdiff[static_cast<size_t>(i)] = melFrequencies[static_cast<size_t>(i + 1)] - melFrequencies[static_cast<size_t>(i)];
    }

    std::vector<double> weights;
    weights.assign(static_cast<size_t>(kMelBands * fftBins), 0.0);

    for (int mel = 0; mel < kMelBands; ++mel) {
        for (int bin = 0; bin < fftBins; ++bin) {
            const double lower =
                (fftFrequencies[static_cast<size_t>(bin)] - melFrequencies[static_cast<size_t>(mel)]) / fdiff[static_cast<size_t>(mel)];
            const double upper =
                (melFrequencies[static_cast<size_t>(mel + 2)] - fftFrequencies[static_cast<size_t>(bin)]) / fdiff[static_cast<size_t>(mel + 1)];
            const double weight = std::max(0.0, std::min(lower, upper));
            weights[static_cast<size_t>(mel * fftBins + bin)] = weight;
        }

        const double enorm = 2.0 / (melFrequencies[static_cast<size_t>(mel + 2)] - melFrequencies[static_cast<size_t>(mel)]);
        for (int bin = 0; bin < fftBins; ++bin) {
            weights[static_cast<size_t>(mel * fftBins + bin)] *= enorm;
        }
    }

    return weights;
}

std::vector<double> makeHannWindow()
{
    std::vector<double> window;
    window.resize(static_cast<size_t>(kNfft));

    for (int i = 0; i < kNfft; ++i) {
        window[static_cast<size_t>(i)] = 0.5 - 0.5 * std::cos((2.0 * kPi * static_cast<double>(i)) / static_cast<double>(kNfft));
    }

    return window;
}

void fft(std::vector<std::complex<double>>& data)
{
    const size_t n = data.size();
    size_t j = 0;

    for (size_t i = 1; i < n; ++i) {
        size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) {
            j ^= bit;
        }
        j ^= bit;
        if (i < j) {
            std::swap(data[i], data[j]);
        }
    }

    for (size_t len = 2; len <= n; len <<= 1) {
        const double angle = -2.0 * kPi / static_cast<double>(len);
        const std::complex<double> wlen(std::cos(angle), std::sin(angle));

        for (size_t i = 0; i < n; i += len) {
            std::complex<double> w(1.0, 0.0);
            for (size_t k = 0; k < len / 2; ++k) {
                const std::complex<double> u = data[i + k];
                const std::complex<double> v = data[i + k + len / 2] * w;
                data[i + k] = u + v;
                data[i + k + len / 2] = u - v;
                w *= wlen;
            }
        }
    }
}

FeatureTensor computeMelSpectrogram(const std::vector<float>& monoSamples)
{
    FeatureTensor result;
    if (monoSamples.empty()) {
        return result;
    }

    const int padSamples = kNfft / 2;
    std::vector<float> padded;
    padded.assign(monoSamples.size() + static_cast<size_t>(padSamples * 2), 0.0f);
    std::copy(monoSamples.begin(), monoSamples.end(), padded.begin() + padSamples);

    if (padded.size() < static_cast<size_t>(kNfft)) {
        return result;
    }

    const int frameCount = 1 + static_cast<int>((padded.size() - static_cast<size_t>(kNfft)) / static_cast<size_t>(kStftHopLength));
    result.totalFrames = frameCount;
    result.data.assign(static_cast<size_t>(kMelBands * frameCount), 0.0f);

    const auto filterBank = makeMelFilterBank();
    const auto hannWindow = makeHannWindow();

    const int fftBins = kNfft / 2 + 1;
    std::vector<std::complex<double>> fftBuffer;
    fftBuffer.resize(static_cast<size_t>(kNfft));

    std::vector<double> magnitudes;
    magnitudes.resize(static_cast<size_t>(fftBins));

    for (int frameIndex = 0; frameIndex < frameCount; ++frameIndex) {
        const size_t offset = static_cast<size_t>(frameIndex * kStftHopLength);

        for (int i = 0; i < kNfft; ++i) {
            const double sample = static_cast<double>(padded[offset + static_cast<size_t>(i)]);
            fftBuffer[static_cast<size_t>(i)] = std::complex<double>(sample * hannWindow[static_cast<size_t>(i)], 0.0);
        }

        fft(fftBuffer);

        for (int bin = 0; bin < fftBins; ++bin) {
            magnitudes[static_cast<size_t>(bin)] = std::abs(fftBuffer[static_cast<size_t>(bin)]);
        }

        for (int mel = 0; mel < kMelBands; ++mel) {
            double melValue = 0.0;
            for (int bin = 0; bin < fftBins; ++bin) {
                const double weight = filterBank[static_cast<size_t>(mel * fftBins + bin)];
                melValue += weight * magnitudes[static_cast<size_t>(bin)];
            }
            result.data[static_cast<size_t>(mel * frameCount + frameIndex)] = static_cast<float>(melValue);
        }
    }

    return result;
}

SlidingWindowTensor toSlidingWindows(const FeatureTensor& features, int windowFrames, int hopFrames, bool zeroPad)
{
    SlidingWindowTensor output;
    if (features.totalFrames <= 0 || features.data.empty()) {
        return output;
    }

    int workingFrames = features.totalFrames;
    std::vector<float> workingData = features.data;

    if (zeroPad) {
        const int totalZeros = windowFrames;
        const int zerosBefore = totalZeros / 2;
        const int paddedFrames = workingFrames + totalZeros;

        std::vector<float> padded;
        padded.assign(static_cast<size_t>(kMelBands * paddedFrames), 0.0f);

        for (int mel = 0; mel < kMelBands; ++mel) {
            const size_t srcOffset = static_cast<size_t>(mel * workingFrames);
            const size_t dstOffset = static_cast<size_t>(mel * paddedFrames + zerosBefore);
            std::copy(
                workingData.begin() + static_cast<std::ptrdiff_t>(srcOffset),
                workingData.begin() + static_cast<std::ptrdiff_t>(srcOffset + static_cast<size_t>(workingFrames)),
                padded.begin() + static_cast<std::ptrdiff_t>(dstOffset));
        }

        workingData = std::move(padded);
        workingFrames = paddedFrames;
    }

    if (workingFrames < windowFrames) {
        std::vector<float> padded;
        padded.assign(static_cast<size_t>(kMelBands * windowFrames), 0.0f);

        for (int mel = 0; mel < kMelBands; ++mel) {
            const size_t srcOffset = static_cast<size_t>(mel * workingFrames);
            const size_t dstOffset = static_cast<size_t>(mel * windowFrames);
            std::copy(
                workingData.begin() + static_cast<std::ptrdiff_t>(srcOffset),
                workingData.begin() + static_cast<std::ptrdiff_t>(srcOffset + static_cast<size_t>(workingFrames)),
                padded.begin() + static_cast<std::ptrdiff_t>(dstOffset));
        }

        workingData = std::move(padded);
        workingFrames = windowFrames;
    }

    const int safeHop = std::max(1, hopFrames);
    const int numWindows = ((workingFrames - windowFrames) / safeHop) + 1;

    output.data.assign(static_cast<size_t>(numWindows * kMelBands * windowFrames), 0.0f);
    output.numWindows = numWindows;

    for (int windowIndex = 0; windowIndex < numWindows; ++windowIndex) {
        const int offset = windowIndex * safeHop;
        for (int mel = 0; mel < kMelBands; ++mel) {
            const size_t srcOffset = static_cast<size_t>(mel * workingFrames + offset);
            const size_t dstOffset = static_cast<size_t>((windowIndex * kMelBands + mel) * windowFrames);
            std::copy(
                workingData.begin() + static_cast<std::ptrdiff_t>(srcOffset),
                workingData.begin() + static_cast<std::ptrdiff_t>(srcOffset + static_cast<size_t>(windowFrames)),
                output.data.begin() + static_cast<std::ptrdiff_t>(dstOffset));
        }
    }

    return output;
}

void normalizeByMax(std::vector<float>& tensor)
{
    if (tensor.empty()) {
        return;
    }

    const auto maxIt = std::max_element(tensor.begin(), tensor.end());
    if (maxIt == tensor.end() || *maxIt <= 0.0f) {
        return;
    }

    const float maxValue = *maxIt;
    for (float& value : tensor) {
        value /= maxValue;
    }
}

int argmax(const std::vector<double>& values)
{
    if (values.empty()) {
        return 0;
    }

    int bestIndex = 0;
    double bestValue = values.front();
    for (size_t index = 1; index < values.size(); ++index) {
        if (values[index] > bestValue) {
            bestValue = values[index];
            bestIndex = static_cast<int>(index);
        }
    }

    return bestIndex;
}

double interpolateArgmax(const std::vector<double>& values, int index)
{
    if (index <= 0 || index >= static_cast<int>(values.size()) - 1) {
        return static_cast<double>(index);
    }

    const double left = values[static_cast<size_t>(index - 1)];
    const double center = values[static_cast<size_t>(index)];
    const double right = values[static_cast<size_t>(index + 1)];

    const double denominator = left - (2.0 * center) + right;
    if (std::abs(denominator) < 1e-12) {
        return static_cast<double>(index);
    }

    const double delta = 0.5 * (left - right) / denominator;
    const double safeDelta = clampDouble(delta, -1.0, 1.0);
    return static_cast<double>(index) + safeDelta;
}

double classIndexToBpm(double index)
{
    return clampDouble(index + 30.0, kTempoMinBpm, kTempoMaxBpm);
}

std::vector<double> movingAverageSame(const std::vector<double>& values, int windowSize)
{
    if (values.empty()) {
        return {};
    }

    int safeWindow = std::max(1, windowSize);
    if ((safeWindow % 2) == 0) {
        safeWindow += 1;
    }

    const int halfWindow = safeWindow / 2;
    std::vector<double> output(values.size(), 0.0);

    for (size_t index = 0; index < values.size(); ++index) {
        double sum = 0.0;
        for (int offset = -halfWindow; offset <= halfWindow; ++offset) {
            const int sampleIndex = static_cast<int>(index) + offset;
            if (sampleIndex < 0 || sampleIndex >= static_cast<int>(values.size())) {
                continue;
            }
            sum += values[static_cast<size_t>(sampleIndex)];
        }

        output[index] = sum / static_cast<double>(safeWindow);
    }

    return output;
}

std::vector<TempoPoint> compressTempoPoints(const std::vector<double>& bpmSeries, double hopSeconds)
{
    std::vector<TempoPoint> raw;
    raw.reserve(bpmSeries.size());

    for (size_t index = 0; index < bpmSeries.size(); ++index) {
        const double bpm = clampDouble(bpmSeries[index], kTempoMinBpm, kTempoMaxBpm);
        raw.push_back({
            roundToDecimals(static_cast<double>(index) * hopSeconds, 6),
            roundToDecimals(bpm, 6),
        });
    }

    if (raw.empty()) {
        return {};
    }

    std::vector<TempoPoint> compressed;
    compressed.reserve(raw.size());
    compressed.push_back(raw.front());

    for (size_t i = 1; i < raw.size(); ++i) {
        const auto& current = raw[i];
        const auto& last = compressed.back();

        const double timeDelta = current.timeSeconds - last.timeSeconds;
        const double bpmDelta = std::abs(current.bpm - last.bpm);

        if (timeDelta < kLocalTempoMinTimeDelta && bpmDelta < kLocalTempoMinBpmDelta) {
            continue;
        }

        compressed.push_back(current);
    }

    return compressed;
}

std::vector<double> averagePredictions(const std::vector<float>& predictions, int numWindows)
{
    std::vector<double> averaged(kTempoClasses, 0.0);
    if (numWindows <= 0) {
        return averaged;
    }

    for (int row = 0; row < numWindows; ++row) {
        const size_t rowOffset = static_cast<size_t>(row * kTempoClasses);
        for (int col = 0; col < kTempoClasses; ++col) {
            averaged[static_cast<size_t>(col)] += static_cast<double>(predictions[rowOffset + static_cast<size_t>(col)]);
        }
    }

    for (double& value : averaged) {
        value /= static_cast<double>(numWindows);
    }

    return averaged;
}

std::vector<double> predictionRowsToBpmSeries(const std::vector<float>& predictions, int numWindows)
{
    std::vector<double> bpmSeries;
    bpmSeries.resize(static_cast<size_t>(std::max(0, numWindows)));

    for (int row = 0; row < numWindows; ++row) {
        const size_t rowOffset = static_cast<size_t>(row * kTempoClasses);

        int bestIndex = 0;
        float bestValue = predictions[rowOffset];
        for (int col = 1; col < kTempoClasses; ++col) {
            const float value = predictions[rowOffset + static_cast<size_t>(col)];
            if (value > bestValue) {
                bestValue = value;
                bestIndex = col;
            }
        }

        bpmSeries[static_cast<size_t>(row)] = classIndexToBpm(static_cast<double>(bestIndex));
    }

    return bpmSeries;
}

} // namespace

TempoCnn::TempoCnn(const std::string& modelPath)
    : mEnv(ORT_LOGGING_LEVEL_WARNING, "tempocnn-core")
    , mSession(nullptr)
    , mMemoryInfo(nullptr)
{
    mSessionOptions.SetInterOpNumThreads(1);
    mSessionOptions.SetIntraOpNumThreads(1);

#if defined(_WIN32)
    const std::wstring wideModelPath(modelPath.begin(), modelPath.end());
    mSession = Ort::Session(mEnv, wideModelPath.c_str(), mSessionOptions);
#else
    mSession = Ort::Session(mEnv, modelPath.c_str(), mSessionOptions);
#endif
    mMemoryInfo = Ort::MemoryInfo::CreateCpu(OrtDeviceAllocator, OrtMemTypeCPU);

    Ort::AllocatorWithDefaultOptions allocator;

    auto inputName = mSession.GetInputNameAllocated(0, allocator);
    if (!inputName) {
        throw std::runtime_error("Unable to read ONNX input name.");
    }
    mInputName = inputName.get();

    auto outputName = mSession.GetOutputNameAllocated(0, allocator);
    if (!outputName) {
        throw std::runtime_error("Unable to read ONNX output name.");
    }
    mOutputName = outputName.get();
}

std::vector<float> TempoCnn::runModel(const std::vector<float>& inputData, int numWindows)
{
    if (numWindows <= 0) {
        throw std::runtime_error("TempoCNN input tensor is empty.");
    }

    const std::array<int64_t, 4> inputShape {
        static_cast<int64_t>(numWindows),
        static_cast<int64_t>(kMelBands),
        static_cast<int64_t>(kWindowFrames),
        1,
    };

    Ort::Value inputTensor = Ort::Value::CreateTensor<float>(
        mMemoryInfo,
        const_cast<float*>(inputData.data()),
        inputData.size(),
        inputShape.data(),
        inputShape.size());

    const char* inputNames[1] = {mInputName.c_str()};
    const char* outputNames[1] = {mOutputName.c_str()};
    Ort::RunOptions runOptions;

    auto outputs = mSession.Run(runOptions, inputNames, &inputTensor, 1, outputNames, 1);
    if (outputs.empty() || !outputs[0].IsTensor()) {
        throw std::runtime_error("TempoCNN ONNX runtime returned no tensor output.");
    }

    const auto shape = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
    if (shape.size() != 2 || shape[0] != static_cast<int64_t>(numWindows) || shape[1] != static_cast<int64_t>(kTempoClasses)) {
        throw std::runtime_error("TempoCNN ONNX output shape mismatch.");
    }

    const float* outputData = outputs[0].GetTensorData<float>();
    std::vector<float> output;
    output.assign(outputData, outputData + static_cast<size_t>(numWindows * kTempoClasses));
    return output;
}

TempoEstimateResult TempoCnn::estimate(const std::vector<float>& monoSamples, const TempoEstimateOptions& options)
{
    if (monoSamples.empty()) {
        throw std::runtime_error("Input audio is empty.");
    }

    const auto mel = computeMelSpectrogram(monoSamples);
    if (mel.totalFrames <= 0 || mel.data.empty()) {
        throw std::runtime_error("Failed to compute mel features.");
    }

    const auto globalWindows = toSlidingWindows(mel, kWindowFrames, kGlobalHopFrames, false);
    if (globalWindows.numWindows <= 0 || globalWindows.data.empty()) {
        throw std::runtime_error("Failed to build global tempo windows.");
    }

    auto globalInput = globalWindows.data;
    normalizeByMax(globalInput);
    const auto globalPrediction = runModel(globalInput, globalWindows.numWindows);

    const auto averaged = averagePredictions(globalPrediction, globalWindows.numWindows);
    const int coarseIndex = argmax(averaged);
    const double finalIndex = options.interpolate ? interpolateArgmax(averaged, coarseIndex) : static_cast<double>(coarseIndex);

    TempoEstimateResult result;
    result.bpm = classIndexToBpm(finalIndex);

    if (options.localTempo) {
        const auto localWindows = toSlidingWindows(mel, kWindowFrames, kLocalHopFrames, true);
        if (localWindows.numWindows > 0 && !localWindows.data.empty()) {
            auto localInput = localWindows.data;
            normalizeByMax(localInput);

            const auto localPrediction = runModel(localInput, localWindows.numWindows);
            auto localTempi = predictionRowsToBpmSeries(localPrediction, localWindows.numWindows);
            localTempi = movingAverageSame(localTempi, kLocalSmoothingWindow);

            for (double& bpm : localTempi) {
                bpm = clampDouble(bpm, kTempoMinBpm, kTempoMaxBpm);
            }

            const double hopSeconds = static_cast<double>(kLocalHopFrames) * kFeatureFrameSeconds;
            result.tempoMap = compressTempoPoints(localTempi, hopSeconds);
        }
    }

    return result;
}

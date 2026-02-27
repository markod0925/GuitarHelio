#include "BasicPitch.h"

#include <algorithm>
#include <cmath>
#include <sstream>

#include "Utils.h"

namespace {
size_t computeHeartbeatEvery(size_t totalFrames)
{
    if (totalFrames <= 120) {
        return 8;
    }
    if (totalFrames <= 600) {
        return 20;
    }
    return std::max<size_t>(30, totalFrames / 24);
}

void emitFrameHeartbeat(const char* event, size_t frameIdx, size_t totalFrames, double progressStart, double progressSpan)
{
    if (!NeuralNoteDiag::enabled()) {
        return;
    }

    const double ratio = totalFrames == 0 ? 1.0 : static_cast<double>(frameIdx) / static_cast<double>(totalFrames);
    const double progress = std::min(0.88, progressStart + progressSpan * std::max(0.0, std::min(1.0, ratio)));

    std::ostringstream detail;
    detail << "frame=" << frameIdx << "/" << totalFrames;
    NeuralNoteDiag::emit("basic_pitch", event, detail.str(), progress);
}
} // namespace

BasicPitch::BasicPitch(const std::string& modelDir)
    : mFeaturesCalculator(modelDir + "/features_model.onnx")
    , mBasicPitchCNN(modelDir)
{
}

void BasicPitch::reset()
{
    mBasicPitchCNN.reset();
    mNotesCreator.clear();

    mContoursPG.clear();
    mContoursPG.shrink_to_fit();
    mNotesPG.clear();
    mNotesPG.shrink_to_fit();
    mOnsetsPG.clear();
    mOnsetsPG.shrink_to_fit();
    mNoteEvents.clear();
    mNoteEvents.shrink_to_fit();

    mNumFrames = 0;
}

void BasicPitch::setParameters(float inNoteSensitivity,
                               float inSplitSensitivity,
                               float inMinNoteDurationMs,
                               bool inMelodiaTrick,
                               float inMinPitchHz,
                               float inMaxPitchHz,
                               int inEnergyTolerance)
{
    mParams.frameThreshold = 1.0f - inNoteSensitivity;
    mParams.onsetThreshold = 1.0f - inSplitSensitivity;

    mParams.minNoteLength = static_cast<int>(std::round(inMinNoteDurationMs / 1000.0f / (FFT_HOP / BASIC_PITCH_SAMPLE_RATE)));

    mParams.pitchBend = MultiPitchBend;
    mParams.melodiaTrick = inMelodiaTrick;
    mParams.inferOnsets = true;
    mParams.minFrequency = inMinPitchHz > 0.0f ? inMinPitchHz : -1.0f;
    mParams.maxFrequency = inMaxPitchHz > 0.0f ? inMaxPitchHz : -1.0f;
    mParams.energyThreshold = std::max(1, inEnergyTolerance);
}

void BasicPitch::transcribeToMIDI(float* inAudio, int inNumSamples)
{
    NeuralNoteDiag::emit("basic_pitch", "transcribe_start", "samples=" + std::to_string(inNumSamples), 0.46);
    const std::uint64_t transcribeStartMs = NeuralNoteDiag::monotonicMs();

    NeuralNoteDiag::emit("basic_pitch", "features_start", "", 0.48);
    const float* stackedCqt = mFeaturesCalculator.computeFeatures(inAudio, static_cast<size_t>(inNumSamples), mNumFrames);
    {
        const std::uint64_t featuresMs = NeuralNoteDiag::monotonicMs() - transcribeStartMs;
        std::ostringstream detail;
        detail << "frames=" << mNumFrames << " featuresMs=" << featuresMs;
        NeuralNoteDiag::emit("basic_pitch", "features_done", detail.str(), 0.64);
    }

    NeuralNoteDiag::emit("basic_pitch", "buffers_resize_start", "", 0.66);
    mOnsetsPG.resize(mNumFrames, std::vector<float>(static_cast<size_t>(NUM_FREQ_OUT), 0.0f));
    mNotesPG.resize(mNumFrames, std::vector<float>(static_cast<size_t>(NUM_FREQ_OUT), 0.0f));
    mContoursPG.resize(mNumFrames, std::vector<float>(static_cast<size_t>(NUM_FREQ_IN), 0.0f));

    mOnsetsPG.shrink_to_fit();
    mNotesPG.shrink_to_fit();
    mContoursPG.shrink_to_fit();
    NeuralNoteDiag::emit("basic_pitch", "buffers_resize_done", "", 0.68);

    mBasicPitchCNN.reset();
    NeuralNoteDiag::emit("basic_pitch", "cnn_reset_done", "", 0.69);

    const size_t numLhFrames = BasicPitchCNN::getNumFramesLookahead();
    const size_t heartbeatEvery = computeHeartbeatEvery(mNumFrames);
    {
        std::ostringstream detail;
        detail << "lookaheadFrames=" << numLhFrames << " heartbeatEvery=" << heartbeatEvery;
        NeuralNoteDiag::emit("basic_pitch", "inference_setup", detail.str(), 0.7);
    }

    std::vector<float> zeroStackedCqt(NUM_HARMONICS * NUM_FREQ_IN, 0.0f);

    NeuralNoteDiag::emit("basic_pitch", "warmup_zero_start", "", 0.705);
    for (int i = 0; i < static_cast<int>(numLhFrames); i++) {
        if (i == 0 || i + 1 == static_cast<int>(numLhFrames)) {
            emitFrameHeartbeat("warmup_zero_pre", static_cast<size_t>(i + 1), numLhFrames, 0.705, 0.01);
        }
        mBasicPitchCNN.frameInference(zeroStackedCqt.data(), mContoursPG[0], mNotesPG[0], mOnsetsPG[0]);
        if (i == 0 || i + 1 == static_cast<int>(numLhFrames)) {
            emitFrameHeartbeat("warmup_zero_post", static_cast<size_t>(i + 1), numLhFrames, 0.705, 0.01);
        }
    }
    NeuralNoteDiag::emit("basic_pitch", "warmup_zero_done", "", 0.715);

    NeuralNoteDiag::emit("basic_pitch", "warmup_cqt_start", "", 0.72);
    for (size_t frameIdx = 0; frameIdx < numLhFrames; frameIdx++) {
        if (frameIdx == 0 || frameIdx + 1 == numLhFrames) {
            emitFrameHeartbeat("warmup_cqt_pre", frameIdx + 1, numLhFrames, 0.72, 0.01);
        }
        mBasicPitchCNN.frameInference(stackedCqt + frameIdx * NUM_HARMONICS * NUM_FREQ_IN, mContoursPG[0], mNotesPG[0], mOnsetsPG[0]);
        if (frameIdx == 0 || frameIdx + 1 == numLhFrames) {
            emitFrameHeartbeat("warmup_cqt_post", frameIdx + 1, numLhFrames, 0.72, 0.01);
        }
    }
    NeuralNoteDiag::emit("basic_pitch", "warmup_cqt_done", "", 0.73);

    NeuralNoteDiag::emit("basic_pitch", "stream_inference_start", "", 0.735);
    for (size_t frameIdx = numLhFrames; frameIdx < mNumFrames; frameIdx++) {
        const size_t processed = frameIdx - numLhFrames + 1;
        const size_t total = mNumFrames > numLhFrames ? mNumFrames - numLhFrames : 0;
        const bool emitHeartbeat = processed == 1 || processed == total || (heartbeatEvery > 0 && processed % heartbeatEvery == 0);
        if (emitHeartbeat) {
            emitFrameHeartbeat("stream_inference_pre", processed, total, 0.735, 0.11);
        }

        mBasicPitchCNN.frameInference(stackedCqt + frameIdx * NUM_HARMONICS * NUM_FREQ_IN,
                                      mContoursPG[frameIdx - numLhFrames],
                                      mNotesPG[frameIdx - numLhFrames],
                                      mOnsetsPG[frameIdx - numLhFrames]);

        if (emitHeartbeat) {
            emitFrameHeartbeat("stream_inference_post", processed, total, 0.735, 0.11);
        }
    }
    NeuralNoteDiag::emit("basic_pitch", "stream_inference_done", "", 0.845);

    NeuralNoteDiag::emit("basic_pitch", "tail_flush_start", "", 0.85);
    for (size_t frameIdx = mNumFrames; frameIdx < mNumFrames + numLhFrames; frameIdx++) {
        const size_t processed = frameIdx - mNumFrames + 1;
        if (processed == 1 || processed == numLhFrames) {
            emitFrameHeartbeat("tail_flush_pre", processed, numLhFrames, 0.85, 0.01);
        }
        mBasicPitchCNN.frameInference(zeroStackedCqt.data(),
                                      mContoursPG[frameIdx - numLhFrames],
                                      mNotesPG[frameIdx - numLhFrames],
                                      mOnsetsPG[frameIdx - numLhFrames]);
        if (processed == 1 || processed == numLhFrames) {
            emitFrameHeartbeat("tail_flush_post", processed, numLhFrames, 0.85, 0.01);
        }
    }
    NeuralNoteDiag::emit("basic_pitch", "tail_flush_done", "", 0.86);

    NeuralNoteDiag::emit("basic_pitch", "notes_convert_start", "", 0.87);
    mNoteEvents = mNotesCreator.convert(mNotesPG, mOnsetsPG, mContoursPG, mParams, true);
    {
        const std::uint64_t totalMs = NeuralNoteDiag::monotonicMs() - transcribeStartMs;
        std::ostringstream detail;
        detail << "events=" << mNoteEvents.size() << " totalMs=" << totalMs;
        NeuralNoteDiag::emit("basic_pitch", "notes_convert_done", detail.str(), 0.9);
    }
}

void BasicPitch::updateMIDI()
{
    mNoteEvents = mNotesCreator.convert(mNotesPG, mOnsetsPG, mContoursPG, mParams, false);
}

const std::vector<Notes::Event>& BasicPitch::getNoteEvents() const
{
    return mNoteEvents;
}

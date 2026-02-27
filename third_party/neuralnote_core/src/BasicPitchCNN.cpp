#include "BasicPitchCNN.h"

#include <algorithm>
#include <fstream>
#include <stdexcept>

using json = nlohmann::json;

namespace {
json readJsonFile(const std::string& filePath)
{
    std::ifstream stream(filePath);
    if (!stream.is_open()) {
        throw std::runtime_error("Cannot open model file: " + filePath);
    }

    return json::parse(stream);
}
} // namespace

BasicPitchCNN::BasicPitchCNN(const std::string& modelDir)
{
    auto contour = readJsonFile(modelDir + "/cnn_contour_model.json");
    auto note = readJsonFile(modelDir + "/cnn_note_model.json");
    auto onset1 = readJsonFile(modelDir + "/cnn_onset_1_model.json");
    auto onset2 = readJsonFile(modelDir + "/cnn_onset_2_model.json");

    mCNNContour.parseJson(contour);
    mCNNNote.parseJson(note);
    mCNNOnsetInput.parseJson(onset1);
    mCNNOnsetOutput.parseJson(onset2);
}

void BasicPitchCNN::reset()
{
    for (auto& array : mContoursCircularBuffer) {
        array.fill(0.0f);
    }

    for (auto& array : mNotesCircularBuffer) {
        array.fill(0.0f);
    }

    for (auto& array : mConcat2CircularBuffer) {
        array.fill(0.0f);
    }

    mCNNContour.reset();
    mCNNNote.reset();
    mCNNOnsetInput.reset();
    mCNNOnsetOutput.reset();

    mNoteIdx = 0;
    mContourIdx = 0;
    mConcat2Idx = 0;

    mInputArray.fill(0.0f);
}

int BasicPitchCNN::getNumFramesLookahead()
{
    return mTotalLookahead;
}

void BasicPitchCNN::frameInference(const float* inData,
                                   std::vector<float>& outContours,
                                   std::vector<float>& outNotes,
                                   std::vector<float>& outOnsets)
{
    if (!(outContours.size() == NUM_FREQ_IN && outNotes.size() == NUM_FREQ_OUT && outOnsets.size() == NUM_FREQ_OUT)) {
        throw std::runtime_error("Invalid output buffer size in frameInference");
    }

    std::copy(inData, inData + NUM_HARMONICS * NUM_FREQ_IN, mInputArray.begin());

    _runModels();

    std::copy(mCNNOnsetOutput.getOutputs(), mCNNOnsetOutput.getOutputs() + NUM_FREQ_OUT, outOnsets.begin());

    std::copy(mNotesCircularBuffer[(size_t)_wrapIndex(mNoteIdx + 1, mNumNoteStored)].begin(),
              mNotesCircularBuffer[(size_t)_wrapIndex(mNoteIdx + 1, mNumNoteStored)].end(),
              outNotes.begin());

    std::copy(mContoursCircularBuffer[(size_t)_wrapIndex(mContourIdx + 1, mNumContourStored)].begin(),
              mContoursCircularBuffer[(size_t)_wrapIndex(mContourIdx + 1, mNumContourStored)].end(),
              outContours.begin());

    mContourIdx = (mContourIdx == mNumContourStored - 1) ? 0 : mContourIdx + 1;
    mNoteIdx = (mNoteIdx == mNumNoteStored - 1) ? 0 : mNoteIdx + 1;
    mConcat2Idx = (mConcat2Idx == mNumConcat2Stored - 1) ? 0 : mConcat2Idx + 1;
}

void BasicPitchCNN::_runModels()
{
    mCNNOnsetInput.forward(mInputArray.data());
    std::copy(mCNNOnsetInput.getOutputs(),
              mCNNOnsetInput.getOutputs() + 32 * NUM_FREQ_OUT,
              mConcat2CircularBuffer[(size_t)mConcat2Idx].begin());

    mCNNContour.forward(mInputArray.data());
    std::copy(mCNNContour.getOutputs(),
              mCNNContour.getOutputs() + NUM_FREQ_IN,
              mContoursCircularBuffer[(size_t)mContourIdx].begin());

    mCNNNote.forward(mCNNContour.getOutputs());
    std::copy(mCNNNote.getOutputs(), mCNNNote.getOutputs() + NUM_FREQ_OUT, mNotesCircularBuffer[(size_t)mNoteIdx].begin());

    _concat();

    mCNNOnsetOutput.forward(mConcatArray.data());
}

constexpr int BasicPitchCNN::_wrapIndex(int inIndex, int inSize)
{
    int wrappedIndex = inIndex % inSize;

    if (wrappedIndex < 0) {
        wrappedIndex += inSize;
    }

    return wrappedIndex;
}

void BasicPitchCNN::_concat()
{
    auto concat2Index = (size_t)_wrapIndex(mConcat2Idx + 1, mNumConcat2Stored);

    for (size_t i = 0; i < NUM_FREQ_OUT; i++) {
        mConcatArray[i * 33] = mCNNNote.getOutputs()[i];
        std::copy(mConcat2CircularBuffer[concat2Index].begin() + i * 32,
                  mConcat2CircularBuffer[concat2Index].begin() + (i + 1) * 32,
                  mConcatArray.begin() + i * 33 + 1);
    }
}

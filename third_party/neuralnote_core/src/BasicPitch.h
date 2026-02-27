#ifndef BasicPitch_h
#define BasicPitch_h

#include <string>
#include <vector>

#include "BasicPitchCNN.h"
#include "BasicPitchConstants.h"
#include "NNFeatures.h"
#include "Notes.h"

class BasicPitch
{
public:
    explicit BasicPitch(const std::string& modelDir);

    void reset();

    void setParameters(float inNoteSensitivity,
                       float inSplitSensitivity,
                       float inMinNoteDurationMs,
                       bool inMelodiaTrick,
                       float inMinPitchHz,
                       float inMaxPitchHz,
                       int inEnergyTolerance);

    void transcribeToMIDI(float* inAudio, int inNumSamples);

    void updateMIDI();

    const std::vector<Notes::Event>& getNoteEvents() const;

private:
    std::vector<std::vector<float>> mContoursPG;
    std::vector<std::vector<float>> mNotesPG;
    std::vector<std::vector<float>> mOnsetsPG;

    std::vector<Notes::Event> mNoteEvents;

    Notes::ConvertParams mParams;

    size_t mNumFrames = 0;

    Features mFeaturesCalculator;
    BasicPitchCNN mBasicPitchCNN;
    Notes mNotesCreator;
};

#endif // BasicPitch_h

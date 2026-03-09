#ifndef NeuralNoteTranscriber_h
#define NeuralNoteTranscriber_h

#include <string>
#include <vector>

#include "BasicPitch.h"

struct NeuralNoteBalancedPreset {
    float noteSensitivity = 0.65f;
    float splitSensitivity = 0.7f;
    float minNoteDurationMs = 120.0f;
    bool melodiaTrick = true;
    float minPitchHz = 1.0f;
    float maxPitchHz = 3000.0f;
    int energyTolerance = 11;
};

class NeuralNoteTranscriber
{
public:
    explicit NeuralNoteTranscriber(const std::string& modelDir);

    std::vector<Notes::Event> transcribe(const std::vector<float>& audio22050Mono,
                                         const NeuralNoteBalancedPreset& preset = {});

private:
    BasicPitch mBasicPitch;
};

#endif // NeuralNoteTranscriber_h

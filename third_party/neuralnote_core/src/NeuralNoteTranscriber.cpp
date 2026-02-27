#include "NeuralNoteTranscriber.h"

#include <sstream>
#include <stdexcept>

#include "Utils.h"

NeuralNoteTranscriber::NeuralNoteTranscriber(const std::string& modelDir)
    : mBasicPitch(modelDir)
{
    NeuralNoteDiag::emit("transcriber", "constructed", modelDir);
}

std::vector<Notes::Event> NeuralNoteTranscriber::transcribe(const std::vector<float>& audio22050Mono,
                                                            const NeuralNoteBalancedPreset& preset)
{
    if (audio22050Mono.empty()) {
        throw std::runtime_error("Input audio is empty");
    }

    auto localBuffer = audio22050Mono;
    {
        std::ostringstream detail;
        detail << "samples=" << localBuffer.size();
        NeuralNoteDiag::emit("transcriber", "reset_start", detail.str());
    }

    mBasicPitch.reset();
    NeuralNoteDiag::emit("transcriber", "set_params_start");
    mBasicPitch.setParameters(preset.noteSensitivity,
                              preset.splitSensitivity,
                              preset.minNoteDurationMs,
                              preset.melodiaTrick,
                              preset.minPitchHz,
                              preset.maxPitchHz,
                              preset.energyTolerance);
    NeuralNoteDiag::emit("transcriber", "set_params_done");
    NeuralNoteDiag::emit("transcriber", "basic_pitch_transcribe_start");
    mBasicPitch.transcribeToMIDI(localBuffer.data(), static_cast<int>(localBuffer.size()));
    NeuralNoteDiag::emit("transcriber", "basic_pitch_transcribe_done", "", 0.9);

    const auto& events = mBasicPitch.getNoteEvents();
    NeuralNoteDiag::emit("transcriber",
                         "events_ready",
                         "events=" + std::to_string(events.size()),
                         0.95);
    return events;
}

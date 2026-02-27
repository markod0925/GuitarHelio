#include <cstdlib>
#include <cmath>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "NeuralNoteTranscriber.h"
#include "TranscriptionIO.h"
#include "Utils.h"

namespace {

std::unordered_map<std::string, std::string> parseArgs(int argc, char** argv)
{
    std::unordered_map<std::string, std::string> args;
    for (int i = 1; i < argc; ++i) {
        const std::string token = argv[i];
        if (token.rfind("--", 0) == 0 && i + 1 < argc) {
            args[token] = argv[i + 1];
            ++i;
        }
    }
    return args;
}

void printProgress(const std::string& stage, double progress)
{
    std::cout << "{\"type\":\"progress\",\"stage\":\"" << stage << "\",\"progress\":" << progress << "}" << std::endl;
}

bool parseDoubleArg(const std::unordered_map<std::string, std::string>& args,
                    const std::string& key,
                    double& outValue,
                    std::string& outError)
{
    const auto it = args.find(key);
    if (it == args.end()) {
        return true;
    }

    try {
        const double parsed = std::stod(it->second);
        if (!std::isfinite(parsed)) {
            outError = "Invalid numeric value for " + key;
            return false;
        }
        outValue = parsed;
        return true;
    } catch (...) {
        outError = "Invalid numeric value for " + key;
        return false;
    }
}

bool parseIntArg(const std::unordered_map<std::string, std::string>& args,
                 const std::string& key,
                 int& outValue,
                 std::string& outError)
{
    const auto it = args.find(key);
    if (it == args.end()) {
        return true;
    }

    try {
        const int parsed = std::stoi(it->second);
        outValue = parsed;
        return true;
    } catch (...) {
        outError = "Invalid integer value for " + key;
        return false;
    }
}

bool parseBoolArg(const std::unordered_map<std::string, std::string>& args,
                  const std::string& key,
                  bool& outValue,
                  std::string& outError)
{
    const auto it = args.find(key);
    if (it == args.end()) {
        return true;
    }

    std::string normalized = it->second;
    for (char& c : normalized) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }

    if (normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on") {
        outValue = true;
        return true;
    }
    if (normalized == "0" || normalized == "false" || normalized == "no" || normalized == "off") {
        outValue = false;
        return true;
    }

    outError = "Invalid boolean value for " + key + " (expected 0/1/true/false)";
    return false;
}

} // namespace

int main(int argc, char** argv)
{
    NeuralNoteDiag::emit("cli", "start");

    const auto args = parseArgs(argc, argv);
    NeuralNoteDiag::emit("cli", "args_parsed", "argc=" + std::to_string(argc));

    const auto inputIt = args.find("--input-f32le");
    const auto outputIt = args.find("--output-json");
    const auto modelIt = args.find("--model-dir");
    const auto presetIt = args.find("--preset");

    if (inputIt == args.end() || outputIt == args.end() || modelIt == args.end()) {
        std::cerr << "Usage: nn_transcriber_cli --input-f32le <audio.f32> --output-json <events.json> --model-dir <modeldir> [--preset balanced]" << std::endl;
        return 1;
    }

    const std::string preset = presetIt == args.end() ? "balanced" : presetIt->second;
    if (preset != "balanced") {
        std::cerr << "Only preset 'balanced' is supported" << std::endl;
        return 1;
    }

    NeuralNoteBalancedPreset presetValues;
    std::string parseError;
    double parsedDouble = 0.0;
    int parsedInt = 0;
    bool parsedBool = false;

    if (!parseDoubleArg(args, "--note-sensitivity", parsedDouble, parseError)) {
        std::cerr << parseError << std::endl;
        return 1;
    }
    if (args.find("--note-sensitivity") != args.end()) {
        presetValues.noteSensitivity = static_cast<float>(parsedDouble);
    }

    if (!parseDoubleArg(args, "--split-sensitivity", parsedDouble, parseError)) {
        std::cerr << parseError << std::endl;
        return 1;
    }
    if (args.find("--split-sensitivity") != args.end()) {
        presetValues.splitSensitivity = static_cast<float>(parsedDouble);
    }

    if (!parseDoubleArg(args, "--min-note-ms", parsedDouble, parseError)) {
        std::cerr << parseError << std::endl;
        return 1;
    }
    if (args.find("--min-note-ms") != args.end()) {
        presetValues.minNoteDurationMs = static_cast<float>(parsedDouble);
    }

    if (!parseBoolArg(args, "--melodia-trick", parsedBool, parseError)) {
        std::cerr << parseError << std::endl;
        return 1;
    }
    if (args.find("--melodia-trick") != args.end()) {
        presetValues.melodiaTrick = parsedBool;
    }

    if (!parseDoubleArg(args, "--min-pitch-hz", parsedDouble, parseError)) {
        std::cerr << parseError << std::endl;
        return 1;
    }
    if (args.find("--min-pitch-hz") != args.end()) {
        presetValues.minPitchHz = static_cast<float>(parsedDouble);
    }

    if (!parseDoubleArg(args, "--max-pitch-hz", parsedDouble, parseError)) {
        std::cerr << parseError << std::endl;
        return 1;
    }
    if (args.find("--max-pitch-hz") != args.end()) {
        presetValues.maxPitchHz = static_cast<float>(parsedDouble);
    }

    if (!parseIntArg(args, "--energy-tolerance", parsedInt, parseError)) {
        std::cerr << parseError << std::endl;
        return 1;
    }
    if (args.find("--energy-tolerance") != args.end()) {
        presetValues.energyTolerance = parsedInt;
    }

    if (presetValues.noteSensitivity < 0.0f || presetValues.noteSensitivity > 1.0f) {
        std::cerr << "--note-sensitivity must be in [0,1]" << std::endl;
        return 1;
    }
    if (presetValues.splitSensitivity < 0.0f || presetValues.splitSensitivity > 1.0f) {
        std::cerr << "--split-sensitivity must be in [0,1]" << std::endl;
        return 1;
    }
    if (presetValues.minNoteDurationMs <= 0.0f) {
        std::cerr << "--min-note-ms must be > 0" << std::endl;
        return 1;
    }
    if (presetValues.minPitchHz < 0.0f) {
        std::cerr << "--min-pitch-hz must be >= 0" << std::endl;
        return 1;
    }
    if (presetValues.maxPitchHz < 0.0f) {
        std::cerr << "--max-pitch-hz must be >= 0" << std::endl;
        return 1;
    }
    if (presetValues.maxPitchHz > 0.0f && presetValues.minPitchHz > 0.0f && presetValues.maxPitchHz < presetValues.minPitchHz) {
        std::cerr << "--max-pitch-hz must be >= --min-pitch-hz" << std::endl;
        return 1;
    }
    if (presetValues.energyTolerance < 1) {
        std::cerr << "--energy-tolerance must be >= 1" << std::endl;
        return 1;
    }

    {
        std::ostringstream detail;
        detail << "noteSensitivity=" << presetValues.noteSensitivity
               << " splitSensitivity=" << presetValues.splitSensitivity
               << " minNoteMs=" << presetValues.minNoteDurationMs
               << " melodiaTrick=" << (presetValues.melodiaTrick ? 1 : 0)
               << " minPitchHz=" << presetValues.minPitchHz
               << " maxPitchHz=" << presetValues.maxPitchHz
               << " energyTolerance=" << presetValues.energyTolerance;
        NeuralNoteDiag::emit("cli", "preset_values", detail.str(), 0.2);
    }

    try {
        printProgress("Loading audio features...", 0.12);
        NeuralNoteDiag::emit("cli", "read_input_start", inputIt->second);

        std::vector<float> inputAudio;
        std::string ioError;
        if (!readFloat32LeFile(inputIt->second, inputAudio, ioError)) {
            std::cerr << ioError << std::endl;
            return 1;
        }
        {
            std::ostringstream detail;
            detail << "samples=" << inputAudio.size();
            NeuralNoteDiag::emit("cli", "read_input_done", detail.str(), 0.12);
        }

        if (inputAudio.empty()) {
            std::cerr << "Input audio is empty" << std::endl;
            return 1;
        }

        printProgress("Running NeuralNote model...", 0.45);
        NeuralNoteDiag::emit("cli", "transcriber_create_start", modelIt->second, 0.45);

        NeuralNoteTranscriber transcriber(modelIt->second);
        NeuralNoteDiag::emit("cli", "transcriber_create_done", "", 0.45);
        NeuralNoteDiag::emit("cli", "transcribe_start", "", 0.45);
        auto events = transcriber.transcribe(inputAudio, presetValues);
        {
            std::ostringstream detail;
            detail << "events=" << events.size();
            NeuralNoteDiag::emit("cli", "transcribe_done", detail.str(), 0.9);
        }

        if (events.empty()) {
            std::cerr << "No notes detected in uploaded audio." << std::endl;
            return 2;
        }

        printProgress("Building MIDI events...", 0.92);

        const auto coreEvents = toCoreEvents(events);
        {
            std::ostringstream detail;
            detail << "core_events=" << coreEvents.size();
            NeuralNoteDiag::emit("cli", "write_output_start", detail.str(), 0.94);
        }
        if (!writeCoreEventsJson(outputIt->second, coreEvents, ioError)) {
            std::cerr << ioError << std::endl;
            return 1;
        }
        NeuralNoteDiag::emit("cli", "write_output_done", outputIt->second, 1.0);

        printProgress("Conversion complete.", 1.0);
        NeuralNoteDiag::emit("cli", "done", "", 1.0);
        return 0;
    } catch (const std::exception& e) {
        NeuralNoteDiag::emit("cli", "exception", e.what());
        std::cerr << e.what() << std::endl;
        return 1;
    }
}

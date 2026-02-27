#include "TranscriptionIO.h"

#include <cmath>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <sstream>

std::vector<CoreNoteEvent> toCoreEvents(const std::vector<Notes::Event>& events)
{
    std::vector<CoreNoteEvent> out;
    out.reserve(events.size());

    for (const auto& event : events) {
        CoreNoteEvent converted;
        converted.startTimeSeconds = event.startTime;
        converted.durationSeconds = std::max(0.0, event.endTime - event.startTime);
        converted.pitchMidi = event.pitch;
        converted.amplitude = event.amplitude;
        out.push_back(converted);
    }

    return out;
}

bool readFloat32LeFile(const std::string& path, std::vector<float>& outSamples, std::string& outError)
{
    std::ifstream in(path, std::ios::binary);
    if (!in.is_open()) {
        outError = "Could not open PCM file: " + path;
        return false;
    }

    in.seekg(0, std::ios::end);
    const auto size = in.tellg();
    in.seekg(0, std::ios::beg);

    if (size <= 0 || (size % static_cast<std::streamoff>(sizeof(float))) != 0) {
        outError = "PCM file has invalid size";
        return false;
    }

    outSamples.resize(static_cast<size_t>(size / static_cast<std::streamoff>(sizeof(float))));
    in.read(reinterpret_cast<char*>(outSamples.data()), size);

    if (!in.good() && !in.eof()) {
        outError = "Failed reading PCM file";
        return false;
    }

    return true;
}

bool writeCoreEventsJson(const std::string& path, const std::vector<CoreNoteEvent>& events, std::string& outError)
{
    std::ofstream out(path, std::ios::binary);
    if (!out.is_open()) {
        outError = "Could not open output JSON path: " + path;
        return false;
    }

    out << "{\n  \"events\": [\n";

    for (size_t i = 0; i < events.size(); ++i) {
        const auto& event = events[i];
        out << "    {\"startTimeSeconds\":" << std::fixed << std::setprecision(9) << event.startTimeSeconds
            << ",\"durationSeconds\":" << std::fixed << std::setprecision(9) << event.durationSeconds
            << ",\"pitchMidi\":" << event.pitchMidi
            << ",\"amplitude\":" << std::fixed << std::setprecision(9) << event.amplitude
            << "}";

        if (i + 1 < events.size()) {
            out << ",";
        }
        out << "\n";
    }

    out << "  ]\n}\n";

    if (!out.good()) {
        outError = "Failed writing JSON output";
        return false;
    }

    return true;
}

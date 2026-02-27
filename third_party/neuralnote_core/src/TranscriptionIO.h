#ifndef TranscriptionIO_h
#define TranscriptionIO_h

#include <string>
#include <vector>

#include "Notes.h"

struct CoreNoteEvent {
    double startTimeSeconds = 0.0;
    double durationSeconds = 0.0;
    int pitchMidi = 0;
    double amplitude = 0.0;
};

std::vector<CoreNoteEvent> toCoreEvents(const std::vector<Notes::Event>& events);

bool readFloat32LeFile(const std::string& path, std::vector<float>& outSamples, std::string& outError);

bool writeCoreEventsJson(const std::string& path, const std::vector<CoreNoteEvent>& events, std::string& outError);

#endif // TranscriptionIO_h

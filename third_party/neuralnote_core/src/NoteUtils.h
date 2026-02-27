#ifndef NN_NOTEUTILS_H
#define NN_NOTEUTILS_H

#include <cmath>

namespace NoteUtils {

static inline int hzToMidi(float hz)
{
    return (int)std::round(12.0f * std::log2(hz / 440.0f) + 69.0f);
}

static inline float midiToHz(float midiNote)
{
    return 440.0f * std::pow(2.0f, (midiNote - 69.0f) / 12.0f);
}

} // namespace NoteUtils

#endif // NN_NOTEUTILS_H

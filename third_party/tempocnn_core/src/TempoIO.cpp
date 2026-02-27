#include "TempoIO.h"

#include <fstream>

bool readFloat32LeFile(const std::string& filePath, std::vector<float>& outSamples, std::string& outError)
{
    outSamples.clear();

    std::ifstream stream(filePath, std::ios::binary | std::ios::ate);
    if (!stream.is_open()) {
        outError = "Cannot open input file: " + filePath;
        return false;
    }

    const std::streamsize bytes = stream.tellg();
    if (bytes < 0) {
        outError = "Failed to determine input file size: " + filePath;
        return false;
    }

    if (bytes % static_cast<std::streamsize>(sizeof(float)) != 0) {
        outError = "Input file size is not aligned to float32 samples: " + filePath;
        return false;
    }

    stream.seekg(0, std::ios::beg);

    outSamples.resize(static_cast<size_t>(bytes) / sizeof(float));
    if (!outSamples.empty()) {
        stream.read(reinterpret_cast<char*>(outSamples.data()), bytes);
        if (!stream) {
            outError = "Failed to read input file: " + filePath;
            outSamples.clear();
            return false;
        }
    }

    return true;
}

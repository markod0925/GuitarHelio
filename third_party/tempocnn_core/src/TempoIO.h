#ifndef TEMPOCNN_CORE_TEMPO_IO_H
#define TEMPOCNN_CORE_TEMPO_IO_H

#include <string>
#include <vector>

bool readFloat32LeFile(const std::string& filePath, std::vector<float>& outSamples, std::string& outError);

#endif

#include <cctype>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "TempoCnn.h"
#include "TempoIO.h"

namespace {

std::unordered_map<std::string, std::string> parseArgs(int argc, char** argv)
{
    std::unordered_map<std::string, std::string> args;

    for (int i = 1; i < argc; ++i) {
        const std::string token = argv[i];
        if ((token == "--help") || (token == "-h")) {
            args[token] = "1";
            continue;
        }

        if (token.rfind("--", 0) == 0 && i + 1 < argc) {
            args[token] = argv[i + 1];
            ++i;
        }
    }

    return args;
}

bool parseBool(const std::unordered_map<std::string, std::string>& args,
               const std::string& key,
               bool defaultValue,
               std::string& outError)
{
    const auto it = args.find(key);
    if (it == args.end()) {
        return defaultValue;
    }

    std::string value = it->second;
    for (char& c : value) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }

    if (value == "1" || value == "true" || value == "yes" || value == "on") {
        return true;
    }
    if (value == "0" || value == "false" || value == "no" || value == "off") {
        return false;
    }

    outError = "Invalid boolean value for " + key + " (expected true/false or 1/0).";
    return defaultValue;
}

std::string escapeJson(const std::string& text)
{
    std::string out;
    out.reserve(text.size() + 8);

    for (char c : text) {
        switch (c) {
            case '\\':
                out += "\\\\";
                break;
            case '"':
                out += "\\\"";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    continue;
                }
                out += c;
                break;
        }
    }

    return out;
}

void printUsage()
{
    std::cout << "Usage: tempo_cnn_cli --input-f32le <audio.f32> --model-onnx <model.onnx> [--interpolate 0|1] [--local-tempo 0|1]"
              << std::endl;
}

} // namespace

int main(int argc, char** argv)
{
    const auto args = parseArgs(argc, argv);
    if (args.find("--help") != args.end() || args.find("-h") != args.end()) {
        printUsage();
        return 0;
    }

    const auto inputIt = args.find("--input-f32le");
    const auto modelIt = args.find("--model-onnx");

    if (inputIt == args.end() || modelIt == args.end()) {
        printUsage();
        return 1;
    }

    std::string parseError;
    const bool interpolate = parseBool(args, "--interpolate", false, parseError);
    if (!parseError.empty()) {
        std::cerr << parseError << std::endl;
        return 1;
    }

    const bool localTempo = parseBool(args, "--local-tempo", false, parseError);
    if (!parseError.empty()) {
        std::cerr << parseError << std::endl;
        return 1;
    }

    std::vector<float> samples;
    std::string ioError;
    if (!readFloat32LeFile(inputIt->second, samples, ioError)) {
        std::cerr << ioError << std::endl;
        return 1;
    }

    if (samples.empty()) {
        std::cerr << "Input audio is empty." << std::endl;
        return 1;
    }

    try {
        TempoCnn tempoCnn(modelIt->second);
        TempoEstimateOptions estimateOptions;
        estimateOptions.interpolate = interpolate;
        estimateOptions.localTempo = localTempo;

        const auto result = tempoCnn.estimate(samples, estimateOptions);

        std::ostringstream out;
        out.setf(std::ios::fixed);
        out.precision(6);

        out << "{";
        out << "\"bpm\":" << result.bpm;
        out << ",\"interpolate\":" << (interpolate ? "true" : "false");

        if (localTempo) {
            out << ",\"tempo_map\":[";
            for (size_t i = 0; i < result.tempoMap.size(); ++i) {
                if (i > 0) {
                    out << ",";
                }
                out << "{\"time\":" << result.tempoMap[i].timeSeconds << ",\"bpm\":" << result.tempoMap[i].bpm << "}";
            }
            out << "]";
        }

        out << "}";

        std::cout << out.str() << std::endl;
        return 0;
    } catch (const std::exception& e) {
        std::cerr << escapeJson(e.what()) << std::endl;
        return 1;
    }
}

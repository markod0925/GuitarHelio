#include <jni.h>

#include <algorithm>
#include <exception>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

#include "NeuralNoteTranscriber.h"
#include "TempoCnn.h"
#include "TranscriptionIO.h"

namespace {
std::string fromJString(JNIEnv* env, jstring value)
{
    if (value == nullptr) {
        return {};
    }

    const char* chars = env->GetStringUTFChars(value, nullptr);
    if (chars == nullptr) {
        return {};
    }

    std::string out(chars);
    env->ReleaseStringUTFChars(value, chars);
    return out;
}

jstring makeJavaString(JNIEnv* env, const std::string& value)
{
    return env->NewStringUTF(value.c_str());
}

bool writeTranscriptionAndTempoJson(const std::string& outputPath,
                                    const std::vector<CoreNoteEvent>& events,
                                    const TempoEstimateResult& tempo,
                                    std::string& outError)
{
    std::ofstream out(outputPath, std::ios::binary);
    if (!out.is_open()) {
        outError = "Could not open output JSON path: " + outputPath;
        return false;
    }

    out << "{\n";
    out << "  \"events\": [\n";

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

    out << "  ],\n";
    out << "  \"tempoBpm\": " << std::fixed << std::setprecision(6) << tempo.bpm << ",\n";
    out << "  \"tempoMap\": [\n";

    for (size_t i = 0; i < tempo.tempoMap.size(); ++i) {
        const auto& point = tempo.tempoMap[i];
        out << "    {\"timeSeconds\":" << std::fixed << std::setprecision(6) << point.timeSeconds
            << ",\"bpm\":" << std::fixed << std::setprecision(6) << point.bpm
            << "}";
        if (i + 1 < tempo.tempoMap.size()) {
            out << ",";
        }
        out << "\n";
    }

    out << "  ]\n";
    out << "}\n";

    if (!out.good()) {
        outError = "Failed writing JSON output";
        return false;
    }

    return true;
}
} // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_guitarhelio_app_converter_NeuralNoteConverterPlugin_runTranscription(
    JNIEnv* env,
    jclass,
    jstring pcmPath,
    jstring tempoPcmPath,
    jstring modelDirPath,
    jstring tempoModelOnnxPath,
    jstring outputJsonPath)
{
    try {
        const std::string pcm = fromJString(env, pcmPath);
        const std::string tempoPcm = fromJString(env, tempoPcmPath);
        const std::string modelDir = fromJString(env, modelDirPath);
        const std::string tempoModelPath = fromJString(env, tempoModelOnnxPath);
        const std::string outputPath = fromJString(env, outputJsonPath);

        if (pcm.empty() || tempoPcm.empty() || modelDir.empty() || tempoModelPath.empty() || outputPath.empty()) {
            return makeJavaString(env, "Invalid JNI parameters for transcription.");
        }

        std::vector<float> nnSamples;
        std::vector<float> tempoSamples;
        std::string ioError;

        if (!readFloat32LeFile(pcm, nnSamples, ioError)) {
            return makeJavaString(env, ioError);
        }
        if (!readFloat32LeFile(tempoPcm, tempoSamples, ioError)) {
            return makeJavaString(env, ioError);
        }

        if (nnSamples.empty()) {
            return makeJavaString(env, "Input NeuralNote audio is empty");
        }
        if (tempoSamples.empty()) {
            return makeJavaString(env, "Input Tempo-CNN audio is empty");
        }

        NeuralNoteTranscriber transcriber(modelDir);
        auto nnEvents = transcriber.transcribe(nnSamples);
        auto coreEvents = toCoreEvents(nnEvents);

        TempoCnn tempoEstimator(tempoModelPath);
        TempoEstimateOptions tempoOptions;
        tempoOptions.interpolate = true;
        tempoOptions.localTempo = true;
        auto tempoEstimate = tempoEstimator.estimate(tempoSamples, tempoOptions);

        if (!writeTranscriptionAndTempoJson(outputPath, coreEvents, tempoEstimate, ioError)) {
            return makeJavaString(env, ioError);
        }

        return nullptr;
    } catch (const std::exception& e) {
        return makeJavaString(env, e.what());
    }
}

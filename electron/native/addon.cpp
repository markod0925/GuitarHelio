#include <napi.h>

#include <algorithm>
#include <functional>
#include <sstream>
#include <string>

#include "audio_engine.h"

namespace gh::native_pitch {
namespace {

bool executeNativeGuarded(const std::function<void()>& action, std::string& error)
{
    try {
        action();
        return true;
    } catch (const std::exception& ex) {
        error = ex.what();
        return false;
    } catch (...) {
        error = "Unknown native exception.";
        return false;
    }
}

Napi::Object diagnosticsToJs(Napi::Env env, const DiagnosticsSnapshot& diagnostics)
{
    Napi::Object out = Napi::Object::New(env);
    out.Set("backend_effective", diagnostics.backendEffective);
    out.Set("backend_requested", diagnostics.backendRequested);
    out.Set("sample_rate_requested", diagnostics.sampleRateRequested);
    out.Set("sample_rate_obtained", diagnostics.sampleRateObtained);
    out.Set("sample_rate", diagnostics.sampleRateObtained);
    out.Set("buffer_frames_requested", diagnostics.bufferFramesRequested);
    out.Set("frames_per_callback", diagnostics.framesPerCallback);
    out.Set("device_id", diagnostics.deviceId);
    out.Set("device_name", diagnostics.deviceName);
    out.Set("latency_ms", diagnostics.latencyMs);
    out.Set("preprocessing_active", diagnostics.preprocessingActive);
    out.Set("stream_state", diagnostics.streamState);
    if (diagnostics.fallbackReason.empty()) {
        out.Set("fallback_reason", env.Null());
    } else {
        out.Set("fallback_reason", diagnostics.fallbackReason);
    }

    out.Set("rms", diagnostics.rms);
    out.Set("peak", diagnostics.peak);
    out.Set("noise_floor", diagnostics.noiseFloor);
    out.Set("average_abs", diagnostics.averageAbs);
    out.Set("callback_count", static_cast<double>(diagnostics.callbackCount));
    out.Set("dropped_blocks", static_cast<double>(diagnostics.droppedBlocks));

    // Android-compatible aliases used by existing UI diagnostics code.
    out.Set("audio_api", diagnostics.backendEffective);
    out.Set("sharing_mode", diagnostics.backendEffective.find("Exclusive") != std::string::npos ? "exclusive" : "shared");
    out.Set("performance_mode", "low_latency");
    out.Set("actual_input_preset", diagnostics.preprocessingActive ? "shared_processed" : "unprocessed");
    out.Set("requested_input_preset", "unprocessed");

    return out;
}

Napi::Object sanityToJs(Napi::Env env, const SanitySnapshot& sanity)
{
    Napi::Object out = Napi::Object::New(env);
    out.Set("capture_seconds", sanity.captureSeconds);
    out.Set("rms", sanity.rms);
    out.Set("peak", sanity.peak);
    out.Set("noise_floor", sanity.noiseFloor);
    out.Set("average_abs", sanity.averageAbs);
    out.Set("callback_count", static_cast<double>(sanity.callbackCount));
    return out;
}

Napi::Object getJsonObject(Napi::Env env)
{
    Napi::Value jsonValue = env.Global().Get("JSON");
    if (!jsonValue.IsObject()) {
        throw Napi::Error::New(env, "global JSON object is not available.");
    }
    return jsonValue.As<Napi::Object>();
}

std::string stringifyJsValue(Napi::Env env, const Napi::Value& value)
{
    if (value.IsNull() || value.IsUndefined()) {
        return "null";
    }

    Napi::Object json = getJsonObject(env);
    Napi::Value stringifyValue = json.Get("stringify");
    if (!stringifyValue.IsFunction()) {
        throw Napi::Error::New(env, "JSON.stringify is not a function.");
    }
    Napi::Function stringify = stringifyValue.As<Napi::Function>();
    return stringify.Call(json, {value}).ToString().Utf8Value();
}

Napi::Value parseJsonString(Napi::Env env, const std::string& jsonText)
{
    Napi::Object json = getJsonObject(env);
    Napi::Value parseValue = json.Get("parse");
    if (!parseValue.IsFunction()) {
        throw Napi::Error::New(env, "JSON.parse is not a function.");
    }
    Napi::Function parse = parseValue.As<Napi::Function>();
    return parse.Call(json, {Napi::String::New(env, jsonText)});
}

Napi::Value startCaptureWrapped(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "startCapture(options) requires an object.").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object options = info[0].As<Napi::Object>();
    StartCaptureConfig config;

    if (options.Has("detector") && options.Get("detector").IsString()) {
        config.detector = options.Get("detector").As<Napi::String>().Utf8Value();
    }
    if (options.Has("sampleRateHint") && options.Get("sampleRateHint").IsNumber()) {
        config.sampleRateHint = options.Get("sampleRateHint").As<Napi::Number>().Int32Value();
    }
    if (options.Has("bufferFrames") && options.Get("bufferFrames").IsNumber()) {
        config.bufferFrames = options.Get("bufferFrames").As<Napi::Number>().Int32Value();
    }
    if (options.Has("audioInputMode") && options.Get("audioInputMode").IsString()) {
        config.audioInputMode = options.Get("audioInputMode").As<Napi::String>().Utf8Value();
    }
    if (options.Has("spectralModelJson") && options.Get("spectralModelJson").IsString()) {
        config.spectralModelJson = options.Get("spectralModelJson").As<Napi::String>().Utf8Value();
    }
    if (options.Has("maspAssetsDir") && options.Get("maspAssetsDir").IsString()) {
        config.maspAssetsDir = options.Get("maspAssetsDir").As<Napi::String>().Utf8Value();
    }
    if (options.Has("fretnetModelPath") && options.Get("fretnetModelPath").IsString()) {
        config.fretnetModelPath = options.Get("fretnetModelPath").As<Napi::String>().Utf8Value();
    }

    bool started = false;
    std::string error;
    if (!executeNativeGuarded(
            [&]() { started = AudioEngine::instance().startCapture(config, error); }, error)) {
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (!started) {
        Napi::Error::New(env, error.empty() ? "Failed to start native capture." : error)
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object out = Napi::Object::New(env);
    out.Set("running", true);
    out.Set("diagnostics", diagnosticsToJs(env, AudioEngine::instance().getDiagnostics()));
    return out;
}

Napi::Value stopCaptureWrapped(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    std::string error;
    if (!executeNativeGuarded([&]() { AudioEngine::instance().stopCapture(); }, error)) {
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object out = Napi::Object::New(env);
    out.Set("running", false);
    out.Set("diagnostics", diagnosticsToJs(env, AudioEngine::instance().getDiagnostics()));
    return out;
}

Napi::Value getDiagnosticsWrapped(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    DiagnosticsSnapshot diagnostics;
    std::string error;
    if (!executeNativeGuarded([&]() { diagnostics = AudioEngine::instance().getDiagnostics(); }, error)) {
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object out = Napi::Object::New(env);
    out.Set("diagnostics", diagnosticsToJs(env, diagnostics));
    return out;
}

Napi::Value runSanityTestWrapped(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    double captureSeconds = 2.5;
    if (info.Length() >= 1 && info[0].IsObject()) {
        Napi::Object options = info[0].As<Napi::Object>();
        if (options.Has("captureSeconds") && options.Get("captureSeconds").IsNumber()) {
            captureSeconds = options.Get("captureSeconds").As<Napi::Number>().DoubleValue();
        }
    }

    SanitySnapshot sanity;
    std::string error;
    if (!AudioEngine::instance().runSanityTest(captureSeconds, sanity, error)) {
        Napi::Error::New(env, error.empty() ? "Sanity test failed." : error)
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object out = Napi::Object::New(env);
    out.Set("sanity", sanityToJs(env, sanity));
    out.Set("diagnostics", diagnosticsToJs(env, AudioEngine::instance().getDiagnostics()));
    return out;
}

Napi::Value updateGameplayContextWrapped(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1) {
        Napi::TypeError::New(env, "updateGameplayContext(context) requires one argument.")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string contextJson;
    try {
        contextJson = stringifyJsValue(env, info[0]);
    } catch (const Napi::Error& error) {
        error.ThrowAsJavaScriptException();
        return env.Undefined();
    } catch (...) {
        Napi::Error::New(env, "Failed to serialize gameplay context.")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string error;
    if (!AudioEngine::instance().updateGameplayContext(contextJson, error)) {
        Napi::Error::New(env, error.empty() ? "Failed to update gameplay context." : error)
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object out = Napi::Object::New(env);
    out.Set("updated", true);
    return out;
}

Napi::Value pollDetectionsWrapped(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();

    std::size_t maxResults = 6;
    if (info.Length() >= 1 && info[0].IsObject()) {
        Napi::Object options = info[0].As<Napi::Object>();
        if (options.Has("maxResults") && options.Get("maxResults").IsNumber()) {
            maxResults = static_cast<std::size_t>(
                std::max(1, options.Get("maxResults").As<Napi::Number>().Int32Value()));
        }
    }

    auto results = AudioEngine::instance().pollDetections(maxResults);

    Napi::Array array = Napi::Array::New(env, results.size());
    for (std::size_t index = 0; index < results.size(); index += 1) {
        const DetectionResult& item = results[index];
        Napi::Object payload = Napi::Object::New(env);
        try {
            Napi::Value parsed = parseJsonString(env, item.detectorJson);
            if (parsed.IsObject()) {
                payload = parsed.As<Napi::Object>();
            }
        } catch (...) {
            payload = Napi::Object::New(env);
        }

        payload.Set("callback_to_result_latency_ms", item.callbackToResultLatencyMs);
        payload.Set("processing_time_ms", item.processingTimeMs);
        payload.Set("detector_queue_depth", static_cast<double>(item.detectorQueueDepth));
        payload.Set("dropped_blocks", static_cast<double>(item.droppedBlocks));
        payload.Set("overrun", item.overrun);

        array.Set(index, payload);
    }

    Napi::Object out = Napi::Object::New(env);
    out.Set("running", AudioEngine::instance().isRunning());
    out.Set("diagnostics", diagnosticsToJs(env, AudioEngine::instance().getDiagnostics()));
    out.Set("results", array);
    return out;
}

Napi::Value resetDetectorWrapped(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    std::string error;
    if (!AudioEngine::instance().resetDetector(error)) {
        Napi::Error::New(env, error.empty() ? "Failed to reset detector runtime." : error)
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Object out = Napi::Object::New(env);
    out.Set("reset", true);
    return out;
}

Napi::Value shutdownWrapped(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    AudioEngine::instance().shutdown();
    Napi::Object out = Napi::Object::New(env);
    out.Set("closed", true);
    return out;
}

} // namespace

Napi::Object initAddon(Napi::Env env, Napi::Object exports)
{
    exports.Set("startCapture", Napi::Function::New(env, startCaptureWrapped));
    exports.Set("stopCapture", Napi::Function::New(env, stopCaptureWrapped));
    exports.Set("getDiagnostics", Napi::Function::New(env, getDiagnosticsWrapped));
    exports.Set("runSanityTest", Napi::Function::New(env, runSanityTestWrapped));
    exports.Set("updateGameplayContext", Napi::Function::New(env, updateGameplayContextWrapped));
    exports.Set("pollDetections", Napi::Function::New(env, pollDetectionsWrapped));
    exports.Set("resetDetector", Napi::Function::New(env, resetDetectorWrapped));
    exports.Set("shutdown", Napi::Function::New(env, shutdownWrapped));
    return exports;
}

} // namespace gh::native_pitch

Napi::Object initGuitarHelioNativePitch(Napi::Env env, Napi::Object exports)
{
    return gh::native_pitch::initAddon(env, exports);
}

NODE_API_MODULE(guitarhelio_native_pitch, initGuitarHelioNativePitch)

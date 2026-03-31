#pragma once

#include <cstddef>

#ifdef __cplusplus
extern "C" {
#endif

struct NativePitchRuntimeHandle;

NativePitchRuntimeHandle* gh_native_pitch_runtime_new(const char* config_json, char** error_out);
void gh_native_pitch_runtime_destroy(NativePitchRuntimeHandle* handle);
void gh_native_pitch_runtime_reset(NativePitchRuntimeHandle* handle);
char* gh_native_pitch_runtime_update_gameplay_context(
    NativePitchRuntimeHandle* handle,
    const char* context_json);
char* gh_native_pitch_runtime_process_audio_block(
    NativePitchRuntimeHandle* handle,
    const float* samples,
    size_t sample_count,
    double capture_time_sec,
    char** result_json_out);
void gh_native_pitch_runtime_free_string(char* value);

#ifdef __cplusplus
}
#endif

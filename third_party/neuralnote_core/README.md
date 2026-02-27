# neuralnote_core

Vendored C++ transcription core extracted from NeuralNote (`Lib/Model`, `Lib/ModelData`) and adapted for file-based loading.

## Contents

- `src/`: core transcription sources + JSON/PCM helpers
- `modeldata/`: NeuralNote model files (`features_model.onnx` + CNN JSON weights)
- `vendor/RTNeural`, `vendor/modules/Eigen`, `vendor/modules/json`: RTNeural dependencies
- `../onnxruntime/linux-x64`: ONNX Runtime headers + shared library for desktop CLI
- `../onnxruntime/android-arm64-v8a`: ONNX Runtime headers + shared library for Android JNI
- `cli/main.cpp`: executable entrypoint used by Node wrapper

## Build (Linux/WSL)

```bash
cmake -S third_party/neuralnote_core -B third_party/neuralnote_core/build -DNEURALNOTE_BUILD_CLI=ON
cmake --build third_party/neuralnote_core/build --config Release -j
```

Binary output:

- `third_party/neuralnote_core/bin/nn_transcriber_cli`

CLI preset overrides supported by `nn_transcriber_cli`:

- `--note-sensitivity <0..1>`
- `--split-sensitivity <0..1>`
- `--min-note-ms <ms>`
- `--melodia-trick <true|false|1|0>`
- `--min-pitch-hz <hz>`
- `--max-pitch-hz <hz>`
- `--energy-tolerance <int>`

## Diagnostics

Set `GH_NEURALNOTE_CPP_DIAG=1` to emit structured JSON diagnostic lines on stdout:

```bash
GH_NEURALNOTE_CPP_DIAG=1 third_party/neuralnote_core/bin/nn_transcriber_cli ...
```

Diagnostic lines use payloads like:

```json
{"type":"diag","component":"basic_pitch","event":"stream_inference_pre","elapsedMs":12345,"detail":"frame=816/9789","progress":0.744169}
```

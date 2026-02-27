# tempocnn_core

C++ TempoCNN runtime for one-shot BPM estimation using ONNX Runtime.

## Build

```bash
cmake -S third_party/tempocnn_core -B third_party/tempocnn_core/build -DTEMPOCNN_BUILD_CLI=ON
cmake --build third_party/tempocnn_core/build --config Release -j
```

Binary output:

- `third_party/tempocnn_core/bin/tempo_cnn_cli`
- on Windows: `third_party/tempocnn_core/bin/tempo_cnn_cli.exe`

## CLI Usage

```bash
third_party/tempocnn_core/bin/tempo_cnn_cli \
  --input-f32le /tmp/audio.f32 \
  --model-onnx third_party/tempo_cnn/tempocnn/models/fcn.onnx \
  --interpolate 1 \
  --local-tempo 1
```

CLI writes a single JSON line on stdout:

```json
{"bpm":121.4,"tempo_map":[{"time":0.0,"bpm":120.9}]}
```

# FretNet Host Runtime (Rust)

## Purpose

Enable the same Rust native detector runtime used by Android (`tools/native_pitch_runtime`) to run directly on host development machines (WSL/Linux and Windows), so FretNet debugging, regression checks, and performance analysis do not require APK deployment.

## Architecture Boundary

Portable Rust inference path:

- `tools/fretnet_runtime_vendor`
  - audio loading, resampling, normalization
  - HCQT/frontend feature extraction
  - ONNX Runtime inference wrapper
  - streaming benchmark primitives and fixture-based regression tests
- `tools/native_pitch_runtime`
  - backend selection (`ac14`, `spectral_game_runtime_unified_v3`, `masp`, `fretnet`)
  - block scheduling/capture buffering
  - FretNet decode logic and compact detection payload

Android-specific integration:

- `android/app/src/main/java/com/guitarhelio/app/pitch/NativePitchInputPlugin.java`
  - Android permission/plugin lifecycle
  - asset staging to app-private directories
  - Android ORT library resolution/loading
- `android/app/src/main/cpp/native_pitch_input_jni.cpp`
  - JNI entry points
  - Oboe stream/callback threading
  - dynamic loading of `libnative_pitch_runtime.so`
- Android packaging assets/libs under `android/app/src/main/assets/native-pitch` and `android/app/src/main/jniLibs/arm64-v8a`

Current host-side extension:

- `tools/native_pitch_runtime/src/host_harness.rs`
  - offline and streaming simulation runner over the same runtime API
  - structured run + benchmark summaries
- `tools/native_pitch_runtime/src/bin/fretnet_host_cli.rs`
  - command-line harness for WAV-driven host execution

## Build on WSL/Linux

```bash
cargo check --manifest-path tools/native_pitch_runtime/Cargo.toml
cargo build --manifest-path tools/native_pitch_runtime/Cargo.toml --release
```

## Build on Windows (native Rust toolchain)

```powershell
scripts\build-native-pitch-windows.cmd
```

Or directly:

```powershell
cargo build --manifest-path tools\native_pitch_runtime\Cargo.toml --target x86_64-pc-windows-msvc --release
```

## Host CLI Usage

Streaming simulation (default mode):

```bash
cargo run --manifest-path tools/native_pitch_runtime/Cargo.toml --bin fretnet_host_cli -- \
  --audio-path /absolute/path/input.wav \
  --backend fretnet \
  --model-path /absolute/path/model.onnx \
  --block-size 1024 \
  --callback-size 256 \
  --mode streaming \
  --format json \
  --output /absolute/path/fretnet.streaming.json
```

Offline full-file pass:

```bash
cargo run --manifest-path tools/native_pitch_runtime/Cargo.toml --bin fretnet_host_cli -- \
  --audio-path /absolute/path/input.wav \
  --backend fretnet \
  --model-path /absolute/path/model.onnx \
  --mode offline \
  --format json \
  --output /absolute/path/fretnet.offline.json
```

Run both modes in one command:

```bash
cargo run --manifest-path tools/native_pitch_runtime/Cargo.toml --bin fretnet_host_cli -- \
  --audio-path /absolute/path/input.wav \
  --backend fretnet \
  --model-path /absolute/path/model.onnx \
  --mode both \
  --format json
```

Output formats:

- `--format json`: full deterministic report (`frames`, note events, run summary, optional benchmark).
- `--format csv`: frame-level rows for quick spreadsheet or diff workflows.

## Tests

Native runtime crate tests (including host harness tests):

```bash
cargo test --manifest-path tools/native_pitch_runtime/Cargo.toml
```

FretNet runtime regression/fixture tests:

```bash
cargo test --manifest-path tools/fretnet_runtime_vendor/Cargo.toml
```

Notes:

- FretNet-specific tests are skipped when the ONNX model file is not present.
- Host harness tests include:
  - deterministic repeatability
  - offline vs streaming consistency
  - benchmark path smoke checks
  - leading-silence tolerance for streaming FretNet host runs
  - FFI boundary parity for Android wrapper path (`gh_native_pitch_runtime_*`) vs direct Rust runtime path

## Benchmarking

Example:

```bash
cargo run --release --manifest-path tools/native_pitch_runtime/Cargo.toml --bin fretnet_host_cli -- \
  --audio-path /absolute/path/input.wav \
  --backend fretnet \
  --model-path /absolute/path/model.onnx \
  --mode streaming \
  --benchmark-iterations 10 \
  --warmup-iterations 2 \
  --format json \
  --output /absolute/path/fretnet.benchmark.json
```

Reported metrics include:

- wall-clock runtime per iteration
- runtime call count / emitted event count
- mean event processing time
- realtime factor (audio duration / wall time)

## Known Host vs Android Differences

- Android captures live microphone audio via Oboe; host harness uses file-based WAV input.
- Android runtime scheduling is tied to audio callbacks from device hardware; host streaming mode simulates callback cadence in deterministic software.
- Android loads ONNX Runtime through packaged `.so` resolution logic; host uses desktop ORT linkage path from `fretnet_runtime`.
- Numerical inference path and decode logic remain shared in Rust.
- Silence-only streaming windows are treated as `no-result` ticks on both Android and host harness paths.

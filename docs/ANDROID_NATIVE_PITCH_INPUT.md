# Android Native Pitch Input

## Purpose

GuitarHelio now has a native Android microphone pipeline for gameplay, tuner, and practice scenes.
The goal is to avoid the WebView/`getUserMedia` path on Android so microphone capture, sample-rate handling, and detector execution stay under explicit native control.

## Runtime split

- C++:
  - Oboe stream lifecycle
  - realtime input callback
  - lock-free ring buffer
  - worker-thread scheduling
  - runtime/stream diagnostics
- Rust:
  - detector engines and detector-facing DSP
  - shared native result normalization
- Kotlin/Java:
  - Capacitor plugin API
  - microphone permission handling
  - lifecycle bridge
  - asset staging for MASP/FretNet resources
- TypeScript:
  - scene orchestration
  - detector selection
  - gameplay context updates
  - polling compact detector results

TypeScript must not receive continuous raw PCM buffers from native code.

## Native Android flow

1. `NativePitchInputPlugin` receives control requests from TypeScript.
2. JNI opens an Oboe input stream and requests low-latency unprocessed capture where possible.
3. `onAudioReady()` writes mono float samples into a ring buffer and returns immediately.
4. A worker thread drains fixed-size blocks from the ring buffer.
5. The worker forwards blocks to the Rust detector runtime through a stable C ABI.
6. Compact JSON result objects are queued for TypeScript polling.

## Diagnostics-first behavior

Before trusting detector output on a device, the plugin exposes a diagnostics-only capture mode.

Reported diagnostics include:

- requested vs actual input preset
- audio API
- sharing/performance mode
- sample rate and hardware sample rate
- channel count and hardware channel count
- format
- frames per burst / frames per callback
- device ID
- unprocessed-input support flag
- stream state
- xrun count
- fallback reason
- empirical signal metrics: RMS, peak, noise floor, average absolute amplitude

The diagnostics path is intended to confirm whether Android really granted unprocessed input or silently downgraded the request.

## Detector backends

The native pipeline is designed to support these backends:

- `ac14`
- `MASP`
- `FRETNET`
- `spectral_game_runtime_unified_v3`

### ac14

`ac14` is the bring-up backend for validating native capture, block processing, result polling, and latency.

### spectral_game_runtime_unified_v3

The spectral gameplay detector continues to reuse `gh_dsp_core`.
TypeScript still owns gameplay state, but pitch inference now runs natively on Android.

### MASP

MASP is reused from the existing Rust backend in the sibling `GHPitchDetection` repository.
The Android plugin stages MASP artifacts from app assets and the Rust runtime performs chart-aware validation from compact gameplay context updates.

TypeScript only sends the active note window:

- `playhead_sec`
- `start_sec`
- `end_sec`
- `expected_midis`
- `expected_notes`
- optional capture anchor time

### FRETNET

FRETNET is reused from `GHPitchDetection/tools/FretNetRust/fretnet_runtime`.
The native runtime uses information already present in that repo:

- semantic `tablature` output is treated as `[strings, frames]`
- semantic `onsets` output is treated as `[strings, pitches, frames]`
- `tablature_rel` is available as a fallback raw tensor

The live decoder prefers semantic outputs and only falls back to `tablature_rel` when needed.
For raw fallback decoding, the flattened `tablature_rel` layout is interpreted per string instead of as a single global peak map.

## Result contract

Native results are compact and polling-friendly.
The normalized payload may include:

- `backend_name`
- `timestamp_sec`
- `pitch_hz`
- `midi_estimate`
- `confidence`
- `selected_notes`
- `chord_scores`
- `detected_string`
- `detected_fret`
- `best_note_id`
- `rejected_as_reference_bleed`
- `processing_time_ms`
- `callback_to_result_latency_ms`
- `detector_queue_depth`
- `dropped_blocks`
- `overrun`

## Build and packaging notes

- Android native C++ is built through the existing Gradle + CMake setup.
- Oboe is linked through Prefab and requires `ANDROID_STL=c++_shared`.
- The Rust runtime is expected at `android/app/src/main/jniLibs/arm64-v8a/libnative_pitch_runtime.so`.
- `libonnxruntime.so` must also be staged for FRETNET on `arm64-v8a`.
- MASP assets are staged under `android/app/src/main/assets/native-pitch/masp`.
- The FRETNET model is committed in this repo at `android/app/src/main/assets/native-pitch/fretnet/model.onnx`.
- `scripts/build-native-pitch-android.sh` uses that packaged asset by default.
- You can override the local model for a build with `FRETNET_MODEL_SOURCE=/absolute/path/to/model.onnx`.

The helper command is:

```bash
npm run build:native-pitch:android
```

Current repository note:

- the Bash helper requires a Linux-host Android NDK when run from WSL/Linux
- a Windows-only NDK inside WSL is not enough, because Windows `clang.exe` cannot link WSL `/mnt/...` artifact paths
- if the committed FRETNET model asset is deleted or missing, the Android plugin fails explicitly during `startCapture` instead of falling through to a generic runtime error

## Host-side parity tooling

For local host execution of the same Rust runtime path (without APK deployment), use:

- `tools/native_pitch_runtime/src/host_harness.rs`
- `tools/native_pitch_runtime/src/bin/fretnet_host_cli.rs`
- `docs/FRETNET_HOST_RUNTIME.md`

This keeps Android JNI/Oboe glue separate while enabling host debugging, deterministic regression checks, and reproducible benchmark runs on WAV inputs.

## Fallback behavior

- Non-Android platforms continue to use the existing web/runtime path.
- Android native diagnostics can still compile without the Rust detector `.so`; this is useful for Oboe bring-up.
- If the Rust detector runtime is missing or fails to initialize, the native plugin returns an explicit error plus diagnostics instead of silently streaming raw audio to JS.

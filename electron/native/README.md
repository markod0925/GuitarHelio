# Electron Native Pitch Addon (Windows)

This directory contains the Windows native microphone pipeline used by Electron runtime.

## Components

- `addon.cpp`: N-API surface exposed to Electron main process.
- `audio_engine.cpp` / `audio_engine.h`: PortAudio capture, WASAPI Exclusive fallback logic, lock-free ring buffer, DSP worker thread, diagnostics and sanity metrics.
- `rust_detector_bridge.h`: C ABI symbols linked from `native_pitch_runtime.lib`.
- `CMakeLists.txt`: `cmake-js` build definition.

## Required dependencies

- PortAudio built with WASAPI support (expected default path: `third_party/portaudio/windows-x64`).
- Rust static library built from `tools/native_pitch_runtime` for target `x86_64-pc-windows-msvc`.
- Node native build deps installed in repo (`node-addon-api`, `cmake-js` via `npm run install:windows`).

You can override paths with environment variables:

- `PORTAUDIO_ROOT`
- `NATIVE_PITCH_RUNTIME_LIB`

If PortAudio is not vendored in `third_party`, the Windows build script also auto-detects:

- `%VCPKG_ROOT%\installed\x64-windows`
- `C:\vcpkg\installed\x64-windows`

## Build commands (Windows)

```bat
npm run build:native-pitch:windows
npm run build:electron-native:addon
```

Combined command used by Windows packaging:

```bat
npm run build:electron-native:windows
```

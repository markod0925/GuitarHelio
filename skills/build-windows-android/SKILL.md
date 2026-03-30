---
name: build-windows-android
description: Build GuitarHelio for Windows desktop (.exe via electron-builder) and Android (.apk debug via Capacitor/Gradle). Use when asked to regenerate artifacts, verify outputs, or fix recurring packaging/build issues across Windows, WSL, Capacitor, Gradle, or the native Android pitch runtime.
---

# Build Windows Android

## Overview

Use a repeatable procedure to generate Windows and Android builds for GuitarHelio.

Windows packaging must run through `cmd.exe`.
Android now has two distinct build layers:

- WSL/Linux: build the Rust native pitch runtime `.so`
- Windows/Gradle: build the Android app and native C++ layer

Do not assume the old one-line Android build is sufficient when the native pitch runtime changed.

## Workflow

0. Prepare dependencies with the correct install pipeline for each host.
1. Build the Android Rust native runtime from WSL when Android native pitch code changed.
2. Build Windows if requested.
3. Build the Android app with Capacitor/Gradle.
4. Verify outputs with absolute paths.
5. Re-run the Linux/WSL npm install if a Windows install disturbed the server-side environment.

## Separate install pipelines

WSL / Linux runtime and Android web assets:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use 22
npm run install:linux-android
```

Windows packaging environment:

```bat
cmd.exe /c "cd /d C:\Dati\Marco\GameDev\GuitarHelio && npm run install:windows"
```

## Build Android native pitch runtime (.so) from WSL

Run this from WSL/bash, not PowerShell:

```bash
source "$HOME/.bashrc"
source "$HOME/.nvm/nvm.sh" && nvm use 22
cd /mnt/c/Dati/Marco/GameDev/GuitarHelio
npm run build:native-pitch:android
```

The helper also tries to stage the Android FRETNET model asset automatically from:

- `/mnt/c/Dati/Marco/GameDev/GuitarHelio/android/app/src/main/assets/native-pitch/fretnet/model.onnx`

You can override the committed model for a local build:

```bash
FRETNET_MODEL_SOURCE="/absolute/path/to/model.onnx" npm run build:native-pitch:android
```

Expected staged output:

- `/mnt/c/Dati/Marco/GameDev/GuitarHelio/android/app/src/main/jniLibs/arm64-v8a/libnative_pitch_runtime.so`
- `/mnt/c/Dati/Marco/GameDev/GuitarHelio/android/app/src/main/assets/native-pitch/fretnet/model.onnx`

### Required environment for the WSL native Android build

The helper script expects:

- `ANDROID_NDK_HOME` or `ANDROID_NDK_ROOT`
- a Linux-host Android NDK under a path such as:
  - `$HOME/Android/Sdk/ndk/29.0.14206865/toolchains/llvm/prebuilt/linux-x86_64/bin`

Recommended persistent shell config:

```bash
export ANDROID_SDK_ROOT="$HOME/Android/Sdk"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export ANDROID_NDK_HOME="$ANDROID_SDK_ROOT/ndk/29.0.14206865"
export ANDROID_NDK_ROOT="$ANDROID_NDK_HOME"
export PATH="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"
```

### Install Linux Android command-line tools and NDK inside WSL

Use this when WSL does not already have a Linux Android SDK/NDK:

```bash
set -euo pipefail
mkdir -p "$HOME/Android/Sdk"
cd "$HOME/Android/Sdk"
curl -fLo commandlinetools-linux-14742923_latest.zip \
  "https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip"
rm -rf cmdline-tools
mkdir -p cmdline-tools
unzip -q commandlinetools-linux-14742923_latest.zip -d cmdline-tools
mv cmdline-tools/cmdline-tools cmdline-tools/latest
rm -f commandlinetools-linux-14742923_latest.zip
export ANDROID_SDK_ROOT="$HOME/Android/Sdk"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy
yes | sdkmanager --licenses || true
sdkmanager "platform-tools" "ndk;29.0.14206865"
```

Important:

- run this from WSL/bash
- do not point the WSL build helper at `/mnt/c/.../Sdk/ndk/.../windows-x86_64`
- the WSL helper requires a Linux-host NDK because Windows `clang.exe` cannot reliably link WSL `/mnt/...` artifact paths

## Build Windows (.exe)

Run:

```bat
cmd.exe /c "cd /d C:\Dati\Marco\GameDev\GuitarHelio && npm run build:windows:clean"
```

Verify outputs:

- `C:\Dati\Marco\GameDev\GuitarHelio\release\GuitarHelio-0.1.0-x64.exe`
- `C:\Dati\Marco\GameDev\GuitarHelio\release\win-unpacked\`

## Build Android (APK debug)

If the native pitch runtime changed, build the `.so` first from WSL:

```bash
source "$HOME/.bashrc"
source "$HOME/.nvm/nvm.sh" && nvm use 22
cd /mnt/c/Dati/Marco/GameDev/GuitarHelio
npm run build:native-pitch:android
```

Then build the Android app from Windows Gradle:

```bat
cmd.exe /c "cd /d C:\Dati\Marco\GameDev\GuitarHelio && npm run build && npx cap sync android && cd android && gradlew.bat :app:assembleDebug"
```

For quicker native compile validation without packaging the full APK:

```bat
cmd.exe /c "cd /d C:\Dati\Marco\GameDev\GuitarHelio\android && gradlew.bat :app:compileDebugJavaWithJavac :app:externalNativeBuildDebug"
```

Verify outputs:

- `C:\Dati\Marco\GameDev\GuitarHelio\android\app\build\outputs\apk\debug\app-debug.apk`

## Troubleshooting

### Error `cmd: not found`

Always use `cmd.exe /c` for Windows packaging and Windows Gradle steps.

### Error `Cannot find module @rollup/rollup-win32-x64-msvc`

Run:

```bat
cmd.exe /c "cd /d C:\Dati\Marco\GameDev\GuitarHelio && npm install -D @rollup/rollup-win32-x64-msvc"
```

Then rerun `npm run build:windows:clean`.

### Error `Access is denied` on `release\win-unpacked\...`

Use the existing clean script:

```bat
npm run build:windows:clean
```

That script stops `GuitarHelio.exe` / `electron.exe` / `app-builder.exe`, removes read-only attributes, and deletes `release\win-unpacked` before rebuilding.

### Server environment no longer aligned after Windows/Android builds

Always run:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use 22
npm install
```

Use `npm run install:windows` only in Windows environments to install the Win-only dependency `@rollup/rollup-win32-x64-msvc` without keeping it in `package.json`.

### Error `EBADENGINE` in WSL/Linux

The project requires `node >=22` (`package.json -> engines.node`).
If WSL/Linux shows `node v20.x` or `EBADENGINE`, run this before any npm command:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use 22
node -v
npm -v
```

### Error `EACCES` on `node_modules\\.bin\\cap` or `capacitor` during `install:windows`

This usually happens after alternating npm installs between WSL (Linux symlinks in `.bin`) and Windows.
Recommended recovery:

```bash
find /mnt/c/Dati/Marco/GameDev/GuitarHelio/node_modules/.bin -maxdepth 1 -type l -delete
```

Then rerun:

```bat
cmd.exe /c "cd /d C:\Dati\Marco\GameDev\GuitarHelio && npm run install:windows"
```

### Error `wine is required` during Windows build

Do not cross-build Windows packaging from pure Linux.
Run it in Windows via `cmd.exe`, or from WSL with access to `cmd.exe`.

### Error `ANDROID_NDK_HOME or ANDROID_NDK_ROOT must be set`

Set one of them to the Linux-host NDK inside WSL:

```bash
export ANDROID_NDK_HOME="$HOME/Android/Sdk/ndk/29.0.14206865"
export ANDROID_NDK_ROOT="$ANDROID_NDK_HOME"
```

### Error `FRETNET model asset missing`

The Android plugin expects:

```text
android/app/src/main/assets/native-pitch/fretnet/model.onnx
```

Committed repo asset:

```text
/mnt/c/Dati/Marco/GameDev/GuitarHelio/android/app/src/main/assets/native-pitch/fretnet/model.onnx
```

If you want to temporarily replace that model for a local build, point the helper at another file:

```bash
FRETNET_MODEL_SOURCE="/absolute/path/to/model.onnx" npm run build:native-pitch:android
```

### Error about `windows-x86_64` toolchain while building from WSL

This means the helper is pointing at a Windows-host NDK under `/mnt/c/...`.
Use a Linux-host NDK in WSL instead.

### Android native pitch runtime is missing during Gradle/CMake

If CMake warns that `libnative_pitch_runtime.so` is not found for `arm64-v8a`, build it first:

```bash
source "$HOME/.bashrc"
source "$HOME/.nvm/nvm.sh" && nvm use 22
cd /mnt/c/Dati/Marco/GameDev/GuitarHelio
npm run build:native-pitch:android
```

## Operational notes

- Non-blocking warnings such as `chunk > 500kB`, `description/author`, or `asar usage is disabled` are acceptable if the build succeeds.
- Consider the Android build valid only when Gradle prints `BUILD SUCCESSFUL`.
- For native Android pitch runtime changes, a valid result requires both:
  - `libnative_pitch_runtime.so` staged under `android/app/src/main/jniLibs/arm64-v8a`
  - successful Gradle/CMake compile for the Android app

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="$ROOT_DIR/tools/native_pitch_runtime"
TARGET="aarch64-linux-android"
API_LEVEL="${ANDROID_NATIVE_API_LEVEL:-24}"
NDK_ROOT="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
FRETNET_MODEL_SOURCE="${FRETNET_MODEL_SOURCE:-}"
FRETNET_MODEL_DEST="$ROOT_DIR/android/app/src/main/assets/native-pitch/fretnet/model.onnx"

if [[ -z "$NDK_ROOT" ]]; then
  echo "ANDROID_NDK_HOME or ANDROID_NDK_ROOT must be set." >&2
  exit 1
fi

PREBUILT_ROOT="$NDK_ROOT/toolchains/llvm/prebuilt"
if [[ ! -d "$PREBUILT_ROOT" ]]; then
  echo "Android NDK LLVM prebuilt directory not found: $PREBUILT_ROOT" >&2
  exit 1
fi

if [[ -d "$PREBUILT_ROOT/linux-x86_64/bin" ]]; then
  TOOLCHAIN="$PREBUILT_ROOT/linux-x86_64/bin"
elif [[ -d "$PREBUILT_ROOT/windows-x86_64/bin" ]]; then
  echo "Detected a Windows-only NDK toolchain under WSL: $PREBUILT_ROOT/windows-x86_64/bin" >&2
  echo "This Bash build script requires a Linux NDK host toolchain because Windows clang.exe cannot link WSL /mnt paths." >&2
  echo "Use one of these options instead:" >&2
  echo "  1. Install a Linux NDK inside WSL and point ANDROID_NDK_HOME to it." >&2
  echo "  2. Run the Android Rust build from a Windows-native Rust toolchain." >&2
  exit 1
else
  echo "No supported Android NDK LLVM toolchain host found under: $PREBUILT_ROOT" >&2
  exit 1
fi

export CC_aarch64_linux_android="$TOOLCHAIN/aarch64-linux-android${API_LEVEL}-clang"
if [[ -x "$TOOLCHAIN/llvm-ar" ]]; then
  export AR_aarch64_linux_android="$TOOLCHAIN/llvm-ar"
else
export AR_aarch64_linux_android="$TOOLCHAIN/llvm-ar.exe"
fi
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"

mkdir -p "$(dirname "$FRETNET_MODEL_DEST")"
if [[ -n "$FRETNET_MODEL_SOURCE" ]]; then
  cp "$FRETNET_MODEL_SOURCE" "$FRETNET_MODEL_DEST"
  echo "Refreshed FRETNET model asset from $FRETNET_MODEL_SOURCE"
elif [[ -f "$FRETNET_MODEL_DEST" ]]; then
  echo "Using packaged FRETNET model asset at $FRETNET_MODEL_DEST"
else
  echo "Warning: FRETNET model asset missing at $FRETNET_MODEL_DEST" >&2
  echo "Commit the model into the repo or provide FRETNET_MODEL_SOURCE=/absolute/path/to/model.onnx." >&2
fi

cd "$CRATE_DIR"
cargo build --target "$TARGET" --release

OUTPUT_DIR="$ROOT_DIR/android/app/src/main/jniLibs/arm64-v8a"
mkdir -p "$OUTPUT_DIR"
cp "$CRATE_DIR/target/$TARGET/release/libnative_pitch_runtime.so" "$OUTPUT_DIR/"

echo "Staged libnative_pitch_runtime.so to $OUTPUT_DIR"

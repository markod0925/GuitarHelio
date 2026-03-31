@echo off
setlocal

set "ROOT=%~dp0.."
pushd "%ROOT%"

set "CARGO_EXE="
for /f "usebackq delims=" %%I in (`where cargo.exe 2^>nul`) do (
  set "CARGO_EXE=%%~fI"
  goto :cargo_found
)
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  set "CARGO_EXE=%USERPROFILE%\.cargo\bin\cargo.exe"
)
:cargo_found

if not defined CARGO_EXE (
  echo Rust toolchain not found.
  echo Install Rust for Windows and reopen the terminal:
  echo   https://rustup.rs
  echo Expected executable: "%USERPROFILE%\.cargo\bin\cargo.exe"
  popd
  exit /b 1
)

set "RUSTUP_EXE="
for /f "usebackq delims=" %%I in (`where rustup.exe 2^>nul`) do (
  set "RUSTUP_EXE=%%~fI"
  goto :rustup_found
)
if exist "%USERPROFILE%\.cargo\bin\rustup.exe" (
  set "RUSTUP_EXE=%USERPROFILE%\.cargo\bin\rustup.exe"
)
:rustup_found

if defined RUSTUP_EXE (
  "%RUSTUP_EXE%" target add x86_64-pc-windows-msvc >nul 2>nul
)

"%CARGO_EXE%" build --manifest-path tools\native_pitch_runtime\Cargo.toml --target x86_64-pc-windows-msvc --release
if errorlevel 1 (
  popd
  exit /b %errorlevel%
)

echo Built native_pitch_runtime.lib for x86_64-pc-windows-msvc.

popd
exit /b 0

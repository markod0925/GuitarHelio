@echo off
setlocal

set "ROOT=%~dp0.."
pushd "%ROOT%"

node -e "require.resolve('node-addon-api'); require.resolve('cmake-js')" >nul 2>nul
if errorlevel 1 (
  echo Missing Node native build dependencies: node-addon-api and/or cmake-js.
  echo Run this once from project root:
  echo   npm run install:windows
  echo Then retry:
  echo   npm run build:electron-native:windows
  popd
  exit /b 1
)

if not exist tools\native_pitch_runtime\target\x86_64-pc-windows-msvc\release\native_pitch_runtime.lib (
  echo Rust staticlib missing. Running build:native-pitch:windows...
  call npm run build:native-pitch:windows
  if errorlevel 1 (
    popd
    exit /b %errorlevel%
  )
)

if "%PORTAUDIO_ROOT%"=="" (
  set "PORTAUDIO_ROOT=%ROOT%\third_party\portaudio\windows-x64"
  if not exist "%PORTAUDIO_ROOT%\include\portaudio.h" (
    if defined VCPKG_ROOT (
      if exist "%VCPKG_ROOT%\installed\x64-windows\include\portaudio.h" (
        set "PORTAUDIO_ROOT=%VCPKG_ROOT%\installed\x64-windows"
      )
    )
  )
  if not exist "%PORTAUDIO_ROOT%\include\portaudio.h" (
    if exist "C:\vcpkg\installed\x64-windows\include\portaudio.h" (
      set "PORTAUDIO_ROOT=C:\vcpkg\installed\x64-windows"
    )
  )
)

if not exist "%PORTAUDIO_ROOT%\include\portaudio.h" (
  echo PortAudio SDK not found.
  echo Expected one of:
  echo   %ROOT%\third_party\portaudio\windows-x64
  echo   %%VCPKG_ROOT%%\installed\x64-windows
  echo   C:\vcpkg\installed\x64-windows
  echo.
  echo Set PORTAUDIO_ROOT and retry, for example:
  echo   set PORTAUDIO_ROOT=C:\vcpkg\installed\x64-windows
  echo   npm run build:electron-native:windows
  popd
  exit /b 1
)

if not exist "%PORTAUDIO_ROOT%\lib\portaudio_x64.lib" (
  if not exist "%PORTAUDIO_ROOT%\lib\portaudio.lib" (
    echo PortAudio library not found under:
    echo   %PORTAUDIO_ROOT%\lib
    echo Expected portaudio_x64.lib or portaudio.lib
    popd
    exit /b 1
  )
)

set "ELECTRON_VERSION="
for /f "usebackq delims=" %%I in (`node -p "((require('./package.json').devDependencies && require('./package.json').devDependencies.electron) || (require('./package.json').dependencies && require('./package.json').dependencies.electron) || '').replace(/^[^0-9]*/, '')"`) do set "ELECTRON_VERSION=%%~I"
if "%ELECTRON_VERSION%"=="" (
  echo Failed to resolve electron version from package.json.
  popd
  exit /b 1
)

call npx cmake-js rebuild --directory electron\native --arch x64 --runtime electron --runtime-version %ELECTRON_VERSION%
if errorlevel 1 (
  popd
  exit /b %errorlevel%
)

set "ADDON_RELEASE_DIR=%ROOT%\electron\native\build\Release"
if not exist "%ADDON_RELEASE_DIR%\guitarhelio_native_pitch.node" (
  echo Addon output missing: %ADDON_RELEASE_DIR%\guitarhelio_native_pitch.node
  popd
  exit /b 1
)

set "ONNXRUNTIME_DLL_DIR=%ROOT%\third_party\onnxruntime\windows-x64\lib"
if exist "%ONNXRUNTIME_DLL_DIR%\onnxruntime.dll" (
  copy /Y "%ONNXRUNTIME_DLL_DIR%\onnxruntime.dll" "%ADDON_RELEASE_DIR%\" >nul
)
if exist "%ONNXRUNTIME_DLL_DIR%\onnxruntime_providers_shared.dll" (
  copy /Y "%ONNXRUNTIME_DLL_DIR%\onnxruntime_providers_shared.dll" "%ADDON_RELEASE_DIR%\" >nul
)

set "PORTAUDIO_DLL_COPIED=0"
for %%F in (
  "%PORTAUDIO_ROOT%\bin\portaudio.dll"
  "%PORTAUDIO_ROOT%\lib\portaudio.dll"
  "%PORTAUDIO_ROOT%\bin\portaudio_x64.dll"
  "%PORTAUDIO_ROOT%\lib\portaudio_x64.dll"
) do (
  if exist "%%~fF" (
    copy /Y "%%~fF" "%ADDON_RELEASE_DIR%\" >nul
    if not errorlevel 1 set "PORTAUDIO_DLL_COPIED=1"
  )
)
if "%PORTAUDIO_DLL_COPIED%"=="0" (
  echo Warning: PortAudio runtime DLL was not found to copy near the addon.
  echo Looked under: %PORTAUDIO_ROOT%\bin and %PORTAUDIO_ROOT%\lib
)

echo Built Electron native pitch addon.

popd
exit /b 0

cmake_minimum_required(VERSION 3.18)
project(guitarhelio_native_pitch LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "guitarhelio_native_pitch addon currently supports Windows builds only.")
endif()

if(POLICY CMP0091)
  cmake_policy(SET CMP0091 NEW)
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL" CACHE STRING "MSVC runtime library" FORCE)

set(PROJECT_ROOT "${CMAKE_CURRENT_LIST_DIR}/../..")

execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY "${PROJECT_ROOT}"
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  ERROR_VARIABLE NODE_ADDON_API_ERROR
  RESULT_VARIABLE NODE_ADDON_API_RESULT
  OUTPUT_STRIP_TRAILING_WHITESPACE)
string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")
if(NOT NODE_ADDON_API_RESULT EQUAL 0 OR NODE_ADDON_API_DIR STREQUAL "")
  message(FATAL_ERROR "node-addon-api headers not found. Run npm run install:windows (or npm install) in ${PROJECT_ROOT}. Original error: ${NODE_ADDON_API_ERROR}")
endif()

set(PORTAUDIO_ROOT "$ENV{PORTAUDIO_ROOT}" CACHE PATH "PortAudio root directory")
if(PORTAUDIO_ROOT STREQUAL "")
  set(PORTAUDIO_ROOT "${PROJECT_ROOT}/third_party/portaudio/windows-x64")
endif()

set(PORTAUDIO_INCLUDE_DIR "${PORTAUDIO_ROOT}/include")
set(PORTAUDIO_LIBRARY "${PORTAUDIO_ROOT}/lib/portaudio_x64.lib")
if(NOT EXISTS "${PORTAUDIO_LIBRARY}")
  set(PORTAUDIO_LIBRARY "${PORTAUDIO_ROOT}/lib/portaudio.lib")
endif()

set(NATIVE_PITCH_RUNTIME_LIB "$ENV{NATIVE_PITCH_RUNTIME_LIB}" CACHE FILEPATH "Path to native_pitch_runtime.lib")
if(NATIVE_PITCH_RUNTIME_LIB STREQUAL "")
  set(NATIVE_PITCH_RUNTIME_LIB "${PROJECT_ROOT}/tools/native_pitch_runtime/target/x86_64-pc-windows-msvc/release/native_pitch_runtime.lib")
endif()

if(NOT EXISTS "${PORTAUDIO_INCLUDE_DIR}/portaudio.h")
  message(FATAL_ERROR "PortAudio headers not found at ${PORTAUDIO_INCLUDE_DIR}. Set PORTAUDIO_ROOT to a valid windows-x64 PortAudio SDK.")
endif()
if(NOT EXISTS "${PORTAUDIO_LIBRARY}")
  message(FATAL_ERROR "PortAudio library not found: ${PORTAUDIO_LIBRARY}")
endif()
if(NOT EXISTS "${NATIVE_PITCH_RUNTIME_LIB}")
  message(FATAL_ERROR "Rust staticlib not found: ${NATIVE_PITCH_RUNTIME_LIB}. Run npm run build:native-pitch:windows first.")
endif()

add_library(${PROJECT_NAME} SHARED
  addon.cpp
  audio_engine.cpp
  ${CMAKE_JS_SRC}
)

set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_INC}
  ${NODE_ADDON_API_DIR}
  ${PORTAUDIO_INCLUDE_DIR}
)

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_CPP_EXCEPTIONS
  NOMINMAX
  _CRT_SECURE_NO_WARNINGS
)

if(MSVC)
  target_compile_options(${PROJECT_NAME} PRIVATE
    /EHsc
    /MD$<$<CONFIG:Debug>:d>
  )
endif()

target_link_libraries(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_LIB}
  ${PORTAUDIO_LIBRARY}
  ${NATIVE_PITCH_RUNTIME_LIB}
  ole32
  ws2_32
  userenv
  ntdll
  DirectML
  uuid
  winmm
  avrt
  user32
)

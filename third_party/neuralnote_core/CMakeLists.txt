cmake_minimum_required(VERSION 3.16)
project(neuralnote_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# On single-config generators (Makefiles/Ninja), default to Release unless explicitly set.
if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

option(NEURALNOTE_BUILD_CLI "Build nn_transcriber_cli" ON)

set(NEURALNOTE_CORE_ROOT ${CMAKE_CURRENT_LIST_DIR})
set(ONNXRUNTIME_ROOT ${NEURALNOTE_CORE_ROOT}/../onnxruntime)

set(NEURALNOTE_CORE_SOURCES
    src/NNFeatures.cpp
    src/BasicPitchCNN.cpp
    src/BasicPitch.cpp
    src/Notes.cpp
    src/NeuralNoteTranscriber.cpp
    src/TranscriptionIO.cpp
)

add_library(neuralnote_core STATIC ${NEURALNOTE_CORE_SOURCES})

target_include_directories(neuralnote_core
    PUBLIC
        ${NEURALNOTE_CORE_ROOT}/src
        ${NEURALNOTE_CORE_ROOT}/vendor
        ${NEURALNOTE_CORE_ROOT}/vendor/modules/Eigen
)

target_compile_definitions(neuralnote_core
    PUBLIC
        RTNEURAL_USE_EIGEN=1
        RTNEURAL_DEFAULT_ALIGNMENT=16
)

if(NOT TARGET onnxruntime)
    add_library(onnxruntime SHARED IMPORTED GLOBAL)
endif()

if(ANDROID)
    set(ONNXRUNTIME_INCLUDE_DIR ${ONNXRUNTIME_ROOT}/android-arm64-v8a/include)
    set(ONNXRUNTIME_LIB ${ONNXRUNTIME_ROOT}/android-arm64-v8a/lib/libonnxruntime.so)
elseif(WIN32)
    set(ONNXRUNTIME_INCLUDE_DIR ${ONNXRUNTIME_ROOT}/windows-x64/include)
    set(ONNXRUNTIME_LIB ${ONNXRUNTIME_ROOT}/windows-x64/lib/onnxruntime.dll)
    set(ONNXRUNTIME_IMPLIB ${ONNXRUNTIME_ROOT}/windows-x64/lib/onnxruntime.lib)
else()
    set(ONNXRUNTIME_INCLUDE_DIR ${ONNXRUNTIME_ROOT}/linux-x64/include)
    set(ONNXRUNTIME_LIB ${ONNXRUNTIME_ROOT}/linux-x64/lib/libonnxruntime.so)
endif()

set_target_properties(onnxruntime PROPERTIES IMPORTED_LOCATION ${ONNXRUNTIME_LIB})
if(WIN32)
    set_target_properties(onnxruntime PROPERTIES IMPORTED_IMPLIB ${ONNXRUNTIME_IMPLIB})
endif()

target_include_directories(neuralnote_core PUBLIC ${ONNXRUNTIME_INCLUDE_DIR})
target_link_libraries(neuralnote_core PUBLIC onnxruntime)

if(NEURALNOTE_BUILD_CLI AND NOT ANDROID)
    add_executable(nn_transcriber_cli cli/main.cpp)
    target_link_libraries(nn_transcriber_cli PRIVATE neuralnote_core)

    set_target_properties(nn_transcriber_cli PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY ${NEURALNOTE_CORE_ROOT}/bin
    )

    if(UNIX AND NOT APPLE)
        set_target_properties(nn_transcriber_cli PROPERTIES
            BUILD_RPATH "$ORIGIN/../../onnxruntime/linux-x64/lib"
        )
    endif()
endif()

cmake_minimum_required(VERSION 3.16)
project(tempocnn_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

option(TEMPOCNN_BUILD_CLI "Build tempo_cnn_cli" ON)

set(TEMPOCNN_CORE_ROOT ${CMAKE_CURRENT_LIST_DIR})
set(ONNXRUNTIME_ROOT ${TEMPOCNN_CORE_ROOT}/../onnxruntime)

set(TEMPOCNN_CORE_SOURCES
    src/TempoIO.cpp
    src/TempoCnn.cpp
)

add_library(tempocnn_core STATIC ${TEMPOCNN_CORE_SOURCES})

target_include_directories(tempocnn_core
    PUBLIC
        ${TEMPOCNN_CORE_ROOT}/src
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

target_include_directories(tempocnn_core PUBLIC ${ONNXRUNTIME_INCLUDE_DIR})
target_link_libraries(tempocnn_core PUBLIC onnxruntime)

if(TEMPOCNN_BUILD_CLI AND NOT ANDROID)
    add_executable(tempo_cnn_cli cli/main.cpp)
    target_link_libraries(tempo_cnn_cli PRIVATE tempocnn_core)

    set_target_properties(tempo_cnn_cli PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY ${TEMPOCNN_CORE_ROOT}/bin
    )

    if(UNIX AND NOT APPLE)
        set_target_properties(tempo_cnn_cli PROPERTIES
            BUILD_RPATH "$ORIGIN/../../onnxruntime/linux-x64/lib"
        )
    endif()
endif()

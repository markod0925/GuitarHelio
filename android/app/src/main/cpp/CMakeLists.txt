cmake_minimum_required(VERSION 3.16)
project(guitarhelio_android_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(PROJECT_ROOT ${CMAKE_CURRENT_LIST_DIR}/../../../../..)
set(NEURALNOTE_CORE_ROOT ${PROJECT_ROOT}/third_party/neuralnote_core)
set(TEMPOCNN_CORE_ROOT ${PROJECT_ROOT}/third_party/tempocnn_core)

add_subdirectory(${NEURALNOTE_CORE_ROOT} ${CMAKE_CURRENT_BINARY_DIR}/neuralnote_core_build)
add_subdirectory(${TEMPOCNN_CORE_ROOT} ${CMAKE_CURRENT_BINARY_DIR}/tempocnn_core_build)

find_package(oboe REQUIRED CONFIG)

add_library(neuralnote_converter_jni SHARED neuralnote_converter_jni.cpp)
add_library(native_pitch_input_jni SHARED native_pitch_input_jni.cpp)

if(ANDROID)
    # Android 15+ devices may require 16 KB page-size compatible native binaries.
    target_link_options(neuralnote_converter_jni PRIVATE "-Wl,-z,max-page-size=16384")
    target_link_options(native_pitch_input_jni PRIVATE "-Wl,-z,max-page-size=16384")
endif()

target_include_directories(neuralnote_converter_jni PRIVATE
    ${NEURALNOTE_CORE_ROOT}/src
    ${TEMPOCNN_CORE_ROOT}/src
)

target_link_libraries(neuralnote_converter_jni PRIVATE
    neuralnote_core
    tempocnn_core
    log
)

target_link_libraries(native_pitch_input_jni PRIVATE
    oboe::oboe
    android
    dl
    log
)

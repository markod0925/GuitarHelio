cmake_minimum_required(VERSION 3.16)
project(neuralnote_converter_jni LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(PROJECT_ROOT ${CMAKE_CURRENT_LIST_DIR}/../../../../..)
set(NEURALNOTE_CORE_ROOT ${PROJECT_ROOT}/third_party/neuralnote_core)
set(TEMPOCNN_CORE_ROOT ${PROJECT_ROOT}/third_party/tempocnn_core)

add_subdirectory(${NEURALNOTE_CORE_ROOT} ${CMAKE_CURRENT_BINARY_DIR}/neuralnote_core_build)
add_subdirectory(${TEMPOCNN_CORE_ROOT} ${CMAKE_CURRENT_BINARY_DIR}/tempocnn_core_build)

add_library(neuralnote_converter_jni SHARED neuralnote_converter_jni.cpp)

target_include_directories(neuralnote_converter_jni PRIVATE
    ${NEURALNOTE_CORE_ROOT}/src
    ${TEMPOCNN_CORE_ROOT}/src
)

target_link_libraries(neuralnote_converter_jni PRIVATE
    neuralnote_core
    tempocnn_core
    log
)

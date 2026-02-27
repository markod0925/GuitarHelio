//
// Created by Tibor Vass on 07.03.23.
//

#ifndef Utils_h
#define Utils_h

#include <assert.h>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <cstdint>
#include <iostream>
#include <string>

static int safe_divide(int a, int b)
{
    auto res = std::div(a, b);
    assert(res.rem == 0);
    return res.quot;
}

namespace NeuralNoteDiag {
inline bool envFlagEnabled(const char* value)
{
    if (value == nullptr) {
        return false;
    }

    std::string normalized(value);
    for (char& c : normalized) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }

    return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on";
}

inline bool enabled()
{
    static const bool kEnabled = envFlagEnabled(std::getenv("GH_NEURALNOTE_CPP_DIAG"));
    return kEnabled;
}

inline std::uint64_t monotonicMs()
{
    using namespace std::chrono;
    return static_cast<std::uint64_t>(duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
}

inline std::uint64_t processStartMs()
{
    static const std::uint64_t kStartedAt = monotonicMs();
    return kStartedAt;
}

inline std::string escapeJsonString(const std::string& value)
{
    std::string out;
    out.reserve(value.size() + 8);

    for (const char c : value) {
        switch (c) {
            case '\\':
                out += "\\\\";
                break;
            case '"':
                out += "\\\"";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    // Drop control chars to keep diagnostic payload valid JSON.
                    continue;
                }
                out += c;
                break;
        }
    }

    return out;
}

inline void emit(const std::string& component,
                 const std::string& event,
                 const std::string& detail = std::string(),
                 double progress = -1.0)
{
    if (!enabled()) {
        return;
    }

    const std::uint64_t elapsedMs = monotonicMs() - processStartMs();

    std::cout << "{\"type\":\"diag\""
              << ",\"component\":\"" << escapeJsonString(component) << "\""
              << ",\"event\":\"" << escapeJsonString(event) << "\""
              << ",\"elapsedMs\":" << elapsedMs;

    if (!detail.empty()) {
        std::cout << ",\"detail\":\"" << escapeJsonString(detail) << "\"";
    }

    if (progress >= 0.0) {
        std::cout << ",\"progress\":" << progress;
    }

    std::cout << "}" << std::endl;
}
} // namespace NeuralNoteDiag

#endif // Utils_h

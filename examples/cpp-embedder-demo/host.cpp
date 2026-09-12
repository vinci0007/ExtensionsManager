/*
 * C++ embedder demo — Phase 1 + data-plane acceptance for the extensions-kernel C ABI.
 *
 * Loads the kernel cdylib as a real host would (LoadLibraryA / dlopen), then:
 *   1. Management plane round trip through JSON envelopes:
 *      kernel.load -> kernel.activate -> kernel.invoke("demo.hello")
 *      against examples/process-extension (a node JSON-RPC process plugin).
 *   2. Data-plane round trip against an in-process WASM guest:
 *      kernel.load(wasm) -> emk_handle_resolve -> emk_invoke_ptr -> emk_tick_ptr,
 *      including a per-call latency measurement.
 *
 * Run from the project root:
 *   powershell -File examples/cpp-embedder-demo/build.ps1 [-Release]
 * or build.sh. See those scripts for details.
 */
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace {

typedef unsigned int (*emk_abi_version_fn)(void);
typedef char *(*emk_request_fn)(const char *);
typedef const char *(*emk_last_error_fn)(void);
typedef void (*emk_string_free_fn)(char *);
typedef void (*emk_reset_fn)(void);
typedef unsigned long long (*emk_handle_resolve_fn)(const char *);
typedef long long (*emk_invoke_ptr_fn)(unsigned long long, const unsigned char *, unsigned long long, unsigned char *, unsigned long long);
typedef long long (*emk_tick_ptr_fn)(unsigned long long, const unsigned char *, unsigned long long, unsigned char *, unsigned long long);
typedef void (*emk_handle_release_fn)(unsigned long long);

struct KernelApi {
    emk_abi_version_fn abi_version;
    emk_request_fn request;
    emk_last_error_fn last_error;
    emk_string_free_fn string_free;
    emk_reset_fn reset;
    emk_handle_resolve_fn handle_resolve;
    emk_invoke_ptr_fn invoke_ptr;
    emk_tick_ptr_fn tick_ptr;
    emk_handle_release_fn handle_release;
};

#if defined(_WIN32)
using LibraryHandle = HMODULE;
FARPROC symbol(LibraryHandle library, const char *name) {
    return GetProcAddress(library, name);
}
#else
using LibraryHandle = void *;
void *symbol(LibraryHandle library, const char *name) {
    return dlsym(library, name);
}
#endif

template <typename T>
T require_symbol(LibraryHandle library, const char *name) {
    T entry = reinterpret_cast<T>(symbol(library, name));
    if (!entry) {
        std::fprintf(stderr, "kernel library is missing export: %s\n", name);
        std::exit(1);
    }
    return entry;
}

LibraryHandle load_library_handle(const char *library_path) {
#if defined(_WIN32)
    LibraryHandle library = LoadLibraryA(library_path);
#else
    LibraryHandle library = dlopen(library_path, RTLD_NOW);
#endif
    if (!library) {
        std::fprintf(stderr, "failed to load kernel library: %s\n", library_path);
#if defined(_WIN32)
        std::fprintf(stderr, "GetLastError=%lu\n", GetLastError());
#else
        std::fprintf(stderr, "dlerror=%s\n", dlerror());
#endif
        std::exit(1);
    }
    return library;
}

KernelApi load_kernel(const char *library_path) {
    LibraryHandle library = load_library_handle(library_path);

    KernelApi api;
    api.abi_version = require_symbol<emk_abi_version_fn>(library, "emk_abi_version");
    api.request = require_symbol<emk_request_fn>(library, "emk_request");
    api.last_error = require_symbol<emk_last_error_fn>(library, "emk_last_error");
    api.string_free = require_symbol<emk_string_free_fn>(library, "emk_string_free");
    api.reset = require_symbol<emk_reset_fn>(library, "emk_reset");
    api.handle_resolve = require_symbol<emk_handle_resolve_fn>(library, "emk_handle_resolve");
    api.invoke_ptr = require_symbol<emk_invoke_ptr_fn>(library, "emk_invoke_ptr");
    api.tick_ptr = require_symbol<emk_tick_ptr_fn>(library, "emk_tick_ptr");
    api.handle_release = require_symbol<emk_handle_release_fn>(library, "emk_handle_release");
    return api;
}

/* Sends one request, asserts a transport-level success, returns the raw response. */
std::string exchange(const KernelApi &api, const std::string &request) {
    char *response = api.request(request.c_str());
    if (!response) {
        const char *error = api.last_error();
        std::fprintf(stderr, "kernel request failed: %s\n", error ? error : "(no error recorded)");
        std::exit(1);
    }
    std::string owned(response);
    api.string_free(response);
    std::printf("> %s\n< %s\n", request.c_str(), owned.c_str());
    return owned;
}

std::string json_string(const std::string &value) {
    std::string escaped;
    for (char c : value) {
        if (c == '\\' || c == '"') {
            escaped.push_back('\\');
        }
        escaped.push_back(c);
    }
    return "\"" + escaped + "\"";
}

std::string plugin_directory(const char *fallback) {
    const char *from_environment = std::getenv("EMK_DEMO_PLUGIN_DIR");
    return json_string(from_environment ? from_environment : fallback);
}

long long percentile(std::vector<long long> &samples, double fraction) {
    std::sort(samples.begin(), samples.end());
    std::size_t index = static_cast<std::size_t>(
        (static_cast<double>(samples.size()) - 1.0) * fraction);
    return samples[index < samples.size() ? index : samples.size() - 1];
}

/* Loads an in-process wasm guest and returns a data-plane handle. */
unsigned long long open_data_plane(const KernelApi &api, const std::string &guest_path) {
    const std::string guest_json = json_string(guest_path);
    const std::string load = R"({"kind":"request","id":"10","method":"kernel.load","params":{)"
        + std::string(R"("manifest":{"id":"demo.dataplane.cpp-host","version":"1.0.0","protocolVersion":"1",)")
        + R"("artifact":{"kind":"wasm","entry":"./plugin.wat"},"runtime":"wasm","capabilities":[{"name":"dataplane"}]},)"
        + R"("runtime":{"kind":"wasm","entryPath":)" + guest_json + R"(,"cwd":"."},)"
        + R"("capabilities":[{"name":"dataplane","interactionMode":"unary","executionMode":"ephemeral","realtimeClass":"batch","concurrencyPolicy":"shared","resourceBudget":{}}],)"
        + R"("permissions":{},)"
        + R"("artifact":{"entryPath":)" + guest_json + R"(,"command":)" + guest_json
        + R"(,"args":[],"cwd":".","basePath":".","timeoutMs":5000},)"
        + R"("security":{"signaturePolicy":"allow-unsigned"}}})";
    char *response = api.request(load.c_str());
    if (!response) {
        const char *error = api.last_error();
        std::fprintf(stderr, "wasm load failed: %s\n", error ? error : "(no error recorded)");
        std::exit(1);
    }
    api.string_free(response);

    exchange(api, R"({"kind":"request","id":"11","method":"kernel.activate","params":{"extensionId":"demo.dataplane.cpp-host","context":{}}})");

    unsigned long long handle = api.handle_resolve("demo.dataplane.cpp-host");
    if (!handle) {
        const char *error = api.last_error();
        std::fprintf(stderr, "handle resolve failed: %s\n", error ? error : "(no error recorded)");
        std::exit(1);
    }
    return handle;
}

} // namespace

int main(int argc, char **argv) {
    const char *library_path = argc > 1 ? argv[1] : "rust/target/debug/extensions_kernel.dll";
    const std::string plugin_dir = plugin_directory("examples/process-extension");

    KernelApi api = load_kernel(library_path);

    if (api.abi_version() != 1) {
        std::fprintf(stderr, "unexpected kernel ABI version: %u\n", api.abi_version());
        return 1;
    }
    std::printf("kernel ABI version: %u\n", api.abi_version());
    api.reset();

    const std::string load = R"({"kind":"request","id":"1","method":"kernel.load","params":{)"
        + std::string(R"("manifest":{"id":"demo.cabi-process","version":"1.0.0","protocolVersion":"1",)")
        + R"("artifact":{"kind":"module","entry":"./plugin.mjs"},"runtime":"process","capabilities":[{"name":"demo.hello"}]},)"
        + R"("runtime":{"kind":"process","command":"node","args":["./plugin.mjs"],"cwd":)" + plugin_dir + R"(},)"
        + R"("capabilities":[{"name":"demo.hello","interactionMode":"unary","executionMode":"ephemeral","realtimeClass":"batch","concurrencyPolicy":"shared","resourceBudget":{}}],)"
        + R"("permissions":{},)"
        + R"("artifact":{"entryPath":"./plugin.mjs","command":"node","args":["./plugin.mjs"],"cwd":)" + plugin_dir
        + R"(,"basePath":)" + plugin_dir + R"(,"timeoutMs":10000},)"
        + R"("security":{"signaturePolicy":"allow-unsigned"}}})";
    const std::string load_response = exchange(api, load);
    if (load_response.find("security") == std::string::npos) {
        std::fprintf(stderr, "unexpected load response\n");
        return 1;
    }

    exchange(api, R"({"kind":"request","id":"2","method":"kernel.activate","params":{"extensionId":"demo.cabi-process","context":{"extensionId":"demo.cabi-process"}}})");

    const std::string invoke_response = exchange(api,
        R"({"kind":"request","id":"3","method":"kernel.invoke","params":{"extensionId":"demo.cabi-process","capability":"demo.hello","input":{"name":"cabi"}}})");
    if (invoke_response.find("hello from process extension") == std::string::npos) {
        std::fprintf(stderr, "invoke did not return the expected capability result\n");
        return 1;
    }

    /* ---- Data plane: in-process wasm guest through the byte transport ---- */
    const char *guest_override = std::getenv("EMK_DEMO_DATAPLANE_GUEST");
    const std::string guest_path = guest_override
        ? std::string(guest_override)
        : std::string("examples/cpp-embedder-demo/dataplane-guest.wat");
    const unsigned long long handle = open_data_plane(api, guest_path);

    const char *invoke_request = R"({"capability":"dataplane","input":{"n":1}})";
    unsigned char output[256];
    long long written = api.invoke_ptr(
        handle,
        reinterpret_cast<const unsigned char *>(invoke_request),
        std::strlen(invoke_request),
        output,
        sizeof(output));
    if (written <= 0) {
        const char *error = api.last_error();
        std::fprintf(stderr, "data-plane invoke failed: %s\n", error ? error : "(no error recorded)");
        return 1;
    }
    std::printf("> data-plane invoke\n< %.*s\n", static_cast<int>(written), output);
    if (output[0] != '{') {
        std::fprintf(stderr, "unexpected data-plane response\n");
        return 1;
    }

    const char *tick_batch = R"({"ticks":[{"dtMs":16},{"dtMs":16}]})";
    written = api.tick_ptr(
        handle,
        reinterpret_cast<const unsigned char *>(tick_batch),
        std::strlen(tick_batch),
        output,
        sizeof(output));
    if (written <= 0) {
        const char *error = api.last_error();
        std::fprintf(stderr, "data-plane tick failed: %s\n", error ? error : "(no error recorded)");
        return 1;
    }
    std::printf("> data-plane tick batch\n< %.*s\n", static_cast<int>(written), output);
    if (std::strstr(reinterpret_cast<char *>(output), "tick") == nullptr) {
        std::fprintf(stderr, "unexpected data-plane tick response\n");
        return 1;
    }

    const int iterations = 20000;
    std::vector<long long> samples;
    samples.reserve(iterations);
    const auto request_length = std::strlen(invoke_request);
    for (int i = 0; i < iterations; ++i) {
        const auto start = std::chrono::steady_clock::now();
        written = api.invoke_ptr(
            handle,
            reinterpret_cast<const unsigned char *>(invoke_request),
            request_length,
            output,
            sizeof(output));
        const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                 std::chrono::steady_clock::now() - start)
                                 .count();
        if (written <= 0) {
            std::fprintf(stderr, "data-plane invoke failed during measurement\n");
            return 1;
        }
        samples.push_back(elapsed);
    }
    std::printf("data-plane per-call tax over %d iterations:\n", iterations);
    std::printf("  P50  = %6lld ns\n", percentile(samples, 0.50));
    std::printf("  P90  = %6lld ns\n", percentile(samples, 0.90));
    std::printf("  P99  = %6lld ns\n", percentile(samples, 0.99));
    std::printf("  max  = %6lld ns\n", samples.back());

    api.handle_release(handle);

    api.reset();
    std::printf("OK: C++ host completed management and data-plane round trips through the C ABI\n");
    return 0;
}

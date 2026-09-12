// C++ WASM data-plane plugin template (freestanding: no CRT, no exceptions,
// no RTTI). Build with clang --target=wasm32 — see README.md.
//
// Byte contract (docs/embedded-kernel-data-plane.md):
// - The host writes the request bytes at linear-memory offset 0 and calls
//   ext_call(0, len).
// - The plugin writes its response bytes anywhere in linear memory and
//   returns (out_ptr << 32) | out_len packed into an i64 (negative = failure).
//
// Layout discipline: offset 0 .. INPUT_MAX (1 page) is reserved for host
// input; the response region starts at page 1. Keep allocations away from
// offset 0 — the host overwrites it on every call.

extern "C" {

// Linear memory is exported via -Wl,--export=memory.
extern unsigned char __linear_memory_base[];

}

namespace {

constexpr unsigned int INPUT_MAX = 65536;      // page 0: host-written request
constexpr unsigned int OUT_PTR = 65536;        // page 1: response region

unsigned long long pack(unsigned int out_ptr, unsigned int out_len) {
    return (static_cast<unsigned long long>(out_ptr) << 32)
         | static_cast<unsigned long long>(out_len);
}

} // namespace

extern "C" {

// Data-plane entry. A real plugin parses the request bytes (a JSON envelope
// {"capability": ..., "input": ...} today) from [in_ptr, in_ptr + in_len).
// This template answers with a fixed document; replace the body with your
// dispatch.
__attribute__((export_name("ext_call")))
long long ext_call(int in_ptr, int in_len) {
    (void)in_ptr;
    (void)in_len;

    const char response[] = "{\"plugin\":\"cpp-dataplane-template\",\"ok\":true}";
    unsigned int out_len = sizeof(response) - 1; // exclude the NUL
    for (unsigned int index = 0; index < out_len; ++index) {
        __linear_memory_base[OUT_PTR + index] = static_cast<unsigned char>(response[index]);
    }
    return static_cast<long long>(pack(OUT_PTR, out_len));
}

// Optional tick batch entry for frame/tick-driven hosts (same transport).
__attribute__((export_name("ext_tick")))
long long ext_tick(int in_ptr, int in_len) {
    (void)in_ptr;
    (void)in_len;

    const char response[] = "{\"tick\":true}";
    unsigned int out_len = sizeof(response) - 1;
    for (unsigned int index = 0; index < out_len; ++index) {
        __linear_memory_base[OUT_PTR + index] = static_cast<unsigned char>(response[index]);
    }
    return static_cast<long long>(pack(OUT_PTR, out_len));
}

} // extern "C"

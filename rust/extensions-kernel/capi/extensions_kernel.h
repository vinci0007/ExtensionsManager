/*
 * extensions-kernel C embedder surface — Phase 1 (JSON envelope over C strings).
 *
 * Requests are the same JSON envelope lines the kernel daemon consumes on stdio
 * (kind/id/method/params, e.g. "kernel.load", "kernel.activate", "kernel.invoke").
 * See the kernel crate tests and docs/superpowers/plans/2026-08-29-embedded-realtime-kernel.md.
 *
 * Error model:
 *   - emk_request returns NULL only for transport-level failures (null pointer,
 *     invalid UTF-8, invalid request envelope). Details via emk_last_error().
 *   - Kernel-level failures (unknown method/extension, contract violations) come back
 *     as normal JSON error envelopes, never NULL.
 *
 * Thread model: one global kernel instance; requests are serialized (Phase 1).
 * emk_last_error is thread-local and valid until the next emk_request on that thread.
 */
#ifndef EXTENSIONS_KERNEL_H
#define EXTENSIONS_KERNEL_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ABI revision of this export surface. */
unsigned int emk_abi_version(void);

/*
 * Submit one kernel request (a single JSON envelope line, no trailing newline).
 * Returns a heap-allocated NUL-terminated UTF-8 JSON response the caller must
 * release with emk_string_free. Multiple response lines (session events) are
 * joined with '\n' in order. Returns NULL on transport-level failure.
 */
char *emk_request(const char *request);

/* Last transport-level error on this thread, or NULL when there is none. */
const char *emk_last_error(void);

/* Release a string returned by this library. NULL is accepted and ignored. */
void emk_string_free(char *ptr);

/* Drop all kernel state (loaded extensions, sessions). For reloads and tests. */
void emk_reset(void);

/*
 * Data plane (in-process wasm plugins with the ext_call export).
 *
 * Resolve (or lazily register) a data-plane handle for a loaded extension id.
 * Returns 0 on failure; see emk_last_error.
 */
unsigned long long emk_handle_resolve(const char *extension_id);

/*
 * Byte invoke for a resolved handle. The request bytes are a JSON envelope
 * {"capability": ..., "input": ...}; the response bytes are the plugin's JSON
 * result. Returns the number of response bytes written to out, or -1 on failure
 * (see emk_last_error). A response larger than out_capacity is an error.
 */
long long emk_invoke_ptr(unsigned long long handle,
                         const unsigned char *input,
                         unsigned long long input_len,
                         unsigned char *out,
                         unsigned long long out_capacity);

/* Release a data-plane handle. Unknown handles are ignored. */
void emk_handle_release(unsigned long long handle);

/*
 * Tick entry for frame/tick-driven hosts: push one batch to the plugin's
 * ext_tick export (same byte transport as emk_invoke_ptr). Returns the number
 * of response bytes written to out, or -1 on failure (see emk_last_error).
 */
long long emk_tick_ptr(unsigned long long handle,
                       const unsigned char *input,
                       unsigned long long input_len,
                       unsigned char *out,
                       unsigned long long out_capacity);

#ifdef __cplusplus
}
#endif

#endif /* EXTENSIONS_KERNEL_H */

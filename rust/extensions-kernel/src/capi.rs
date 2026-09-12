//! C ABI export layer for embedding the kernel into arbitrary hosts (Phase 1 skeleton).
//!
//! Phase 1 carries the existing JSON kernel envelope protocol over C strings so any
//! language can drive the kernel in-process. Binary zero-copy entry points arrive with
//! the in-process WASM data plane (plan Phase 2+).
//!
//! Error contract:
//! - `emk_request` returns NULL only for transport-level failures (null pointer,
//!   invalid UTF-8, invalid request envelope, poisoned kernel). The cause is readable
//!   via `emk_last_error()` on the calling thread.
//! - Kernel-level failures (unknown method, unknown extension, contract violations)
//!   are normal responses: a JSON error envelope, never NULL.
//!
//! Thread contract: one global kernel instance guarded by a mutex, so requests are
//! serialized until the Phase 3 scheduler introduces concurrent dispatch.
//! `emk_last_error` is thread-local; its pointer stays valid until the next error is
//! set on the same thread.

use crate::KernelDaemon;
use std::cell::RefCell;
use std::ffi::{c_char, CStr, CString};
use std::sync::{Arc, LazyLock, Mutex};

static KERNEL: LazyLock<Mutex<KernelDaemon>> = LazyLock::new(|| Mutex::new(KernelDaemon::new()));

thread_local! {
    static LAST_ERROR: RefCell<Option<CString>> = const { RefCell::new(None) };
}

fn set_last_error(message: &str) {
    let stored = CString::new(message).unwrap_or_else(|_| CString::new("kernel error").unwrap());
    LAST_ERROR.with(|slot| *slot.borrow_mut() = Some(stored));
}

type KernelGuard = std::sync::MutexGuard<'static, KernelDaemon>;

fn lock_kernel_guard() -> KernelGuard {
    // A panic in a previous request must not poison the kernel for the host; kernel
    // request handling already converts failures into error envelopes, so poisoning
    // would only ever come from an unexpected bug. Recover and continue.
    KERNEL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// ABI revision of this export surface. Bump on any breaking signature/semantic change.
#[no_mangle]
pub extern "C" fn emk_abi_version() -> u32 {
    1
}

/// Submit one kernel request (a single JSON envelope line, no trailing newline).
///
/// Returns a heap-allocated NUL-terminated UTF-8 JSON response on success; the caller
/// owns it and must release it with `emk_string_free`. When a request produces several
/// response lines (session events), they are joined with '\n' in order.
/// Returns NULL on transport-level failure; see `emk_last_error`.
///
/// # Safety
/// `request` must be NULL or point to a valid NUL-terminated UTF-8 C string.
#[no_mangle]
pub extern "C" fn emk_request(request: *const c_char) -> *mut c_char {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = None);

    if request.is_null() {
        set_last_error("emk_request: request pointer is null");
        return std::ptr::null_mut();
    }

    let request = unsafe { CStr::from_ptr(request) };
    let request = match request.to_str() {
        Ok(line) => line,
        Err(_) => {
            set_last_error("emk_request: request is not valid UTF-8");
            return std::ptr::null_mut();
        }
    };

    let mut daemon = lock_kernel_guard();
    match daemon.handle_request_line(request) {
        Ok(lines) => {
            let joined = lines.join("\n");
            match CString::new(joined) {
                Ok(response) => response.into_raw(),
                Err(_) => {
                    set_last_error("emk_request: response contained an interior NUL byte");
                    std::ptr::null_mut()
                }
            }
        }
        Err(message) => {
            set_last_error(&message);
            std::ptr::null_mut()
        }
    }
}

/// Borrow the last transport-level error on this thread, or NULL when there is none.
/// The pointer is invalidated by the next `emk_request` call on the same thread.
#[no_mangle]
pub extern "C" fn emk_last_error() -> *const c_char {
    LAST_ERROR.with(|slot| match slot.borrow().as_ref() {
        Some(error) => error.as_ptr(),
        None => std::ptr::null(),
    })
}

/// Release a string returned by this library. NULL is accepted and ignored.
///
/// # Safety
/// `ptr` must be NULL or a pointer previously returned by `emk_request` that has not
/// been freed already.
#[no_mangle]
pub extern "C" fn emk_string_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(unsafe { CString::from_raw(ptr) });
    }
}

/// Drop all kernel state (loaded extensions, sessions). Intended for host reloads and tests.
#[no_mangle]
pub extern "C" fn emk_reset() {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = None);
    let mut daemon = lock_kernel_guard();
    *daemon = KernelDaemon::new();
}

/// Install a response sink on the global kernel and return the receiving end.
///
/// Async-dispatched invokes (scheduler enabled via `kernel.policy.set` with
/// `scheduler.asyncPoolThreads > 0`) deliver their response envelopes through
/// this channel as JSON lines. This is the Rust-embedding seam: the C ABI
/// cannot transport a channel, and the future napi binding reuses it for
/// async delivery into the host language. Without a sink the daemon keeps the
/// fully synchronous model (safe default).
pub fn install_global_response_sink() -> std::sync::mpsc::Receiver<String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    lock_kernel_guard().set_response_sink(Arc::new(Mutex::new(sender)));
    receiver
}

/// Resolve (or lazily register) a data-plane handle for a loaded extension id.
/// Returns 0 on failure; see `emk_last_error`.
///
/// # Safety
/// `extension_id` must be NULL or point to a valid NUL-terminated UTF-8 C string.
#[no_mangle]
pub extern "C" fn emk_handle_resolve(extension_id: *const c_char) -> u64 {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = None);
    if extension_id.is_null() {
        set_last_error("emk_handle_resolve: extension_id pointer is null");
        return 0;
    }
    let extension_id = unsafe { CStr::from_ptr(extension_id) };
    let extension_id = match extension_id.to_str() {
        Ok(id) => id,
        Err(_) => {
            set_last_error("emk_handle_resolve: extension_id is not valid UTF-8");
            return 0;
        }
    };
    let mut daemon = lock_kernel_guard();
    let handle = daemon.resolve_handle(extension_id);
    if handle == 0 {
        set_last_error(&format!("extension is not loaded: {extension_id}"));
    }
    handle
}

/// Data-plane byte invoke for a resolved handle (in-process wasm plugins only).
///
/// The request bytes are a JSON envelope `{"capability": ..., "input": ...}`; the
/// response bytes are the plugin's JSON result. Payload schema is opaque to the
/// transport and may move to a binary encoding without breaking this signature.
///
/// Returns the number of response bytes written to `out`, or -1 on failure
/// (see `emk_last_error`). A response larger than `out_capacity` is an error.
///
/// # Safety
/// `input` must reference `input_len` readable bytes (null is allowed only when
/// `input_len` is 0); `out` must reference `out_capacity` writable bytes (null is
/// allowed only when `out_capacity` is 0).
#[no_mangle]
pub extern "C" fn emk_invoke_ptr(
    handle: u64,
    input: *const u8,
    input_len: usize,
    out: *mut u8,
    out_capacity: usize,
) -> i64 {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = None);
    if input.is_null() && input_len > 0 {
        set_last_error("emk_invoke_ptr: input pointer is null");
        return -1;
    }
    if out.is_null() && out_capacity > 0 {
        set_last_error("emk_invoke_ptr: output pointer is null");
        return -1;
    }
    let input_slice = if input_len == 0 {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(input, input_len) }
    };
    let out_slice = if out_capacity == 0 {
        &mut [][..]
    } else {
        unsafe { std::slice::from_raw_parts_mut(out, out_capacity) }
    };

    let mut daemon = lock_kernel_guard();
    match daemon.invoke_bytes(handle, input_slice, out_slice) {
        Ok(written) => written as i64,
        Err(message) => {
            set_last_error(&message);
            -1
        }
    }
}

/// Release a data-plane handle. Unknown handles are ignored.
#[no_mangle]
pub extern "C" fn emk_handle_release(handle: u64) {
    lock_kernel_guard().release_handle(handle);
}

/// Tick entry for frame/tick-driven hosts: push one batch to the plugin's
/// `ext_tick` export, same byte transport as `emk_invoke_ptr`. Returns the number
/// of response bytes written, or -1 on failure (see `emk_last_error`).
///
/// # Safety
/// Same buffer contract as `emk_invoke_ptr`.
#[no_mangle]
pub extern "C" fn emk_tick_ptr(
    handle: u64,
    input: *const u8,
    input_len: usize,
    out: *mut u8,
    out_capacity: usize,
) -> i64 {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = None);
    if input.is_null() && input_len > 0 {
        set_last_error("emk_tick_ptr: input pointer is null");
        return -1;
    }
    if out.is_null() && out_capacity > 0 {
        set_last_error("emk_tick_ptr: output pointer is null");
        return -1;
    }
    let input_slice = if input_len == 0 {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(input, input_len) }
    };
    let out_slice = if out_capacity == 0 {
        &mut [][..]
    } else {
        unsafe { std::slice::from_raw_parts_mut(out, out_capacity) }
    };

    let mut daemon = lock_kernel_guard();
    match daemon.tick_bytes(handle, input_slice, out_slice) {
        Ok(written) => written as i64,
        Err(message) => {
            set_last_error(&message);
            -1
        }
    }
}

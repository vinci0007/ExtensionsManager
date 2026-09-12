//! Node N-API bindings for the ExtensionsManager embedded kernel.
//!
//! The binding deliberately wraps the C ABI surface (`extensions_kernel::capi`)
//! so Node hosts exercise the exact same embedded-host semantics as native
//! engines: process-global kernel singleton, kernel mutex, thread-local last
//! error, byte data plane (`emk_invoke_ptr` / `emk_tick_ptr`) and the async
//! scheduler response sink.
//!
//! Loading without @napi-rs/cli: `cargo build -p extensions-kernel-napi
//! --release`, copy the produced cdylib to a `.node` file inside the project,
//! then `process.dlopen(module, <path>)` from Node. All sync bindings run on
//! the JS main thread, so the kernel mutex is contended only by kernel-internal
//! scheduler workers — exactly the native-embedding model.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::ffi::CString;

use extensions_kernel::capi::{
    emk_handle_release, emk_handle_resolve, emk_invoke_ptr, emk_last_error, emk_request, emk_reset,
    emk_string_free, emk_tick_ptr, install_global_response_sink,
};

fn last_error_message() -> Option<String> {
    unsafe {
        let pointer = emk_last_error();
        if pointer.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr(pointer).to_string_lossy().to_string())
    }
}

thread_local! {
    static DRAIN: std::cell::RefCell<Option<std::sync::mpsc::Receiver<String>>> =
        const { std::cell::RefCell::new(None) };
}

#[napi]
pub fn abi_version() -> u32 {
    1
}

/// Drop all kernel state (loaded extensions, sessions). Same semantics as
/// `emk_reset`.
#[napi]
pub fn reset() {
    emk_reset();
}

/// Submit one kernel request (a JSON envelope line). Returns the response JSON
/// string, or `null` on transport-level failure (see `lastError()`).
#[napi]
pub fn request(line: String) -> Option<String> {
    let line = match CString::new(line) {
        Ok(line) => line,
        Err(_) => return None,
    };
    let response = emk_request(line.as_ptr());
    if response.is_null() {
        return None;
    }
    let owned = unsafe { std::ffi::CStr::from_ptr(response) }.to_string_lossy().to_string();
    emk_string_free(response);
    Some(owned)
}

/// Borrow the last transport-level error (null when the last call succeeded).
#[napi]
pub fn last_error() -> Option<String> {
    last_error_message()
}

/// Resolve (or lazily register) a data-plane handle for a loaded extension.
/// Returns null when the extension is not loaded.
#[napi]
pub fn handle_resolve(extension_id: String) -> Option<f64> {
    let id = match CString::new(extension_id) {
        Ok(id) => id,
        Err(_) => return None,
    };
    let handle = emk_handle_resolve(id.as_ptr());
    if handle == 0 {
        None
    } else {
        // Handles are small monotonic counters; f64 keeps them plain JS numbers.
        Some(handle as f64)
    }
}

/// Data-plane byte invoke: `input` is the request JSON bytes, the response is
/// written into `out` and the number of bytes written is returned (-1 on
/// failure; see `lastError()`). Buffers are caller-owned and reusable across
/// frames — zero per-frame kernel-side allocation on the hot path.
#[napi]
pub fn invoke_ptr(handle: f64, input: Buffer, mut out: Buffer) -> i32 {
    let input: &[u8] = &input;
    let out: &mut [u8] = &mut out;
    emk_invoke_ptr(handle as u64, input.as_ptr(), input.len(), out.as_mut_ptr(), out.len()) as i32
}

/// Tick entry for frame/tick-driven hosts: push one batch to the plugin's
/// `ext_tick` export. Same buffer contract as `invokePtr`.
#[napi]
pub fn tick_ptr(handle: f64, input: Buffer, mut out: Buffer) -> i32 {
    let input: &[u8] = &input;
    let out: &mut [u8] = &mut out;
    emk_tick_ptr(handle as u64, input.as_ptr(), input.len(), out.as_mut_ptr(), out.len()) as i32
}

#[napi]
pub fn handle_release(handle: f64) {
    emk_handle_release(handle as u64);
}

/// Install the async scheduler response sink on the global kernel. Deliveries
/// are collected with `drainAsyncResponses` on the same JS thread.
#[napi]
pub fn install_response_sink() -> bool {
    let receiver = install_global_response_sink();
    DRAIN.with(|slot| {
        let replaced = slot.borrow().is_some();
        *slot.borrow_mut() = Some(receiver);
        !replaced
    })
}

/// Drain pending async response envelopes (JSON strings) delivered by the
/// scheduler workers. Poll this each frame or on a timer.
#[napi]
pub fn drain_async_responses() -> Vec<String> {
    DRAIN.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(receiver) = slot.as_mut() else {
            return Vec::new();
        };
        let mut drained = Vec::new();
        while let Ok(envelope) = receiver.try_recv() {
            drained.push(envelope);
        }
        drained
    })
}

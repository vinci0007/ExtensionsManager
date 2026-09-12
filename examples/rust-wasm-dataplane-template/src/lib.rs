//! Rust WASM data-plane plugin template for the embedded extensions kernel.
//!
//! Build (one-time toolchain setup: `rustup target add wasm32-unknown-unknown`):
//!   cargo build --release --target wasm32-unknown-unknown
//!   copy target/wasm32-unknown-unknown/release/rust_wasm_dataplane_template.wasm
//!   next to this file as plugin.wasm
//!
//! Then load it through the kernel (runtime kind "wasm", entryPath = plugin.wasm).
//! The kernel's numeric contract and byte fast path both apply — see
//! docs/embedded-kernel-data-plane.md for the full contract.
#![no_std]

use core::arch::wasm32;

/// Response region start. Offset 0 is reserved for host-written request bytes.
const OUT_PTR: u32 = 4096;

static RESPONSE: &[u8] = b"{\"plugin\":\"rust-dataplane-template\",\"ok\":true}";
static TICK_RESPONSE: &[u8] = b"{\"tick\":true}";

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    wasm32::unreachable()
}

/// Byte fast path entry: the host writes request bytes at offset 0 and calls
/// `ext_call(0, len)`. This template ignores the request payload and answers with
/// a fixed JSON document; real plugins parse the request bytes from linear memory.
///
/// Return value packs `(out_ptr << 32) | out_len`; a negative value reports a
/// plugin-side failure to the host.
#[no_mangle]
pub extern "C" fn ext_call(_in_ptr: i32, _in_len: i32) -> i64 {
    pack(RESPONSE)
}

/// Optional tick batch entry for frame/tick-driven hosts (same byte transport).
#[no_mangle]
pub extern "C" fn ext_tick(_in_ptr: i32, _in_len: i32) -> i64 {
    pack(TICK_RESPONSE)
}

/// Numeric contract demo export: callable through kernel.invoke with
/// input `41` or `{"value": 41}` — mirrors examples/wasm-extension-template.
#[no_mangle]
pub extern "C" fn addOne(value: i32) -> i32 {
    value + 1
}

fn pack(bytes: &'static [u8]) -> i64 {
    let packed = ((bytes.as_ptr() as u64) << 32) | (bytes.len() as u64 & 0xFFFF_FFFF);
    packed as i64
}

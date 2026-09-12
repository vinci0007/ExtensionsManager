//! Phase 2 acceptance benchmark: data-plane per-call infrastructure tax.
//!
//! Measures the full host→C ABI→wasm invoke→host round trip against a guest whose
//! plugin logic is a static response (no computation), so the measured cost is
//! infrastructure tax only: FFI transition, kernel mutex, request JSON parse,
//! linear-memory write, wasmtime call, linear-memory read.
//!
//! Acceptance (plan Phase 2): P99 ≤ 5 µs on development hardware. The assertion
//! below uses a generous 50 µs guard so loaded CI machines don't flake; the printed
//! percentiles are the real acceptance numbers.

use extensions_kernel::capi::{
    emk_handle_release, emk_handle_resolve, emk_invoke_ptr, emk_request, emk_string_free,
};
use serde_json::json;
use std::ffi::{CStr, CString};
use std::path::PathBuf;
use std::time::Instant;

const ECHO_WAT: &str = r#"
(module
  (memory (export "memory") 1)
  (data (i32.const 4096) "{\"echo\":true,\"len_note\":\"from dataplane\"}")
  (func (export "ext_call") (param $in_ptr i32) (param $in_len i32) (result i64)
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.const 4096)) (i64.const 32))
      (i64.extend_i32_u (i32.const 41)))))
"#;

fn percentile(samples: &mut [u128], fraction: f64) -> u128 {
    samples.sort_unstable();
    let index = ((samples.len() as f64 - 1.0) * fraction).round() as usize;
    samples[index.min(samples.len() - 1)]
}

#[test]
fn data_plane_per_call_tax_is_microsecond_scale() {
    let mut plugin_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    plugin_dir.push("../../.tmp/phase2-tests");
    std::fs::create_dir_all(&plugin_dir).expect("tmp dir");
    let plugin_path = plugin_dir.join("latency.wat");
    std::fs::write(&plugin_path, ECHO_WAT).expect("guest module should be written");
    let entry = plugin_path.to_string_lossy().replace("\\\\?\\", "");

    let load = json!({
        "kind": "request",
        "id": "1",
        "method": "kernel.load",
        "params": {
            "manifest": {
                "id": "demo.dataplane.latency",
                "version": "1.0.0",
                "protocolVersion": "1",
                "artifact": { "kind": "wasm", "entry": "./plugin.wat" },
                "runtime": "wasm",
                "capabilities": [{ "name": "dataplane" }]
            },
            "runtime": { "kind": "wasm", "entryPath": entry, "cwd": "." },
            "capabilities": [{
                "name": "dataplane",
                "interactionMode": "unary",
                "executionMode": "ephemeral",
                "realtimeClass": "batch",
                "concurrencyPolicy": "shared",
                "resourceBudget": {}
            }],
            "permissions": {},
            "artifact": {
                "entryPath": ".",
                "command": ".",
                "args": [],
                "cwd": ".",
                "basePath": ".",
                "timeoutMs": 5000
            },
            "security": { "signaturePolicy": "allow-unsigned" }
        }
    });
    let load_line = CString::new(load.to_string()).expect("load line fits");
    let response = emk_request(load_line.as_ptr());
    assert!(!response.is_null(), "load must succeed");
    let response_text = unsafe { CStr::from_ptr(response) }.to_string_lossy().to_string();
    emk_string_free(response);
    assert!(response_text.contains("security"), "got: {response_text}");

    let activate = CString::new(
        json!({
            "kind": "request",
            "id": "2",
            "method": "kernel.activate",
            "params": { "extensionId": "demo.dataplane.latency", "context": {} }
        })
        .to_string(),
    )
    .expect("activate line fits");
    let response = emk_request(activate.as_ptr());
    assert!(!response.is_null(), "activate must succeed");
    emk_string_free(response);

    let extension_id = CString::new("demo.dataplane.latency").expect("id fits");
    let handle = emk_handle_resolve(extension_id.as_ptr());
    assert_ne!(handle, 0, "handle must resolve");

    let request = br#"{"capability":"dataplane","input":{"v":1}}"#;
    let mut output = [0_u8; 256];

    for _ in 0..2_000 {
        let written = emk_invoke_ptr(
            handle,
            request.as_ptr(),
            request.len(),
            output.as_mut_ptr(),
            output.len(),
        );
        assert!(written > 0);
    }

    const ITERATIONS: usize = 30_000;
    let mut samples: Vec<u128> = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let start = Instant::now();
        let written = emk_invoke_ptr(
            handle,
            request.as_ptr(),
            request.len(),
            output.as_mut_ptr(),
            output.len(),
        );
        let elapsed = start.elapsed();
        assert!(written > 0);
        samples.push(elapsed.as_nanos());
    }

    let p50 = percentile(&mut samples, 0.50);
    let p90 = percentile(&mut samples, 0.90);
    let p99 = percentile(&mut samples, 0.99);
    let p999 = percentile(&mut samples, 0.999);
    let mean: u128 = samples.iter().sum::<u128>() / samples.len() as u128;
    let max = *samples.last().expect("samples non-empty");

    println!("data-plane per-call tax over {ITERATIONS} iterations:");
    println!("  P50  = {p50:>6} ns");
    println!("  P90  = {p90:>6} ns");
    println!("  P99  = {p99:>6} ns");
    println!("  P999 = {p999:>6} ns");
    println!("  mean = {mean:>6} ns");
    println!("  max  = {max:>6} ns");

    emk_handle_release(handle);

    // CI-safe guard; the acceptance number is the printed P99 (target ≤ 5 000 ns).
    assert!(
        p99 < 50_000,
        "P99 data-plane tax {p99} ns exceeded the 50 µs regression guard"
    );
}

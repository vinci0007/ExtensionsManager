//! Frame-budget simulation for high-refresh hosts (360 Hz / 500 fps class).
//!
//! Per simulated frame: 20 loaded in-process wasm plugins each receive one
//! ext_tick batch through the C ABI data plane (the exact path a game host
//! drives per tick). Measures the distribution of the FULL per-frame
//! infrastructure cost (host loop + kernel mutex + wasm calls), plugin logic
//! excluded (static-response guests).
//!
//! Budget context: 360 Hz = 2.78 ms/frame, 500 fps = 2.00 ms/frame.
//! Run release for acceptance numbers:
//!   cargo test -p extensions-kernel --release --test frame_budget -- --nocapture

use extensions_kernel::capi::{
    emk_handle_release, emk_handle_resolve, emk_request, emk_string_free, emk_tick_ptr,
};
use serde_json::json;
use std::ffi::{CStr, CString};
use std::path::{Path, PathBuf};
use std::time::Instant;

const ECHO_WAT: &str = r#"
(module
  (memory (export "memory") 1)
  (data (i32.const 4096) "{\"tick\":true,\"entry\":\"tick\"}")
  (func (export "ext_tick") (param $in_ptr i32) (param $in_len i32) (result i64)
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.const 4096)) (i64.const 32))
      (i64.extend_i32_u (i32.const 26)))))
"#;

const PLUGIN_COUNT: usize = 20;
const WARMUP_FRAMES: usize = 1_000;
const MEASURED_FRAMES: usize = 10_000;

fn percentile(samples: &mut Vec<u128>, fraction: f64) -> u128 {
    samples.sort_unstable();
    let index = ((samples.len() as f64 - 1.0) * fraction).round() as usize;
    samples[index.min(samples.len() - 1)]
}

#[test]
fn frame_budget_20_plugins_at_high_refresh() {
    let mut plugin_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    plugin_dir.push("../../.tmp/phase2-tests");
    std::fs::create_dir_all(&plugin_dir).expect("tmp dir");
    let plugin_path = plugin_dir.join("frame-budget.wat");
    std::fs::write(&plugin_path, ECHO_WAT).expect("guest module should be written");
    let entry = plugin_path.to_string_lossy().replace("\\\\?\\", "");

    let load_line = CString::new(
        json!({
            "kind": "request",
            "id": "1",
            "method": "kernel.load",
            "params": {
                "manifest": {
                    "id": "demo.frame-budget",
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
        })
        .to_string(),
    )
    .expect("load line fits");
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
            "params": { "extensionId": "demo.frame-budget", "context": {} }
        })
        .to_string(),
    )
    .expect("activate line fits");
    let response = emk_request(activate.as_ptr());
    assert!(!response.is_null(), "activate must succeed");
    emk_string_free(response);

    // 20 DISTINCT extensions (independent load/activate/handle) — the honest
    // multi-plugin shape. resolve_handle maps one handle per extension id.
    let handles: Vec<u64> = (0..PLUGIN_COUNT)
        .map(|index| {
            let id = format!("demo.frame-budget-{index}");
            let load = CString::new(
                json!({
                    "kind": "request",
                    "id": format!("load-{index}"),
                    "method": "kernel.load",
                    "params": {
                        "manifest": {
                            "id": id,
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
                })
                .to_string(),
            )
            .expect("load line fits");
            let response = emk_request(load.as_ptr());
            assert!(!response.is_null(), "load {index} must succeed");
            emk_string_free(response);

            let activate = CString::new(
                json!({
                    "kind": "request",
                    "id": format!("act-{index}"),
                    "method": "kernel.activate",
                    "params": { "extensionId": id, "context": {} }
                })
                .to_string(),
            )
            .expect("activate line fits");
            let response = emk_request(activate.as_ptr());
            assert!(!response.is_null(), "activate {index} must succeed");
            emk_string_free(response);

            let id_c = CString::new(id).expect("id fits");
            let handle = emk_handle_resolve(id_c.as_ptr());
            assert_ne!(handle, 0, "handle {index} must resolve");
            handle
        })
        .collect();

    let batch = br#"{"ticks":[{"dtMs":2.0}]}"#;
    let mut output = [0_u8; 256];

    // Warm-up: JIT/caches/page faults.
    for _ in 0..WARMUP_FRAMES {
        for handle in &handles {
            let written = emk_tick_ptr(*handle, batch.as_ptr(), batch.len(), output.as_mut_ptr(), output.len());
            assert!(written > 0);
        }
    }

    let mut frame_samples: Vec<u128> = Vec::with_capacity(MEASURED_FRAMES);
    for _ in 0..MEASURED_FRAMES {
        let start = Instant::now();
        for handle in &handles {
            let written = emk_tick_ptr(*handle, batch.as_ptr(), batch.len(), output.as_mut_ptr(), output.len());
            assert!(written > 0);
        }
        frame_samples.push(start.elapsed().as_nanos());
    }

    let p50 = percentile(&mut frame_samples, 0.50);
    let p90 = percentile(&mut frame_samples, 0.90);
    let p99 = percentile(&mut frame_samples, 0.99);
    let p999 = percentile(&mut frame_samples, 0.999);
    let max = *frame_samples.last().expect("samples non-empty");
    let mean: u128 = frame_samples.iter().sum::<u128>() / frame_samples.len() as u128;

    println!("per-frame infra cost, {PLUGIN_COUNT} distinct plugins x 1 tick each, {MEASURED_FRAMES} frames:");
    println!("  P50  = {p50:>6} ns");
    println!("  P90  = {p90:>6} ns");
    println!("  P99  = {p99:>6} ns");
    println!("  P999 = {p999:>6} ns");
    println!("  mean = {mean:>6} ns");
    println!("  max  = {max:>6} ns");
    println!(
        "  budget share @360Hz (2.78 ms frame): P99 = {:.3}%",
        p99 as f64 / 2_780_000.0 * 100.0
    );
    println!(
        "  budget share @500fps (2.00 ms frame): P99 = {:.3}%",
        p99 as f64 / 2_000_000.0 * 100.0
    );

    for handle in &handles {
        emk_handle_release(*handle);
    }

    // CI-safe regression guard; the printed percentiles are the acceptance data.
    // Debug-mode wasmtime calls cost ~10-20x release, so the guard is
    // profile-aware (the acceptance bar is the release P99).
    let guard_ns: u128 = if cfg!(debug_assertions) { 500_000 } else { 50_000 };
    assert!(
        p99 < guard_ns,
        "20-plugin per-frame P99 {} ns exceeded the {} µs regression guard",
        p99,
        guard_ns / 1000
    );
}

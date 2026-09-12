//! Phase 3: the `ext_tick` batch entry routes through `emk_tick_ptr`.
//!
//! Kept in its own integration-test binary so its process-global kernel state and
//! fuel configuration cannot race with the runaway-isolation test.

use extensions_kernel::capi::{emk_handle_release, emk_handle_resolve, emk_tick_ptr};
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::path::PathBuf;

/// Healthy echo guest with both ext_call and ext_tick entries.
const HEALTHY_WAT: &str = r#"
(module
  (memory (export "memory") 1)
  (data (i32.const 4096) "{\"echo\":true,\"entry\":\"call\"}")
  (data (i32.const 8192) "{\"echo\":true,\"entry\":\"tick\"}")
  (func (export "ext_call") (param $in_ptr i32) (param $in_len i32) (result i64)
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.const 4096)) (i64.const 32))
      (i64.extend_i32_u (i32.const 26))))
  (func (export "ext_tick") (param $in_ptr i32) (param $in_len i32) (result i64)
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.const 8192)) (i64.const 32))
      (i64.extend_i32_u (i32.const 26)))))
"#;

fn project_tmp() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../.tmp/phase3-tests");
    let _ = std::fs::create_dir_all(&path);
    path.canonicalize().expect("tmp dir should resolve")
}

#[test]
fn ext_tick_batch_entry_routes_through_c_abi() {
    let plugin_path = project_tmp().join("healthy-tick.wat");
    std::fs::write(&plugin_path, HEALTHY_WAT).expect("guest module should be written");
    let entry = plugin_path.to_string_lossy().replace("\\\\?\\", "");

    let load = json!({
        "kind": "request",
        "id": "1",
        "method": "kernel.load",
        "params": {
            "manifest": {
                "id": "demo.sched.tick",
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
    let response = emk_load_and_activate(&load_line);

    let activate = CString::new(
        json!({
            "kind": "request",
            "id": "2",
            "method": "kernel.activate",
            "params": { "extensionId": "demo.sched.tick", "context": {} }
        })
        .to_string(),
    )
    .expect("activate line fits");
    let _ = emk_load_and_activate(&activate);
    let _ = response;

    let extension_id = CString::new("demo.sched.tick").expect("id fits");
    let handle = emk_handle_resolve(extension_id.as_ptr());
    assert_ne!(handle, 0, "handle should resolve");

    let batch = br#"{"ticks":[{"dtMs":16}]}"#;
    let mut output = [0_u8; 256];
    let written = emk_tick_ptr(
        handle,
        batch.as_ptr(),
        batch.len(),
        output.as_mut_ptr(),
        output.len(),
    );
    assert!(written > 0, "tick should write response bytes");
    let response = std::str::from_utf8(&output[..written as usize]).expect("utf8");
    assert!(response.contains("tick"), "got: {response}");

    emk_handle_release(handle);
}

fn emk_load_and_activate(line: &CString) -> String {
    let response = unsafe {
        let raw = extensions_kernel::capi::emk_request(line.as_ptr());
        assert!(!raw.is_null(), "kernel request must succeed");
        CStr::from_ptr(raw).to_string_lossy().to_string()
    };
    response
}

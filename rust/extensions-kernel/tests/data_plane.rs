//! Phase 2 data-plane tests: in-process wasm runtime.
//!
//! Guest modules are compiled from `.wat` text written into the project's `.tmp`
//! directory (never outside the project), then driven through the kernel envelope
//! flow and the C ABI data-plane entry.

use extensions_kernel::capi::{
    emk_handle_release, emk_handle_resolve, emk_invoke_ptr, emk_last_error, emk_request,
    emk_string_free,
};
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::path::PathBuf;

/// Guest with the byte fast path: echoes a fixed JSON response through linear memory.
/// Response payload lives at offset 4096 (41 bytes), safely inside the first page and
/// clear of the host input region at offset 0.
const ECHO_WAT: &str = r#"
(module
  (memory (export "memory") 1)
  (data (i32.const 4096) "{\"echo\":true,\"len_note\":\"from dataplane\"}")
  (func (export "ext_call") (param $in_ptr i32) (param $in_len i32) (result i64)
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.const 4096)) (i64.const 32))
      (i64.extend_i32_u (i32.const 41)))))
"#;

/// Guest that declares more linear memory than the runtime quota allows.
const OVERQUOTA_WAT: &str = r#"
(module
  (memory (export "memory") 300))
"#;

fn project_tmp() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../.tmp/phase2-tests");
    let _ = std::fs::create_dir_all(&path);
    path.canonicalize().expect("tmp dir should resolve")
}

fn write_guest(name: &str, wat: &str) -> String {
    let path = project_tmp().join(name);
    std::fs::write(&path, wat).expect("guest module should be written");
    path.to_string_lossy().replace("\\\\?\\", "")
}

fn request_json(value: Value) -> Result<String, String> {
    let line = CString::new(value.to_string()).expect("request should not contain interior NUL");
    let response = emk_request(line.as_ptr());
    if response.is_null() {
        let error = emk_last_error();
        let message = if error.is_null() {
            "(no error recorded)".to_string()
        } else {
            unsafe { CStr::from_ptr(error) }.to_string_lossy().to_string()
        };
        return Err(message);
    }
    let owned = unsafe { CStr::from_ptr(response) }.to_string_lossy().to_string();
    emk_string_free(response);
    Ok(owned)
}

fn load_wasm_guest(extension_id: &str, entry_path: &str) {
    let load = json!({
        "kind": "request",
        "id": "1",
        "method": "kernel.load",
        "params": {
            "manifest": {
                "id": extension_id,
                "version": "1.0.0",
                "protocolVersion": "1",
                "artifact": { "kind": "wasm", "entry": "./plugin.wat" },
                "runtime": "wasm",
                "capabilities": [{ "name": "dataplane" }]
            },
            "runtime": {
                "kind": "wasm",
                "entryPath": entry_path,
                "cwd": "."
            },
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
                "entryPath": entry_path,
                "command": entry_path,
                "args": [],
                "cwd": ".",
                "basePath": ".",
                "timeoutMs": 5000
            },
            "security": { "signaturePolicy": "allow-unsigned" }
        }
    });
    let response = request_json(load).expect("wasm load should succeed through the C ABI");
    assert!(response.contains("security"), "got: {response}");

    let activate = json!({
        "kind": "request",
        "id": "2",
        "method": "kernel.activate",
        "params": { "extensionId": extension_id, "context": {} }
    });
    let response = request_json(activate).expect("wasm activate should succeed");
    assert!(response.contains("true"), "got: {response}");
}

#[test]
fn byte_fast_path_round_trips_arbitrary_json() {
    let entry = write_guest("echo.wat", ECHO_WAT);
    load_wasm_guest("demo.dataplane.echo", &entry);

    let invoke = json!({
        "kind": "request",
        "id": "3",
        "method": "kernel.invoke",
        "params": {
            "extensionId": "demo.dataplane.echo",
            "capability": "dataplane",
            "input": { "anything": [1, 2, 3], "nested": { "ok": true } }
        }
    });
    let response = request_json(invoke).expect("byte-path invoke should succeed");
    assert!(response.contains("echo"), "got: {response}");
    assert!(response.contains("from dataplane"), "got: {response}");

    emk_handle_release(0);
}

#[test]
fn memory_quota_rejects_oversized_guest() {
    let entry = write_guest("overquota.wat", OVERQUOTA_WAT);
    let load = json!({
        "kind": "request",
        "id": "1",
        "method": "kernel.load",
        "params": {
            "manifest": {
                "id": "demo.dataplane.overquota",
                "version": "1.0.0",
                "protocolVersion": "1",
                "artifact": { "kind": "wasm", "entry": "./plugin.wat" },
                "runtime": "wasm",
                "capabilities": [{ "name": "dataplane" }]
            },
            "runtime": {
                "kind": "wasm",
                "entryPath": entry,
                "cwd": "."
            },
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
    request_json(load).expect("load admission itself should succeed");

    let activate = json!({
        "kind": "request",
        "id": "2",
        "method": "kernel.activate",
        "params": { "extensionId": "demo.dataplane.overquota", "context": {} }
    });
    let error = request_json(activate)
        .expect_err("activation must fail: 300 pages exceeds the 256-page quota");
    assert!(
        error.contains("memory limits") || error.contains("instantiate"),
        "activation failure should name the quota problem: {error}"
    );
}

#[test]
fn c_abi_data_plane_invoke_and_handle_errors() {
    let entry = write_guest("echo2.wat", ECHO_WAT);
    load_wasm_guest("demo.dataplane.cabi", &entry);

    let extension_id = CString::new("demo.dataplane.cabi").expect("id fits");
    let handle = emk_handle_resolve(extension_id.as_ptr());
    assert_ne!(handle, 0, "handle should resolve for a loaded extension");

    let request = br#"{"capability":"dataplane","input":{"n":1}}"#;
    let mut output = [0_u8; 256];
    let written = emk_invoke_ptr(
        handle,
        request.as_ptr(),
        request.len(),
        output.as_mut_ptr(),
        output.len(),
    );
    assert!(written > 0, "data-plane invoke should write response bytes");
    let response = std::str::from_utf8(&output[..written as usize]).expect("utf8 response");
    assert!(response.contains("echo"), "got: {response}");

    // Unknown handle: -1 plus a recorded transport-level error.
    let failed = emk_invoke_ptr(
        999,
        request.as_ptr(),
        request.len(),
        output.as_mut_ptr(),
        output.len(),
    );
    assert_eq!(failed, -1);
    let error = emk_last_error();
    assert!(!error.is_null(), "failed invoke should record an error");

    emk_handle_release(handle);
    emk_handle_release(handle);
}

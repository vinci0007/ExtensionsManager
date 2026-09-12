//! C ABI contract tests (Phase 1 skeleton).
//!
//! These exercise the exported functions through their `extern "C"` signatures against
//! the real process-runtime fixture plugin in `examples/process-extension`, with no
//! temporary files: everything resolves inside the project directory.

use extensions_kernel::capi::{
    emk_abi_version, emk_last_error, emk_request, emk_reset, emk_string_free,
};
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::path::Path;

fn project_root() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("project root should resolve");
    let text = path.to_string_lossy().to_string();
    // canonicalize() returns \\?\-prefixed paths on Windows; that prefix disables path
    // normalization and breaks CreateProcessW current_dir when combined with other
    // separators, so strip it.
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
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

#[test]
fn abi_version_is_one() {
    assert_eq!(emk_abi_version(), 1);
}

#[test]
fn null_request_fails_with_recorded_error() {
    let response = emk_request(std::ptr::null());
    assert!(response.is_null());
    let error = emk_last_error();
    assert!(!error.is_null());
    let message = unsafe { CStr::from_ptr(error) }.to_string_lossy().to_string();
    assert!(message.contains("null"), "unexpected error: {message}");
}

#[test]
fn malformed_json_fails_with_recorded_error() {
    let line = CString::new("{ this is not json").expect("static string fits");
    let response = emk_request(line.as_ptr());
    assert!(response.is_null(), "malformed JSON must return NULL");
    let error = emk_last_error();
    assert!(!error.is_null());
    let message = unsafe { CStr::from_ptr(error) }.to_string_lossy().to_string();
    assert!(
        message.contains("invalid kernel request"),
        "error should name the malformed request: {message}"
    );
}

#[test]
fn unknown_method_returns_error_envelope_not_null() {
    let response = request_json(json!({
        "kind": "request",
        "id": "u1",
        "method": "kernel.doesNotExist",
        "params": {}
    }))
    .expect("unknown methods are kernel-level errors, not transport failures");
    assert!(response.contains("KERNEL_UNKNOWN_METHOD"), "got: {response}");
}

#[test]
fn load_activate_invoke_round_trip_through_c_abi() {
    let plugin_dir = format!("{}/examples/process-extension", project_root());

    let load = json!({
        "kind": "request",
        "id": "1",
        "method": "kernel.load",
        "params": {
            "manifest": {
                "id": "demo.cabi-roundtrip",
                "version": "1.0.0",
                "protocolVersion": "1",
                "artifact": { "kind": "module", "entry": "./plugin.mjs" },
                "runtime": "process",
                "capabilities": [{ "name": "demo.hello" }]
            },
            "runtime": {
                "kind": "process",
                "command": "node",
                "args": ["./plugin.mjs"],
                "cwd": plugin_dir
            },
            "capabilities": [{
                "name": "demo.hello",
                "interactionMode": "unary",
                "executionMode": "ephemeral",
                "realtimeClass": "batch",
                "concurrencyPolicy": "shared",
                "resourceBudget": {}
            }],
            "permissions": {},
            "artifact": {
                "entryPath": "./plugin.mjs",
                "command": "node",
                "args": ["./plugin.mjs"],
                "cwd": plugin_dir,
                "basePath": plugin_dir,
                "timeoutMs": 10000
            },
            "security": { "signaturePolicy": "allow-unsigned" }
        }
    });
    let load_response = request_json(load).expect("load should succeed through the C ABI");
    assert!(load_response.contains("security"), "got: {load_response}");

    let activate_response = request_json(json!({
        "kind": "request",
        "id": "2",
        "method": "kernel.activate",
        "params": {
            "extensionId": "demo.cabi-roundtrip",
            "context": { "extensionId": "demo.cabi-roundtrip" }
        }
    }))
    .expect("activate should spawn the plugin process");
    assert!(activate_response.contains("true"), "got: {activate_response}");

    let invoke_response = request_json(json!({
        "kind": "request",
        "id": "3",
        "method": "kernel.invoke",
        "params": {
            "extensionId": "demo.cabi-roundtrip",
            "capability": "demo.hello",
            "input": { "name": "cabi" }
        }
    }))
    .expect("invoke should round-trip the plugin");
    assert!(
        invoke_response.contains("hello from process extension"),
        "got: {invoke_response}"
    );

    emk_reset();
}

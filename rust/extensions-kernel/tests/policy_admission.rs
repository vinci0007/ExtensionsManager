//! Phase A policy-engine tests: `kernel.policy.set`, fuel derivation,
//! load-time admission against tier caps, and the frame-budget end-to-end.
//!
//! The C ABI kernel is a process-global singleton, so every test serializes on
//! a mutex and (re)sets its own policy inside the critical section.

use extensions_kernel::capi::{
    emk_handle_release, emk_handle_resolve, emk_invoke_ptr, emk_last_error, emk_request,
    emk_string_free,
};
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::path::{PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Instant;

const SPIN_WAT: &str = r#"
(module
  (memory (export "memory") 1)
  (func (export "ext_call") (param $in_ptr i32) (param $in_len i32) (result i64)
    (loop $l (br $l))
    (i64.const 0)))
"#;

fn kernel_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().expect("kernel test lock")
}

fn project_tmp() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../.tmp/policy-tests");
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

fn policy_set(policy: Value) -> String {
    let request = json!({
        "kind": "request",
        "id": "policy",
        "method": "kernel.policy.set",
        "params": policy
    });
    request_json(request).expect("policy.set should succeed")
}

fn load_guest_with_override(extension_id: &str, entry_path: &str, memory_mb: Option<u64>, realtime_class: &str, consent_override: bool) -> Result<String, String> {
    let mut request = serde_json::from_str::<serde_json::Value>(&load_request_body(extension_id, entry_path, memory_mb, realtime_class))
        .expect("load request body should be valid JSON");
    request["params"]["consentOverride"] = json!(consent_override);
    request_json(request)
}

fn load_request_body(extension_id: &str, entry_path: &str, memory_mb: Option<u64>, realtime_class: &str) -> String {
    let capabilities = json!([{ "name": "dataplane" }]);
    let mut capability = capabilities[0].as_object().expect("capability object").clone();
    capability.insert("realtimeClass".to_string(), json!(realtime_class));
    if let Some(memory_mb) = memory_mb {
        capability.insert("resourceBudget".to_string(), json!({ "memoryMb": memory_mb }));
    }

    json!({
        "kind": "request",
        "id": "load",
        "method": "kernel.load",
        "params": {
            "manifest": {
                "id": extension_id,
                "version": "1.0.0",
                "protocolVersion": "1",
                "artifact": { "kind": "module", "entry": "./index.js" },
                "runtime": "process",
                "capabilities": [capability]
            },
            "runtime": {
                "kind": "remote",
                "endpoint": "local-supervisor",
                "transport": "process"
            },
            "capabilities": [{
                "name": "dataplane",
                "interactionMode": "unary",
                "executionMode": "ephemeral",
                "realtimeClass": realtime_class,
                "concurrencyPolicy": "shared",
                "resourceBudget": memory_mb.map(|mb| json!({ "memoryMb": mb })).unwrap_or(json!({}))
            }],
            "permissions": {},
            "artifact": {
                "entryPath": "./index.js",
                "command": "node",
                "args": ["./index.js"],
                "cwd": ".",
                "basePath": ".",
                "timeoutMs": 5000
            },
            "security": { "signaturePolicy": "allow-unsigned" }
        }
    })
    .to_string()
}

fn load_guest(extension_id: &str, entry_path: &str, memory_mb: Option<u64>, realtime_class: &str) -> Result<String, String> {
    let mut capability = json!({ "name": "dataplane" })
        .as_object()
        .expect("capability object")
        .clone();
    capability.insert("realtimeClass".to_string(), json!(realtime_class));
    if let Some(memory_mb) = memory_mb {
        capability.insert("resourceBudget".to_string(), json!({ "memoryMb": memory_mb }));
    }

    let load = json!({
        "kind": "request",
        "id": "load",
        "method": "kernel.load",
        "params": {
            "manifest": {
                "id": extension_id,
                "version": "1.0.0",
                "protocolVersion": "1",
                "artifact": { "kind": "wasm", "entry": "./plugin.wat" },
                "runtime": "wasm",
                "capabilities": [capability]
            },
            "runtime": { "kind": "wasm", "entryPath": entry_path, "cwd": "." },
            "capabilities": [{
                "name": "dataplane",
                "interactionMode": "unary",
                "executionMode": "ephemeral",
                "realtimeClass": realtime_class,
                "concurrencyPolicy": "shared",
                "resourceBudget": memory_mb.map(|mb| json!({ "memoryMb": mb })).unwrap_or(json!({}))
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
    request_json(load)
}

fn activate(extension_id: &str) -> Result<String, String> {
    request_json(json!({
        "kind": "request",
        "id": "activate",
        "method": "kernel.activate",
        "params": { "extensionId": extension_id, "context": {} }
    }))
}

#[test]
fn policy_set_returns_calibration_and_derivation() {
    let _guard = kernel_lock();

    let response = policy_set(json!({
        "frame": { "tickHz": 500.0, "pluginSharePct": 5.0 }
    }));
    let parsed: Value = serde_json::from_str(&response).expect("valid JSON response");
    let ns_per_fuel = parsed["result"]["nsPerFuel"].as_f64().expect("nsPerFuel");
    assert!(ns_per_fuel > 0.0 && ns_per_fuel < 100.0, "plausible ns per fuel: {ns_per_fuel}");
    let fuel_per_call = parsed["result"]["fuelPerCall"].as_u64().expect("fuelPerCall");
    // 2 ms frame × 5% share = 100 µs; fuel ≈ 100_000 / ns_per_fuel.
    let expected = (100_000.0 / ns_per_fuel) as u64;
    assert!(
        fuel_per_call >= expected / 2 && fuel_per_call <= expected * 2,
        "derived fuel {fuel_per_call} should track the 100 µs share (expected ≈ {expected})"
    );

    // Explicit override wins over derivation.
    let response = policy_set(json!({
        "frame": { "tickHz": 500.0, "pluginSharePct": 5.0 },
        "fuel": { "perCallOverride": 123_456 }
    }));
    let parsed: Value = serde_json::from_str(&response).expect("valid JSON");
    assert_eq!(parsed["result"]["fuelPerCall"].as_u64(), Some(123_456));
}

#[test]
fn admission_rejects_over_tier_declaration_and_daemon_survives() {
    let _guard = kernel_lock();

    policy_set(json!({
        "memory": { "tiers": { "realtimeMb": 32 } }
    }));

    let entry = write_guest("policy-echo.wat", SPIN_WAT);
    // Over-tier declarations are now CONSENTABLE: the kernel asks for consent
    // (KERNEL_CONSENT_REQUIRED) instead of flat-out rejecting.
    let consent = load_guest("demo.policy.over", &entry, Some(64), "realtime")
        .expect("consent request arrives as an error envelope");
    assert!(
        consent.contains("KERNEL_CONSENT_REQUIRED") && consent.contains("32 MB"),
        "got: {consent}"
    );

    // Daemon stays operational: a within-cap load succeeds afterwards.
    let allowed = load_guest("demo.policy.within", &entry, Some(16), "realtime")
        .expect("16 MB fits the 32 MB realtime tier cap");
    assert!(allowed.contains("security"), "got: {allowed}");
}

#[test]
fn policy_without_tiers_falls_back_to_the_default_cap() {
    let _guard = kernel_lock();

    // A policy with a frame section but no memory tiers: tier caps fall back to
    // the safe default (16 MiB / 256 pages), so an oversized declaration is
    // still gated.
    policy_set(json!({ "frame": { "tickHz": 60.0 } }));

    let entry = write_guest("policy-fallback.wat", SPIN_WAT);
    let consent = load_guest("demo.policy.fallback", &entry, Some(4096), "batch")
        .expect("consent request arrives as an error envelope");
    assert!(
        consent.contains("KERNEL_CONSENT_REQUIRED") && consent.contains("16 MB"),
        "got: {consent}"
    );

    // A declaration within the fallback cap loads cleanly.
    let allowed = load_guest("demo.policy.fallback-within", &entry, Some(8), "batch")
        .expect("8 MB fits the 16 MiB fallback cap");
    assert!(allowed.contains("security"), "got: {allowed}");
}

#[test]
fn frame_budget_derived_fuel_traps_runaway_within_budget() {
    let _guard = kernel_lock();

    // 500 fps, 0.5% share → a 10 µs slice per plugin per tick. The spin guest
    // must be cut short by the derived fuel within (far under) one frame.
    policy_set(json!({
        "frame": { "tickHz": 500.0, "pluginSharePct": 0.5 }
    }));

    let entry = write_guest("policy-spin.wat", SPIN_WAT);
    load_guest("demo.policy.frame", &entry, None, "batch").expect("load should succeed");
    activate("demo.policy.frame").expect("activate should succeed");

    let id = CString::new("demo.policy.frame").expect("id fits");
    let handle = emk_handle_resolve(id.as_ptr());
    assert_ne!(handle, 0, "handle must resolve");

    let request = br#"{"capability":"dataplane","input":{}}"#;
    let mut output = [0_u8; 64];
    let start = Instant::now();
    let written = emk_invoke_ptr(
        handle,
        request.as_ptr(),
        request.len(),
        output.as_mut_ptr(),
        output.len(),
    );
    let elapsed = start.elapsed();
    assert_eq!(written, -1, "runaway call must fail");

    let error = emk_last_error();
    let message = unsafe { CStr::from_ptr(error) }.to_string_lossy().to_string();
    assert!(message.contains("fuel budget"), "got: {message}");
    // 10 µs slice; allow generous machine variance but far below one 2 ms frame.
    assert!(
        elapsed.as_micros() < 1_000,
        "runaway call should trap near its slice, took {elapsed:?}"
    );
    println!("derived-slice runaway trap elapsed: {elapsed:?}");

    emk_handle_release(handle);
}

#[test]
fn consent_override_admits_the_declaration_and_is_audited() {
    let _guard = kernel_lock();

    policy_set(json!({
        "memory": { "tiers": { "realtimeMb": 32 } }
    }));

    let body = load_request_body("demo.policy.consent-override", "./index.js", Some(64), "realtime");
    let mut request = serde_json::from_str::<serde_json::Value>(&body).expect("valid body");
    request["params"]["consentOverride"] = json!(true);

    let line = CString::new(request.to_string()).expect("line fits");
    let response = emk_request(line.as_ptr());
    assert!(!response.is_null(), "consented load must succeed");
    let response_text = unsafe { CStr::from_ptr(response) }.to_string_lossy().to_string();
    emk_string_free(response);
    assert!(response_text.contains("security"), "got: {response_text}");

    // The override decision is recorded in the audit log.
    let audit_line = CString::new(
        json!({
            "kind": "request",
            "id": "audit",
            "method": "kernel.audit.query",
            "params": { "sinceSeq": 0, "limit": 1024 }
        })
        .to_string(),
    )
    .expect("audit line fits");
    let audit_response = emk_request(audit_line.as_ptr());
    assert!(!audit_response.is_null());
    let audit_text = unsafe { CStr::from_ptr(audit_response) }.to_string_lossy().to_string();
    emk_string_free(audit_response);
    assert!(
        audit_text.contains("policy.consent_override") && audit_text.contains("host-approved policy exception"),
        "audit must record the consent override: {audit_text}"
    );
}

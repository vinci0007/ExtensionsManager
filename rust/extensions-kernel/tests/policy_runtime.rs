//! Phase B policy-engine tests: runtime accounting, bounded audit log,
//! soft/hard memory tiers, and leak ratchet detection.
//!
//! Serialized on the process-global kernel (same constraint as policy_admission).

use extensions_kernel::capi::{
    emk_handle_release, emk_handle_resolve, emk_invoke_ptr, emk_last_error, emk_request, emk_reset,
    emk_string_free, install_global_response_sink,
};
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

const GROW_8_WAT: &str = r#"
(module
  (memory (export "memory") 1)
  (func (export "ext_call") (param $in_ptr i32) (param $in_len i32) (result i64)
    (i64.extend_i32_s (memory.grow (i32.const 8)))))
"#;

const GROW_1_WAT: &str = r#"
(module
  (memory (export "memory") 1)
  (func (export "ext_call") (param $in_ptr i32) (param $in_len i32) (result i64)
    (i64.extend_i32_s (memory.grow (i32.const 1)))))
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
    let line = CString::new(value.to_string()).expect("line fits");
    let response = emk_request(line.as_ptr());
    if response.is_null() {
        let last = unsafe { emk_last_error() };
        let detail = if last.is_null() {
            "unknown".to_string()
        } else {
            unsafe { CStr::from_ptr(last) }.to_string_lossy().to_string()
        };
        return Err(format!("transport-level failure: {detail}"));
    }
    let owned = unsafe { CStr::from_ptr(response) }.to_string_lossy().to_string();
    emk_string_free(response);
    Ok(owned)
}

fn load_guest(extension_id: &str, entry_path: &str, memory_mb: u64) -> String {
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
                "capabilities": [{
                    "name": "dataplane",
                    "realtimeClass": "batch",
                    "resourceBudget": { "memoryMb": memory_mb }
                }]
            },
            "runtime": { "kind": "wasm", "entryPath": entry_path, "cwd": "." },
            "capabilities": [{
                "name": "dataplane",
                "interactionMode": "unary",
                "executionMode": "ephemeral",
                "realtimeClass": "batch",
                "concurrencyPolicy": "shared",
                "resourceBudget": { "memoryMb": memory_mb }
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
    let response = request_json(load).expect("load should succeed");
    assert!(
        !response.contains("\"error\""),
        "load was rejected: {response}"
    );
    response
}

fn activate(extension_id: &str) {
    request_json(json!({
        "kind": "request",
        "id": "activate",
        "method": "kernel.activate",
        "params": { "extensionId": extension_id, "context": {} }
    }))
    .expect("activate should succeed");
}

fn resolve(extension_id: &str) -> u64 {
    let id = CString::new(extension_id).expect("id fits");
    let handle = emk_handle_resolve(id.as_ptr());
    assert_ne!(handle, 0, "handle must resolve: {extension_id}");
    handle
}

fn invoke(handle: u64) -> i64 {
    let request = br#"{"capability":"dataplane","input":{}}"#;
    let mut output = [0_u8; 64];
    emk_invoke_ptr(
        handle,
        request.as_ptr(),
        request.len(),
        output.as_mut_ptr(),
        output.len(),
    )
}

fn audit_query(since_seq: u64, limit: u64) -> Value {
    let response = request_json(json!({
        "kind": "request",
        "id": "audit",
        "method": "kernel.audit.query",
        "params": { "sinceSeq": since_seq, "limit": limit }
    }))
    .expect("audit query should succeed");
    serde_json::from_str(&response).expect("valid audit response")
}

/// Newest audit seq at this moment — used to scope assertions to this test's
/// own entries (the ring is process-global and may hold earlier tests' events).
fn audit_current_seq() -> u64 {
    let audit = audit_query(0, 1);
    audit["result"]["lastSeq"].as_u64().unwrap_or(0)
}

#[test]
fn soft_and_hard_memory_tiers_execute_three_state_semantics() {
    let _guard = kernel_lock();

    // batch tier hard cap 2 MB (32 pages); soft budget declared 1 MB (16 pages).
    policy_set_stub(json!({
        "memory": { "tiers": { "batchMb": 2 } }
    }));

    let marker = audit_current_seq();
    let entry = write_guest("grow8.wat", GROW_8_WAT);
    load_guest("demo.rt.tiers", &entry, 1);
    activate("demo.rt.tiers");
    let handle = resolve("demo.rt.tiers");

    // Call 1: 1 → 9 pages (under soft 16). Returns previous page count 1.
    assert_eq!(invoke(handle), 1);
    // Call 2: 9 → 17 pages: soft breached, hard OK. Returns 9.
    assert_eq!(invoke(handle), 9);
    // Call 3: 17 → 25 pages: still under hard. Returns 17.
    assert_eq!(invoke(handle), 17);
    // Call 4: 25 + 8 = 33 > 32 hard pages → growth denied, guest sees -1.
    assert_eq!(invoke(handle), -1);

    let audit = audit_query(marker, 1024);
    let kinds: Vec<&str> = audit["result"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .filter_map(|entry| entry["kind"].as_str())
        .collect();
    assert!(kinds.contains(&"memory.pressure"), "pressure events: {kinds:?}");
    assert!(kinds.contains(&"memory.growth_denied"), "denial events: {kinds:?}");

    let accounting = &audit["result"]["accounting"];
    let mine = accounting
        .as_array()
        .expect("accounting array")
        .iter()
        .find(|item| item["extensionId"] == "demo.rt.tiers")
        .expect("accounting entry for the tier plugin");
    assert!(
        mine["memorySoftBreaches"].as_u64().unwrap_or(0) >= 1,
        "soft breaches accounted: {mine}"
    );
    assert!(
        mine["memoryGrowthDenials"].as_u64().unwrap_or(0) >= 1,
        "denials accounted: {mine}"
    );

    emk_handle_release(handle);
}

#[test]
fn monotonic_memory_growth_triggers_leak_suspected() {
    let _guard = kernel_lock();

    // This test relies on the DEFAULT policy (16 MiB fallback, no tiers).
    // Tests run in nondeterministic order and policy persists on the global
    // kernel — reset explicitly instead of inheriting another test's tiers.
    policy_set_stub(json!({}));

    let marker = audit_current_seq();
    let entry = write_guest("grow1.wat", GROW_1_WAT);
    // Declare within the 16 MiB fallback cap so admission accepts the plugin
    // (the leak ratchet needs a live instance to observe).
    load_guest("demo.rt.leak", &entry, 8);
    activate("demo.rt.leak");
    let handle = resolve("demo.rt.leak");

    // 1 new high water per call; threshold 32 → fires by call 32.
    for _ in 0..40 {
        let _ = invoke(handle);
    }

    let audit = audit_query(marker, 1024);
    let leak = audit["result"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .find(|entry| entry["kind"] == "leak.suspected")
        .expect("leak.suspected must fire under monotonic growth");
    assert!(
        leak["extensionId"] == "demo.rt.leak",
        "leak event names the plugin: {leak}"
    );
    // Reported exactly once (latched).
    let count = audit["result"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["kind"] == "leak.suspected")
        .count();
    assert_eq!(count, 1, "leak.suspected must be latched");

    emk_handle_release(handle);
}

#[test]
fn audit_events_deliver_through_the_sink() {
    let _guard = kernel_lock();
    emk_reset();
    let sink_rx = install_global_response_sink();

    // Tiny per-call fuel: every spin invoke traps → one fuel.trap audit entry,
    // which must stream to the sink AS IT IS RECORDED (governance alerting).
    policy_set_stub(json!({
        "frame": { "tickHz": 500.0, "pluginSharePct": 0.05 },
        "fuel": { "perCallOverride": 1_000_000 }
    }));

    const SPIN_WAT: &str = r#"
(module
  (memory (export "memory") 1)
  (func (export "ext_call") (param i32) (param i32) (result i64)
    (loop $l (br $l))
    (i64.const 0)))
"#;
    let entry = write_guest("audit-sink-spin.wat", SPIN_WAT);
    load_guest("demo.rt.audit-sink", &entry, 1);
    activate("demo.rt.audit-sink");
    let handle = resolve("demo.rt.audit-sink");

    assert_eq!(invoke(handle), -1, "spin must trap at its fuel budget");

    // The audit event arrives through the sink as an envelope line with the
    // full entry — no polling required.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let envelope = loop {
        match sink_rx.try_recv() {
            Ok(line) if line.contains("\"kind\":\"audit\"") && line.contains("fuel.trap") => break line,
            Ok(_) => continue,
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "audit event never arrived through the sink"
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                panic!("sink disconnected before the audit event was delivered")
            }
        }
    };
    let parsed: Value = serde_json::from_str(&envelope).expect("audit envelope is valid JSON");
    let audit_entry = &parsed["entry"];
    assert_eq!(audit_entry["kind"], "fuel.trap");
    assert_eq!(audit_entry["extensionId"], "demo.rt.audit-sink");
    assert!(audit_entry["seq"].as_u64().unwrap_or(0) > 0);
    assert!(audit_entry["timestampMs"].as_u64().unwrap_or(0) > 0);

    emk_handle_release(handle);
}

#[test]
fn audit_ring_is_bounded_and_query_supports_paging() {
    let _guard = kernel_lock();

    // Tiny per-call fuel: every spin invoke traps → one fuel.trap audit entry.
    policy_set_stub(json!({
        "frame": { "tickHz": 500.0, "pluginSharePct": 0.05 },
        "fuel": { "perCallOverride": 1_000_000 }
    }));

    const SPIN_WAT: &str = r#"
(module
  (memory (export "memory") 1)
  (func (export "ext_call") (param i32) (param i32) (result i64)
    (loop $l (br $l))
    (i64.const 0)))
"#;
    let entry = write_guest("audit-spin.wat", SPIN_WAT);
    load_guest("demo.rt.audit", &entry, 1);
    activate("demo.rt.audit");
    let handle = resolve("demo.rt.audit");

    const TRAPS: usize = 1100;
    for _ in 0..TRAPS {
        assert_eq!(invoke(handle), -1, "spin must trap at its fuel budget");
    }

    // Full query: FIFO keeps the log at capacity.
    let audit = audit_query(0, 4096);
    let entries = audit["result"]["entries"].as_array().expect("entries");
    assert!(
        entries.len() <= 1024,
        "audit ring must stay bounded: {}",
        entries.len()
    );
    assert!(entries.len() >= 1024, "expected a full ring, got {}", entries.len());

    // Paging: sinceSeq skips older entries.
    let mid_seq = entries[entries.len() / 2]["seq"].as_u64().expect("seq");
    let paged = audit_query(mid_seq, 4096);
    let paged_entries = paged["result"]["entries"].as_array().expect("entries");
    assert!(
        paged_entries.iter().all(|entry| entry["seq"].as_u64().unwrap() > mid_seq),
        "paged query must only return newer entries"
    );
    assert!(!paged_entries.is_empty());

    // Accounting reflects the trap storm.
    let accounting = &audit["result"]["accounting"];
    let mine = accounting
        .as_array()
        .expect("accounting array")
        .iter()
        .find(|item| item["extensionId"] == "demo.rt.audit")
        .expect("accounting entry");
    assert!(mine["fuelTraps"].as_u64().unwrap_or(0) >= 1024, "got: {mine}");

    emk_handle_release(handle);
}

fn policy_set_stub(policy: Value) {
    // Caller must already hold the kernel lock (the C ABI kernel is a global singleton).
    let request = json!({
        "kind": "request",
        "id": "policy",
        "method": "kernel.policy.set",
        "params": policy
    });
    let line = CString::new(request.to_string()).expect("policy fits");
    let response = emk_request(line.as_ptr());
    assert!(!response.is_null(), "policy.set must succeed");
    emk_string_free(response);
}

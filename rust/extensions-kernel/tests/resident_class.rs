//! Phase C tests: three citizen classes — resident reservations, fuel
//! floor/ceiling, and the amortization contract.
//!
//! Serialized on the process-global kernel (same constraint as the other
//! policy test files).

use extensions_kernel::capi::{
    emk_handle_release, emk_handle_resolve, emk_invoke_ptr, emk_last_error, emk_request,
    emk_reset, emk_string_free,
};
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

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
    let line = CString::new(value.to_string()).expect("request fits");
    let response = emk_request(line.as_ptr());
    if response.is_null() {
        return Err("transport-level failure".to_string());
    }
    let owned = unsafe { CStr::from_ptr(response) }.to_string_lossy().to_string();
    emk_string_free(response);
    Ok(owned)
}

fn policy_set(policy: Value) {
    let request = json!({
        "kind": "request",
        "id": "policy",
        "method": "kernel.policy.set",
        "params": policy
    });
    request_json(request).expect("policy.set should succeed");
}

fn load_resident(extension_id: &str, entry_path: &str, memory_mb: u64, fuel_per_tick: Option<u64>) -> Result<String, String> {
    let mut resource_budget = json!({ "memoryMb": memory_mb });
    if let Some(fuel) = fuel_per_tick {
        resource_budget["fuelPerTick"] = json!(fuel);
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
                "extensionClass": "resident",
                "artifact": { "kind": "wasm", "entry": "./plugin.wat" },
                "runtime": "wasm",
                "capabilities": [{
                    "name": "dataplane",
                    "realtimeClass": "realtime",
                    "resourceBudget": resource_budget
                }]
            },
            "runtime": { "kind": "wasm", "entryPath": entry_path, "cwd": "." },
            "capabilities": [{
                "name": "dataplane",
                "interactionMode": "unary",
                "executionMode": "ephemeral",
                "realtimeClass": "realtime",
                "concurrencyPolicy": "single",
                "resourceBudget": resource_budget
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

const BURN_WAT: &str = r#"
(module
  (memory (export "memory") 1)
  (func (export "ext_call") (param $in_ptr i32) (param $in_len i32) (result i64)
    (local $i i64)
    (local.set $i (i64.const 200000))
    (loop $l
      (local.set $i (i64.sub (local.get $i) (i64.const 1)))
      (br_if $l (i64.gt_s (local.get $i) (i64.const 0))))
    (i64.const 0)))
"#;

#[test]
fn resident_admission_requires_declaration_and_host_budget() {
    let _guard = kernel_lock();
    // The kernel is a process-global singleton: clear leftover state from any
    // previous test (reservations persist until reset).
    emk_reset();

    // No host memory budget configured → resident is rejected outright.
    policy_set(json!({ "memory": { "tiers": { "realtimeMb": 64 } } }));
    let entry = write_guest("resident-burn.wat", BURN_WAT);
    let rejected = load_resident("demo.rc.nobudget", &entry, 64, None)
        .expect("rejection arrives as an envelope");
    assert!(
        rejected.contains("policy.memory.totalMb"),
        "got: {rejected}"
    );

    // Budget configured but the resident declares no peak → rejected.
    policy_set(json!({ "memory": { "totalMb": 128 } }));
    let rejected = load_resident("demo.rc.nodeclare", &entry, 0, None)
        .expect("rejection arrives as an envelope");
    assert!(
        rejected.contains("must declare resourceBudget.memoryMb"),
        "got: {rejected}"
    );
}

#[test]
fn resident_reservations_admit_competing_plugins_by_budget() {
    let _guard = kernel_lock();
    // The kernel is a process-global singleton: clear leftover state from any
    // previous test (reservations persist until reset).
    emk_reset();

    policy_set(json!({ "memory": { "totalMb": 128 } }));
    let entry = write_guest("resident-a.wat", BURN_WAT);

    // A reserves 64 of 128 MB → admitted.
    let admitted = load_resident("demo.rc.a", &entry, 64, Some(50_000_000))
        .expect("A fits the budget");
    assert!(admitted.contains("security"), "got: {admitted}");
    activate("demo.rc.a");

    // B wants 96 MB: 64 reserved + 96 > 128 → rejected.
    let rejected = load_resident("demo.rc.b", &entry, 96, Some(50_000_000))
        .expect("rejection arrives as an envelope");
    assert!(
        rejected.contains("already reserved by other residents"),
        "got: {rejected}"
    );

    // A re-loads with a smaller peak: reservation released then re-acquired.
    let readmitted = load_resident("demo.rc.a", &entry, 32, Some(50_000_000))
        .expect("A re-load releases 64 MB and reserves 32 MB");
    assert!(readmitted.contains("security"));
    activate("demo.rc.a");

    // B now fits: 32 + 96 = 128 ≤ 128.
    let b_admitted = load_resident("demo.rc.b", &entry, 96, Some(50_000_000))
        .expect("B fits after A shrank");
    assert!(b_admitted.contains("security"), "got: {b_admitted}");
    activate("demo.rc.b");
}

#[test]
fn resident_fuel_floor_guarantees_the_declared_slice() {
    let _guard = kernel_lock();
    // The kernel is a process-global singleton: clear leftover state from any
    // previous test (reservations persist until reset).
    emk_reset();

    // Derived share is tiny (500fps × 0.05% ≈ 1 µs), but the resident declares
    // a 50M-fuel floor → the floor must win over the derivation.
    policy_set(json!({
        "frame": { "tickHz": 500.0, "pluginSharePct": 0.05 },
        "memory": { "totalMb": 128 }
    }));

    let entry = write_guest("resident-spin.wat", SPIN_WAT);
    load_resident("demo.rc.floor", &entry, 32, Some(50_000_000)).expect("load");
    activate("demo.rc.floor");
    let handle = resolve("demo.rc.floor");

    let request = br#"{"capability":"dataplane","input":{}}"#;
    let mut output = [0_u8; 64];
    let start = std::time::Instant::now();
    let written = emk_invoke_ptr(
        handle,
        request.as_ptr(),
        request.len(),
        output.as_mut_ptr(),
        output.len(),
    );
    let elapsed = start.elapsed();
    assert_eq!(written, -1, "spin must trap");
    let error = emk_last_error();
    let message = unsafe { CStr::from_ptr(error) }.to_string_lossy().to_string();
    assert!(message.contains("fuel budget"), "got: {message}");
    // Floor = 50M fuel; at ~1-3 ns/fuel that's roughly 15-50 ms.
    assert!(
        elapsed.as_millis() >= 5,
        "floor must guarantee at least the declared slice, trapped after {elapsed:?}"
    );

    emk_handle_release(handle);
}

const SPIN_WAT: &str = r#"
(module
  (memory (export "memory") 1)
  (func (export "ext_call") (param $in_ptr i32) (param $in_len i32) (result i64)
    (loop $l (br $l))
    (i64.const 0)))
"#;

#[test]
fn amortization_contract_raises_violation_on_sustained_over_slice() {
    let _guard = kernel_lock();
    // The kernel is a process-global singleton: clear leftover state from any
    // previous test (reservations persist until reset).
    emk_reset();

    // Slice declared 20k fuel per tick; no frame policy → ceiling falls back to
    // the 200M default, so the ~0.4M-fuel burn guest exceeds its slice on every
    // call. After 8 consecutive over-slices the contract violation fires.
    policy_set(json!({
        "memory": { "totalMb": 128 }
    }));

    let marker = audit_current_seq();
    let entry = write_guest("resident-burn.wat", BURN_WAT);
    load_resident("demo.rc.contract", &entry, 8, Some(20_000)).expect("load");
    activate("demo.rc.contract");
    let handle = resolve("demo.rc.contract");

    for _ in 0..12 {
        assert_eq!(invoke(handle), 0, "burn guest returns 0");
    }

    let audit = audit_query(marker, 1024);
    let violations = audit["result"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .filter(|entry| entry["kind"] == "contract.violation" && entry["extensionId"] == "demo.rc.contract")
        .count();
    assert!(violations >= 1, "contract.violation must fire: {audit}");

    emk_handle_release(handle);
}

fn audit_current_seq() -> u64 {
    let audit = audit_query(0, 1);
    audit["result"]["lastSeq"].as_u64().unwrap_or(0)
}

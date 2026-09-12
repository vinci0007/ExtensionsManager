//! Scheduler acceptance test: latency isolation.
//!
//! A slow process plugin (100 ms per invoke, boundary runtime) is saturated on
//! the async scheduler pool while the host keeps driving a healthy in-process
//! WASM neighbor on the sync byte data plane. The healthy neighbor's P99 must
//! stay under the frame guard — the acceptance the frame-budget work deferred
//! to this phase.
//!
//! The slow plugin is driven through `kernel.invoke`: with the scheduler
//! enabled every call returns an async ACCEPTED marker in microseconds and the
//! boundary burn happens on a worker thread; the response envelope is later
//! delivered through the installed sink.
//!
//! Serialized on the process-global kernel. Run release for acceptance
//! numbers: cargo test -p extensions-kernel --release --test scheduler_async

use extensions_kernel::capi::{
    emk_handle_release, emk_handle_resolve, emk_invoke_ptr, emk_last_error, emk_request, emk_reset,
    emk_string_free, install_global_response_sink,
};
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn kernel_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(())).lock().expect("kernel lock")
}

fn project_tmp() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../.tmp/scheduler-tests");
    let _ = std::fs::create_dir_all(&path);
    path.canonicalize().expect("tmp dir")
}

fn write_guest(name: &str, wat: &str) -> String {
    let path = project_tmp().join(name);
    std::fs::write(&path, wat).expect("guest write");
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
        return Err(format!("transport failure: {detail}"));
    }
    let owned = unsafe { CStr::from_ptr(response) }.to_string_lossy().to_string();
    emk_string_free(response);
    Ok(owned)
}

/// Loads a PROCESS plugin (the scheduler's async target) that answers invoke
/// requests after `delay_ms` of wall-clock burn.
fn load_process_plugin(extension_id: &str, delay_ms: u64) {
    let plugin_dir = project_tmp().join(extension_id.replace('.', "-"));
    std::fs::create_dir_all(&plugin_dir).expect("plugin dir");
    std::fs::write(std::path::Path::new(&plugin_dir).join("package.json"), "{\"type\":\"module\"}").expect("pkg");
    let script = format!(
        r#"
import readline from 'node:readline'
const rl = readline.createInterface({{ input: process.stdin, output: process.stdout, terminal: false }})
rl.on('line', (line) => {{
  const request = JSON.parse(line)
  if (request.method === 'extension/activate' || request.method === 'extension/invoke') {{
    const deadline = Date.now() + {delay_ms}
    while (Date.now() < deadline) {{ /* burn */ }}
    process.stdout.write(JSON.stringify({{ jsonrpc: '2.0', id: request.id, result: {{ done: true }} }}) + '\n')
    return
  }}
  process.stdout.write(JSON.stringify({{ jsonrpc: '2.0', id: request.id, result: true }}) + '\n')
}})
"#
    );
    std::fs::write(std::path::Path::new(&plugin_dir).join("index.js"), script).expect("script");

    let cwd = plugin_dir.to_string_lossy().replace("\\\\?\\", "");
    let load = json!({
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
                "capabilities": [{ "name": "work" }]
            },
            "runtime": { "kind": "process", "command": "node", "args": ["./index.js"], "cwd": cwd },
            "capabilities": [{ "name": "work", "interactionMode": "unary", "executionMode": "ephemeral", "realtimeClass": "batch", "concurrencyPolicy": "shared", "resourceBudget": {} }],
            "permissions": {},
            "artifact": { "entryPath": "./index.js", "command": "node", "args": ["./index.js"], "cwd": cwd, "basePath": cwd, "timeoutMs": 60000 },
            "security": { "signaturePolicy": "allow-unsigned" }
        }
    });
    request_json(load).expect("process plugin load");
}

/// Loads a healthy WASM neighbor with an ext_call echo (sync data plane).
fn load_wasm_neighbor(extension_id: &str) -> u64 {
    let wat = r#"
(module
  (memory (export "memory") 1)
  (data (i32.const 4096) "{\"ok\":true}")
  (func (export "ext_call") (param i32) (param i32) (result i64)
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.const 4096)) (i64.const 32))
      (i64.extend_i32_u (i32.const 11)))))
"#;
    let entry = write_guest(&format!("{extension_id}.wat"), wat);
    let cwd = project_tmp().to_string_lossy().replace("\\\\?\\", "");
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
                "capabilities": [{ "name": "dataplane" }]
            },
            "runtime": { "kind": "wasm", "entryPath": entry, "cwd": cwd },
            "capabilities": [{ "name": "dataplane", "interactionMode": "unary", "executionMode": "ephemeral", "realtimeClass": "batch", "concurrencyPolicy": "shared", "resourceBudget": {} }],
            "permissions": {},
            "artifact": { "entryPath": ".", "command": ".", "args": [], "cwd": ".", "basePath": ".", "timeoutMs": 5000 },
            "security": { "signaturePolicy": "allow-unsigned" }
        }
    });
    request_json(load).expect("wasm neighbor load");
    activate(extension_id);
    let id = CString::new(extension_id).expect("id");
    let handle = emk_handle_resolve(id.as_ptr());
    assert_ne!(handle, 0);
    handle
}

fn activate(extension_id: &str) {
    request_json(json!({
        "kind": "request",
        "id": "activate",
        "method": "kernel.activate",
        "params": { "extensionId": extension_id, "context": {} }
    }))
    .expect("activate");
}

fn percentile(samples: &mut Vec<u128>, fraction: f64) -> u128 {
    samples.sort_unstable();
    let index = ((samples.len() as f64 - 1.0) * fraction).round() as usize;
    samples[index.min(samples.len() - 1)]
}

/// Scheduler v2: the persistent pool reuses workers across dispatches and the
/// in-flight cap provides structured backpressure (KERNEL_BUSY), with the slot
/// released as soon as the call completes.
#[test]
fn async_scheduler_pool_reuse_and_backpressure() {
    let _guard = kernel_lock();
    emk_reset();
    let sink_rx = install_global_response_sink();

    // queueCap = 1: exactly one async invoke may be in flight at any time.
    request_json(json!({
        "kind": "request",
        "id": "policy",
        "method": "kernel.policy.set",
        "params": { "scheduler": { "asyncPoolThreads": 2, "queueCap": 1 } }
    }))
    .expect("policy.set");

    load_process_plugin("demo.sched.pool", 150);
    activate("demo.sched.pool");

    let dispatch = |id: String| -> String {
        request_json(json!({
            "kind": "request",
            "id": id,
            "method": "kernel.invoke",
            "params": { "extensionId": "demo.sched.pool", "capability": "work", "input": {} }
        }))
        .expect("slow invoke dispatch")
    };

    // First invoke: accepted, a pool worker burns 150 ms.
    let first = dispatch("pool-0".to_string());
    assert!(first.contains("\"accepted\":true"), "first: {first}");

    // Second invoke while the first is in flight: the queue cap is reached,
    // so the call is rejected with the structured KERNEL_BUSY envelope.
    let second = dispatch("pool-1".to_string());
    assert!(second.contains("KERNEL_BUSY"), "second: {second}");

    // The first call completes -> envelope delivered -> in-flight slot freed.
    let mut delivered = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while delivered.len() < 1 && Instant::now() < deadline {
        match sink_rx.try_recv() {
            Ok(envelope) => delivered.push(envelope),
            Err(std::sync::mpsc::TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(5)),
            Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
        }
    }
    assert_eq!(delivered.len(), 1, "expected the first async envelope");
    assert!(delivered[0].contains("\"id\":\"pool-0\""));

    // The SAME pool (not a per-call thread) must accept the next dispatch.
    let third = dispatch("pool-2".to_string());
    assert!(third.contains("\"accepted\":true"), "third after drain: {third}");

    let deadline = Instant::now() + Duration::from_secs(5);
    while delivered.len() < 2 && Instant::now() < deadline {
        match sink_rx.try_recv() {
            Ok(envelope) => delivered.push(envelope),
            Err(std::sync::mpsc::TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(5)),
            Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
        }
    }
    assert_eq!(delivered.len(), 2, "expected the second async envelope");
    assert!(delivered[1].contains("\"id\":\"pool-2\""));
}

#[test]
fn async_scheduler_isolates_slow_plugin_from_wasm_neighbor() {
    let _guard = kernel_lock();
    emk_reset();

    // Install the response sink BEFORE any dispatch: async envelopes (slow
    // plugin responses) arrive here, never through emk_request.
    let sink_rx = install_global_response_sink();

    // Enable the async scheduler (the opt-in under test).
    request_json(json!({
        "kind": "request",
        "id": "policy",
        "method": "kernel.policy.set",
        "params": { "scheduler": { "asyncPoolThreads": 2, "queueCap": 8 } }
    }))
    .expect("policy.set");

    // Slow process plugin: 100 ms per invoke (boundary runtime -> async pool).
    load_process_plugin("demo.sched.slow", 100);
    activate("demo.sched.slow");

    // Healthy WASM neighbor on the sync byte data plane.
    let healthy = load_wasm_neighbor("demo.sched.healthy");

    let request = br#"{"capability":"dataplane","input":{}}"#;
    let mut output = [0_u8; 64];

    // Baseline: healthy P99 with no async pressure.
    let mut baseline = Vec::with_capacity(2_000);
    for _ in 0..2_000 {
        let start = Instant::now();
        let written = emk_invoke_ptr(healthy, request.as_ptr(), request.len(), output.as_mut_ptr(), output.len());
        baseline.push(start.elapsed().as_nanos());
        assert!(written > 0);
    }

    // Drive the slow plugin through kernel.invoke from a helper thread (the
    // "game thread" analog keeps driving the healthy plugin). Each call must
    // come back as an async ACCEPTED marker — microseconds, not 100 ms.
    let slow_invoker = std::thread::spawn(|| {
        let mut accept_ns = Vec::new();
        for i in 0..4 {
            let slow_invoke = json!({
                "kind": "request",
                "id": format!("slow-{i}"),
                "method": "kernel.invoke",
                "params": { "extensionId": "demo.sched.slow", "capability": "work", "input": {} }
            });
            let start = Instant::now();
            let response = request_json(slow_invoke).expect("slow invoke dispatch");
            accept_ns.push(start.elapsed().as_nanos());
            assert!(
                response.contains("\"accepted\":true"),
                "slow invoke {i} did not return the async accept marker, got: {response}"
            );
        }
        accept_ns
    });

    let mut under_pressure = Vec::with_capacity(2_000);
    for _ in 0..2_000 {
        let start = Instant::now();
        let written = emk_invoke_ptr(healthy, request.as_ptr(), request.len(), output.as_mut_ptr(), output.len());
        under_pressure.push(start.elapsed().as_nanos());
        assert!(written > 0);
    }

    let accept_ns = slow_invoker.join().expect("slow invoker thread");
    for (index, ns) in accept_ns.iter().enumerate() {
        assert!(
            *ns < 20_000_000,
            "slow invoke {index} took {ns} ns to ACCEPT — async dispatch regressed to synchronous"
        );
    }

    // Collect the async envelopes: 4 slow calls at ~100 ms, 2 concurrent ->
    // ~200 ms of burn; the delivery must arrive through the sink.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut delivered = Vec::new();
    while delivered.len() < 4 && Instant::now() < deadline {
        match sink_rx.try_recv() {
            Ok(envelope) => delivered.push(envelope),
            Err(std::sync::mpsc::TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(5)),
            Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
        }
    }
    assert_eq!(delivered.len(), 4, "expected 4 async response envelopes on the sink");
    for id in ["slow-0", "slow-1", "slow-2", "slow-3"] {
        let marker = format!("\"id\":\"{id}\"");
        assert!(
            delivered.iter().any(|envelope| envelope.contains(&marker)),
            "missing async response envelope for {id}"
        );
    }

    let baseline_p99 = percentile(&mut baseline, 0.99);
    let pressure_p99 = percentile(&mut under_pressure, 0.99);
    println!("healthy P99 baseline = {baseline_p99} ns");
    println!("healthy P99 under async-slow pressure = {pressure_p99} ns");
    let offset = (pressure_p99 as f64 - baseline_p99 as f64) / baseline_p99.max(1) as f64 * 100.0;
    println!("P99 offset = {offset:.2}%");

    emk_handle_release(healthy);

    // Acceptance: the healthy neighbor's P99 stays under the frame guard while
    // a 100 ms boundary plugin is saturated on the async pool (500 µs debug /
    // 100 µs release, matching the frame-budget test guard).
    let guard_ns = if cfg!(debug_assertions) { 500_000 } else { 100_000 };
    assert!(
        pressure_p99 < guard_ns,
        "healthy P99 under pressure {pressure_p99} ns exceeded the {guard_ns} ns guard"
    );
}

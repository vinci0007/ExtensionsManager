//! In-process WASM plugin runtime (Phase 2 data plane).
//!
//! Replaces the Node bridge child process: guest modules are instantiated directly in
//! the host process via wasmtime, with payload bytes exchanged through linear memory.
//!
//! Guest contract (backward compatible with the removed Node bridge):
//! - Capability exports: a function named after the capability (e.g. `addOne`).
//!   Invoked through the numeric contract: input JSON must be a number or
//!   `{"value": number}`; missing params are filled with 0; the first result is
//!   returned (null when the export has no results).
//! - Optional exports `activate` / `deactivate`: called on extension lifecycle.
//! - Optional import `env.now`: supported as `() -> f64` (epoch millis, mirroring
//!   `Date.now()`) or `() -> i64`. Other imports are rejected.
//!
//! Byte fast path (data plane, opt-in by the guest):
//! - Exports `memory` and `ext_call(in_ptr: i32, in_len: i32) -> i64`.
//!   The host writes the request bytes (JSON `{"capability": ..., "input": ...}`)
//!   at offset 0 and calls `ext_call(0, len)`. The guest writes the response bytes
//!   (JSON) anywhere in linear memory and returns `(out_ptr << 32) | out_len`
//!   as a packed u64 in an i64; a negative return means a guest-side failure.
//!
//! Resource limits: guest linear memory is capped (see `MEMORY_LIMIT_PAGES`) through
//! a store resource limiter, independent of what the module declares.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use wasmtime::{
    Cache, Config, Engine, Extern, Instance, Linker, Memory, Module, Store, TypedFunc, Val,
    ValType,
};

/// Guest linear memory cap: 256 pages = 16 MiB.
pub const MEMORY_LIMIT_PAGES: u64 = 256;
/// Upper bound for data-plane request bytes written into guest memory at offset 0.
pub const INPUT_MAX_BYTES: usize = 1024 * 1024;
/// Per-call fuel budget (deterministic instruction budget): a guest that exhausts it
/// traps instead of hanging the host. Override with `EXTENSIONS_KERNEL_WASM_FUEL`.
pub const DEFAULT_CALL_FUEL: u64 = 200_000_000;

const INPUT_OFFSET: usize = 0;

fn call_fuel() -> u64 {
    static FUEL: OnceLock<u64> = OnceLock::new();
    *FUEL.get_or_init(|| {
        std::env::var("EXTENSIONS_KERNEL_WASM_FUEL")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(DEFAULT_CALL_FUEL)
    })
}

/// Map a guest trap to a friendly error, naming the fuel budget explicitly.
fn trap_error(context: &str, error: wasmtime::Error) -> String {
    let is_out_of_fuel = error
        .chain()
        .any(|cause| {
            matches!(
                cause.downcast_ref::<wasmtime::Trap>(),
                Some(wasmtime::Trap::OutOfFuel)
            )
        })
        || error.to_string().contains("fuel");
    if is_out_of_fuel {
        format!("{context}: guest exceeded its fuel budget (deterministic time slice)")
    } else {
        format!("{context}: {error}")
    }
}

pub struct WasmPlugin {
    store: Store<PluginState>,
    instance: Instance,
    /// Cached typed `ext_call` so the data plane skips per-call signature checks.
    ext_call: Option<TypedFunc<(i32, i32), i64>>,
    /// Optional batch tick entry for frame/tick-driven hosts.
    ext_tick: Option<TypedFunc<(i32, i32), i64>>,
    memory: Option<Memory>,
    /// Policy-derived per-call fuel budget. None → fall back to the env/default
    /// constant (`call_fuel()`), keeping unconfigured hosts on current behavior.
    fuel_per_call: Option<u64>,
    /// Cumulative limiter counters already reported to the daemon.
    reported_memory_events: (u64, u64),
    /// Fuel amount armed for the in-flight/last call (consumption tracking).
    pending_fuel: Option<u64>,
}

#[derive(Default)]
struct PluginState {
    limiter: MemoryLimiter,
}

/// Two-tier memory limiter (cgroups-style): growth up to `soft_pages` is free,
/// soft→hard is allowed but counted as pressure (audited in Phase B), beyond
/// `hard_pages` growth is denied (guest sees a memory.grow trap).
struct MemoryLimiter {
    soft_pages: u64,
    hard_pages: u64,
    soft_breaches: u64,
    denials: u64,
}

impl MemoryLimiter {
    fn new(soft_pages: u64, hard_pages: u64) -> Self {
        // The pressure band is (soft, hard]; a soft value at or above hard means
        // "no pressure band" — clamp soft DOWN to hard, never up.
        let soft = soft_pages.min(hard_pages);
        Self {
            soft_pages: soft,
            hard_pages,
            soft_breaches: 0,
            denials: 0,
        }
    }
}

impl Default for MemoryLimiter {
    fn default() -> Self {
        Self::new(MEMORY_LIMIT_PAGES, MEMORY_LIMIT_PAGES)
    }
}

impl PluginState {
    fn limiter_counter_snapshot(&self) -> (u64, u64) {
        (self.limiter.soft_breaches, self.limiter.denials)
    }
}

impl wasmtime::ResourceLimiter for MemoryLimiter {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired_pages: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        // `desired` is the requested TOTAL size in bytes; 1 page = 64 KiB.
        let desired_pages = (desired_pages as u64) / (64 * 1024);
        if desired_pages > self.hard_pages {
            self.denials += 1;
            return Ok(false);
        }
        if desired_pages > self.soft_pages {
            self.soft_breaches += 1;
        }
        Ok(true)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        _desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        Ok(true)
    }
}

fn engine() -> &'static Engine {
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    ENGINE.get_or_init(|| {
        let mut config = Config::default();
        // Deterministic per-call time slice: every guest call gets `call_fuel()` and
        // traps when it runs out, so a runaway plugin can never hang the host.
        config.consume_fuel(true);
        // Budget traps are mapped to a friendly error message; capturing a wasm
        // backtrace per trap is expensive and pollutes neighbors' cache state.
        config.wasm_backtrace_max_frames(None);
        if let Some(cache) = cache_from_environment() {
            config.cache(Some(cache));
        }
        Engine::new(&config).expect("wasmtime engine")
    })
}

/// Optional module cache, enabled only when `EXTENSIONS_KERNEL_WASM_CACHE_DIR` points
/// at a directory. The wasmtime cache config file is generated inside that directory so
/// no state ever lands outside the host-controlled path.
fn cache_from_environment() -> Option<Cache> {
    static CACHE: OnceLock<Option<Cache>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let directory = std::env::var_os("EXTENSIONS_KERNEL_WASM_CACHE_DIR")?;
            let directory = PathBuf::from(directory);
            std::fs::create_dir_all(&directory).ok()?;
            let config_path = directory.join("wasmtime-cache.toml");
            let directory_text = directory.to_string_lossy().replace('\\', "\\\\");
            std::fs::write(
                &config_path,
                format!("[cache]\nenabled = true\ndirectory = \"{directory_text}\"\n"),
            )
            .ok()?;
            Cache::from_file(Some(&config_path)).ok()
        })
        .clone()
}

impl WasmPlugin {
    /// Compile and instantiate a guest module from a `.wasm`/`.wat` file.
    pub fn instantiate(entry_path: &Path) -> Result<Self, String> {
        Self::instantiate_with_limits(entry_path, MEMORY_LIMIT_PAGES, MEMORY_LIMIT_PAGES)
    }

    /// Instantiate with policy-derived memory limits (pages). `hard_pages` is the
    /// absolute growth ceiling; `soft_pages` is the policy-admitted budget beyond
    /// which growth still succeeds but is counted as pressure.
    pub fn instantiate_with_limits(
        entry_path: &Path,
        soft_pages: u64,
        hard_pages: u64,
    ) -> Result<Self, String> {
        let module = Module::from_file(engine(), entry_path)
            .map_err(|error| format!("wasm module failed to compile: {error}"))?;
        Self::from_module_with_limits(module, soft_pages, hard_pages)
    }

    pub fn from_wat(wat: &str) -> Result<Self, String> {
        let module = Module::new(engine(), wat)
            .map_err(|error| format!("wasm module failed to compile: {error}"))?;
        Self::from_module_with_limits(module, MEMORY_LIMIT_PAGES, MEMORY_LIMIT_PAGES)
    }

    fn from_module_with_limits(module: Module, soft_pages: u64, hard_pages: u64) -> Result<Self, String> {
        let mut store = Store::new(
            engine(),
            PluginState {
                limiter: MemoryLimiter::new(soft_pages, hard_pages),
            },
        );
        store.limiter(|state| &mut state.limiter);

        let mut linker: Linker<PluginState> = Linker::new(engine());
        wire_imports(&mut linker, &module)?;

        let instance = linker
            .instantiate(&mut store, &module)
            .map_err(|error| format!("wasm module failed to instantiate: {error}"))?;

        let ext_call = match instance
            .get_export(&mut store, "ext_call")
            .and_then(Extern::into_func)
        {
            Some(func) => Some(
                func.typed::<(i32, i32), i64>(&store).map_err(|error| {
                    format!("export ext_call must have signature (i32, i32) -> i64: {error}")
                })?,
            ),
            None => None,
        };

        let ext_tick = match instance
            .get_export(&mut store, "ext_tick")
            .and_then(Extern::into_func)
        {
            Some(func) => Some(
                func.typed::<(i32, i32), i64>(&store).map_err(|error| {
                    format!("export ext_tick must have signature (i32, i32) -> i64: {error}")
                })?,
            ),
            None => None,
        };

        let memory = instance
            .get_export(&mut store, "memory")
            .and_then(Extern::into_memory);
        if (ext_call.is_some() || ext_tick.is_some()) && memory.is_none() {
            return Err(
                "wasm plugin exports ext_call/ext_tick but no \"memory\" export".to_string(),
            );
        }

        Ok(Self {
            store,
            instance,
            ext_call,
            ext_tick,
            memory,
            fuel_per_call: None,
            reported_memory_events: (0, 0),
            pending_fuel: None,
        })
    }

    /// Policy-derived per-call fuel (see `kernel.policy.set`). Takes effect on
    /// the next guest call.
    pub fn set_fuel_per_call(&mut self, fuel: Option<u64>) {
        self.fuel_per_call = fuel;
    }

    /// Arm the per-call fuel budget and remember the amount so the consumed
    /// portion can be measured after the call (amortization contract).
    fn arm_fuel(&mut self) -> Result<(), String> {
        let fuel = self.effective_fuel();
        self.store
            .set_fuel(fuel)
            .map_err(|error| format!("failed to set fuel budget: {error}"))?;
        self.pending_fuel = Some(fuel);
        Ok(())
    }

    /// Fuel consumed by the last armed call (None when no budget was armed or
    /// the remaining amount is unavailable).
    pub fn take_fuel_consumed(&mut self) -> Option<u64> {
        let armed = self.pending_fuel?;
        self.pending_fuel = None;
        let remaining = self.store.get_fuel().ok()?;
        Some(armed.saturating_sub(remaining))
    }

    /// Drain limiter counters since the last call: (soft breaches, denials).
    pub fn take_memory_events(&mut self) -> (u64, u64) {
        let current = self.store.data().limiter_counter_snapshot();
        let delta = (
            current.0.saturating_sub(self.reported_memory_events.0),
            current.1.saturating_sub(self.reported_memory_events.1),
        );
        self.reported_memory_events = current;
        delta
    }

    /// Current linear-memory usage in bytes (0 when the guest has no memory).
    pub fn memory_usage_bytes(&self) -> u64 {
        self.memory
            .as_ref()
            .map(|memory| memory.data_size(&self.store) as u64)
            .unwrap_or(0)
    }

    fn effective_fuel(&self) -> u64 {
        self.fuel_per_call.unwrap_or_else(call_fuel)
    }

    /// One-time calibration: run an infinite wasm loop under an exactly-known
    /// fuel budget and measure wall time, yielding nanoseconds per fuel unit on
    /// this machine. Used by the policy engine to derive per-call fuel from a
    /// wall-clock frame budget. Deterministic per machine; called once per
    /// `kernel.policy.set`.
    pub fn calibrate_ns_per_fuel() -> Result<f64, String> {
        const CALIBRATION_FUEL: u64 = 10_000_000;
        let module = Module::new(
            engine(),
            r#"(module (func (export "spin") (loop $l (br $l))))"#,
        )
        .map_err(|error| format!("calibration module failed to compile: {error}"))?;
        let mut store = Store::new(engine(), PluginState::default());
        store
            .set_fuel(CALIBRATION_FUEL)
            .map_err(|error| format!("calibration fuel setup failed: {error}"))?;

        let linker: Linker<PluginState> = Linker::new(engine());
        let instance = linker
            .instantiate(&mut store, &module)
            .map_err(|error| format!("calibration module failed to instantiate: {error}"))?;
        let spin = instance
            .get_export(&mut store, "spin")
            .and_then(Extern::into_func)
            .ok_or_else(|| "calibration module missing spin export".to_string())?;
        let typed = spin
            .typed::<(), ()>(&store)
            .map_err(|error| format!("calibration spin signature mismatch: {error}"))?;

        let start = Instant::now();
        let trap_result = typed.call(&mut store, ());
        let elapsed_ns = start.elapsed().as_nanos() as f64;
        // The infinite loop must have been cut short by the fuel budget.
        let exhausted = trap_result.is_err()
            && trap_result
                .unwrap_err()
                .chain()
                .any(|cause| matches!(cause.downcast_ref::<wasmtime::Trap>(), Some(wasmtime::Trap::OutOfFuel)));
        if !exhausted {
            return Err("calibration loop did not exhaust its fuel budget".to_string());
        }

        if elapsed_ns <= 0.0 {
            return Err("calibration elapsed time was zero".to_string());
        }
        Ok(elapsed_ns / CALIBRATION_FUEL as f64)
    }

    /// JSON-RPC style dispatch, mirroring the semantics of the removed Node bridge.
    pub fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value, String> {
        match method {
            "extension/activate" => {
                self.call_optional_lifecycle("activate")?;
                Ok(json!(true))
            }
            "extension/deactivate" => {
                self.call_optional_lifecycle("deactivate")?;
                Ok(json!(true))
            }
            "extension/invoke" => {
                let params = params.unwrap_or(Value::Null);
                let capability = params
                    .get("capability")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "invoke params missing capability".to_string())?
                    .to_string();
                let input = params.get("input").cloned().unwrap_or(Value::Null);
                self.invoke(&capability, input)
            }
            other => Err(format!("unknown plugin method: {other}")),
        }
    }

    /// Capability invocation: byte fast path when the guest opts in, numeric contract
    /// otherwise (backward compatible with the removed Node bridge).
    pub fn invoke(&mut self, capability: &str, input: Value) -> Result<Value, String> {
        if self.ext_call.is_some() && self.memory.is_some() {
            let payload = json!({ "capability": capability, "input": input });
            let request = serde_json::to_vec(&payload)
                .map_err(|error| format!("invoke payload serialization failed: {error}"))?;
            let response = self.call_bytes(&request)?;
            return serde_json::from_slice(&response)
                .map_err(|error| format!("wasm ext_call response is not valid JSON: {error}"));
        }

        self.invoke_numeric(capability, input)
    }

    /// Byte-path invoke returning a fresh response buffer. Used by the JSON envelope
    /// flow where the result size is unknown ahead of time.
    pub fn call_bytes(&mut self, request: &[u8]) -> Result<Vec<u8>, String> {
        // Upper bound first: the guest cannot produce more than its linear memory.
        let memory = self
            .memory
            .as_ref()
            .ok_or_else(|| "wasm plugin does not export memory".to_string())?;
        let capacity = memory.data_size(&self.store);
        let mut response = vec![0_u8; capacity];
        let written = self.call_bytes_into(request, &mut response)?;
        response.truncate(written);
        Ok(response)
    }

    /// Data-plane entry: raw request bytes in, response bytes written directly into
    /// the caller's buffer (no intermediate allocation). The payload schema (JSON
    /// `{"capability", "input"}` today) is opaque to the transport.
    ///
    /// Returns the number of response bytes written. Errors if the response exceeds
    /// the buffer capacity.
    pub fn call_bytes_into(
        &mut self,
        request: &[u8],
        response: &mut [u8],
    ) -> Result<usize, String> {
        if self.ext_call.is_none() {
            return Err("wasm plugin does not export ext_call".to_string());
        }
        if self.memory.is_none() {
            return Err("wasm plugin does not export memory".to_string());
        }
        if request.len() > INPUT_MAX_BYTES {
            return Err(format!(
                "wasm request exceeds input limit: {} > {}",
                request.len(),
                INPUT_MAX_BYTES
            ));
        }

        // Arm fuel before taking field references (arm_fuel needs &mut self).
        self.arm_fuel()?;
        let ext_call = self.ext_call.as_ref().expect("checked above");
        let memory = self.memory.as_ref().expect("checked above");

        memory
            .write(&mut self.store, INPUT_OFFSET, request)
            .map_err(|error| format!("failed to write wasm input memory: {error}"))?;

        let packed = ext_call
            .call(&mut self.store, (INPUT_OFFSET as i32, request.len() as i32))
            .map_err(|error| trap_error("wasm ext_call", error))?;

        if packed < 0 {
            return Err(format!("wasm ext_call reported failure: {packed}"));
        }

        let packed = packed as u64;
        let out_ptr = (packed >> 32) as usize;
        let out_len = (packed & 0xFFFF_FFFF) as usize;
        let memory_size = memory.data_size(&self.store);
        if out_ptr
            .checked_add(out_len)
            .map(|end| end > memory_size)
            .unwrap_or(true)
        {
            return Err(format!(
                "wasm ext_call response range [{out_ptr}, {out_len}) exceeds memory size {memory_size}"
            ));
        }
        if out_len > response.len() {
            return Err(format!(
                "data-plane response buffer too small: need {out_len}, have {}",
                response.len()
            ));
        }

        memory
            .read(&self.store, out_ptr, &mut response[..out_len])
            .map_err(|error| format!("failed to read wasm response memory: {error}"))?;
        Ok(out_len)
    }

    /// Tick entry: same byte transport as `call_bytes_into`, routed to the guest's
    /// `ext_tick` export. Hosts push one batch per frame/tick; the plugin returns
    /// its response batch. Errors when the guest has no `ext_tick` export.
    pub fn tick_bytes_into(
        &mut self,
        request: &[u8],
        response: &mut [u8],
    ) -> Result<usize, String> {
        if self.ext_tick.is_none() {
            return Err("wasm plugin does not export ext_tick".to_string());
        }
        if self.memory.is_none() {
            return Err("wasm plugin does not export memory".to_string());
        }
        if request.len() > INPUT_MAX_BYTES {
            return Err(format!(
                "wasm tick batch exceeds input limit: {} > {}",
                request.len(),
                INPUT_MAX_BYTES
            ));
        }

        self.arm_fuel()?;
        let ext_tick = self.ext_tick.as_ref().expect("checked above");
        let memory = self.memory.as_ref().expect("checked above");

        memory
            .write(&mut self.store, INPUT_OFFSET, request)
            .map_err(|error| format!("failed to write wasm tick input memory: {error}"))?;

        let packed = ext_tick
            .call(&mut self.store, (INPUT_OFFSET as i32, request.len() as i32))
            .map_err(|error| trap_error("wasm ext_tick", error))?;

        if packed < 0 {
            return Err(format!("wasm ext_tick reported failure: {packed}"));
        }

        let packed = packed as u64;
        let out_ptr = (packed >> 32) as usize;
        let out_len = (packed & 0xFFFF_FFFF) as usize;
        let memory_size = memory.data_size(&self.store);
        if out_ptr
            .checked_add(out_len)
            .map(|end| end > memory_size)
            .unwrap_or(true)
        {
            return Err(format!(
                "wasm ext_tick response range [{out_ptr}, {out_len}) exceeds memory size {memory_size}"
            ));
        }
        if out_len > response.len() {
            return Err(format!(
                "data-plane tick response buffer too small: need {out_len}, have {}",
                response.len()
            ));
        }

        memory
            .read(&self.store, out_ptr, &mut response[..out_len])
            .map_err(|error| format!("failed to read wasm tick response memory: {error}"))?;
        Ok(out_len)
    }

    fn invoke_numeric(&mut self, capability: &str, input: Value) -> Result<Value, String> {
        let func = self
            .instance
            .get_export(&mut self.store, capability)
            .and_then(Extern::into_func)
            .ok_or_else(|| format!("wasm extension does not export capability: {capability}"))?;

        let func_type = func.ty(&self.store);
        let numeric_value = normalize_numeric_input(&input)?;
        let args: Vec<Val> = func_type
            .params()
            .map(|param| numeric_to_val(numeric_value, &param))
            .collect();
        let mut results: Vec<Val> = func_type
            .results()
            .map(|result_type| placeholder_for(&result_type))
            .collect();

        self.arm_fuel()?;
        func.call(&mut self.store, &args, &mut results)
            .map_err(|error| trap_error(&format!("wasm capability '{capability}'"), error))?;

        Ok(results
            .first()
            .map(val_to_json)
            .unwrap_or(Value::Null))
    }

    fn call_optional_lifecycle(&mut self, export: &str) -> Result<(), String> {
        let Some(func) = self
            .instance
            .get_export(&mut self.store, export)
            .and_then(Extern::into_func)
        else {
            return Ok(());
        };

        let func_type = func.ty(&self.store);
        if func_type.params().count() > 0 {
            return Err(format!("wasm export '{export}' must take no parameters"));
        }
        let mut results: Vec<Val> = func_type
            .results()
            .map(|result_type| placeholder_for(&result_type))
            .collect();
        self.arm_fuel()?;
        func.call(&mut self.store, &[], &mut results)
            .map_err(|error| trap_error(&format!("wasm export '{export}'"), error))?;
        Ok(())
    }

    pub fn shutdown(&mut self) {
        // Dropping the store releases the instance; nothing else to release today.
    }
}

fn wire_imports(
    linker: &mut Linker<PluginState>,
    module: &Module,
) -> Result<(), String> {
    for import in module.imports() {
        let module_name = import.module().to_string();
        let name = import.name().to_string();

        let supported = module_name == "env"
            && name == "now"
            && match import.ty() {
                wasmtime::ExternType::Func(func_type) => {
                    let params: Vec<ValType> = func_type.params().collect();
                    let results: Vec<ValType> = func_type.results().collect();
                    params.is_empty()
                        && results.len() == 1
                        && matches!(results[0], ValType::F64 | ValType::I64)
                }
                _ => false,
            };
        if !supported {
            return Err(format!(
                "wasm module requires unsupported import: {module_name}::{name}"
            ));
        }

        let result_type = match import.ty() {
            wasmtime::ExternType::Func(func_type) => func_type
                .results()
                .next()
                .unwrap_or(ValType::F64),
            _ => unreachable!("checked above"),
        };
        match result_type {
            ValType::F64 => linker
                .func_wrap("env", "now", || epoch_millis() as f64)
                .map_err(|error| format!("failed to define env.now import: {error}"))?,
            ValType::I64 => linker
                .func_wrap("env", "now", || epoch_millis())
                .map_err(|error| format!("failed to define env.now import: {error}"))?,
            _ => unreachable!("checked above"),
        };
    }
    Ok(())
}

fn epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_numeric_input(input: &Value) -> Result<f64, String> {
    match input {
        Value::Number(number) => number
            .as_f64()
            .ok_or_else(|| "numeric input is not representable".to_string()),
        Value::Object(map) => match map.get("value") {
            Some(Value::Number(number)) => number
                .as_f64()
                .ok_or_else(|| "numeric input value is not representable".to_string()),
            _ => Err(
                "wasm numeric runtime supports numeric input or { value: number } input only"
                    .to_string(),
            ),
        },
        Value::Null => Ok(0.0),
        _ => Err(
            "wasm numeric runtime supports numeric input or { value: number } input only"
                .to_string(),
        ),
    }
}

fn numeric_to_val(value: f64, param: &ValType) -> Val {
    match param {
        ValType::I32 => Val::I32(value as i64 as i32),
        ValType::I64 => Val::I64(value as i64),
        ValType::F32 => Val::F32((value as f32).to_bits()),
        ValType::F64 => Val::F64(value.to_bits()),
        other => panic!("unsupported wasm capability parameter type: {other:?}"),
    }
}

fn placeholder_for(result_type: &ValType) -> Val {
    match result_type {
        ValType::I32 => Val::I32(0),
        ValType::I64 => Val::I64(0),
        ValType::F32 => Val::F32(0),
        ValType::F64 => Val::F64(0),
        // The numeric contract never produces reference results; any reference
        // placeholder is only a pre-call slot filler.
        ValType::Ref(_) => Val::FuncRef(None),
        _ => Val::I32(0),
    }
}

fn val_to_json(val: &Val) -> Value {
    match val {
        Val::I32(v) => json!(v),
        Val::I64(v) => json!(v),
        Val::F32(v) => json!(f32::from_bits(*v)),
        Val::F64(v) => json!(f64::from_bits(*v)),
        _ => Value::Null,
    }
}

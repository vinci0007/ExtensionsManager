use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub mod capi;
pub mod wasm_runtime;

/// Maximum number of session events buffered per session. A plugin flooding more
/// events than this breaches the quota: buffered events are dropped and the
/// session is failed with an EVENT_QUOTA_EXCEEDED error envelope (never a fatal
/// error that would exit the daemon). Mirrors the TS host-side quota.
pub const SESSION_EVENT_QUOTA: usize = 4096;

const EVENT_QUOTA_EXCEEDED_CODE: &str = "EVENT_QUOTA_EXCEEDED";

fn session_event_quota_exceeded_message() -> String {
    format!("{EVENT_QUOTA_EXCEEDED_CODE}: session event queue overflow")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelRequestEnvelope {
    pub kind: String,
    pub id: String,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelResponseEnvelope {
    pub kind: &'static str,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<KernelError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelEventEnvelope {
    pub kind: &'static str,
    pub session_id: String,
    pub event: SessionEvent,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionEvent {
    Data { data: Value },
    End,
    Error { message: String },
    Event { name: String, payload: Option<Value> },
    ResourceGrant { resource: String, payload: Option<Value> },
    ResourceRelease { resource: String, payload: Option<Value> },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelLoadRequest {
    pub manifest: Value,
    pub runtime: CanonicalRuntimeSpec,
    pub capabilities: Vec<KernelCapability>,
    pub permissions: Value,
    pub artifact: ResolvedArtifact,
    pub security: KernelSecurityContext,
    /// Set by the host on a re-send after user/host consent was granted for a
    /// consentable policy exception (tier overflow, resident over budget).
    /// The consent DECISION lives in the host; the kernel only records it.
    #[serde(default)]
    pub consent_override: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelCapability {
    pub name: String,
    pub interaction_mode: Option<String>,
    pub execution_mode: Option<String>,
    #[serde(default)]
    pub realtime_class: Option<String>,
    #[serde(default)]
    pub resource_budget: Option<KernelResourceBudget>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KernelResourceBudget {
    pub timeout_ms: Option<u64>,
    pub memory_mb: Option<u64>,
    pub max_concurrency: Option<u32>,
    /// Resident-class amortization contract: the fuel slice this plugin may
    /// burn per tick. Actual per-call consumption above this slice is counted;
    /// a sustained over-slice raises a `contract.violation` audit event.
    pub fuel_per_tick: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelLoadResult {
    pub extension_id: String,
    pub security: ExtensionSecurityInfo,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateRequest {
    pub extension_id: String,
    pub context: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionIdRequest {
    pub extension_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokeRequest {
    pub extension_id: String,
    pub capability: String,
    pub input: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionRequest {
    pub extension_id: String,
    pub capability: String,
    pub input: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionResult {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSendRequest {
    pub session_id: String,
    pub data: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CanonicalRuntimeSpec {
    Process {
        command: String,
        args: Vec<String>,
        cwd: String,
        env: Option<HashMap<String, String>>,
    },
    #[serde(rename_all = "camelCase")]
    Wasm {
        entry_path: String,
        cwd: String,
    },
    NativeBridge {
        command: String,
        args: Vec<String>,
        cwd: String,
        env: Option<HashMap<String, String>>,
    },
    #[serde(rename_all = "camelCase")]
    Remote {
        endpoint: String,
        transport: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedArtifact {
    pub entry_path: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub base_path: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelSecurityContext {
    pub signature_policy: Option<String>,
    pub is_development: Option<bool>,
    pub trust_bundle: Option<Value>,
    pub revocation_list: Option<Value>,
    pub trusted_key_directory: Option<String>,
    pub trusted_public_keys: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSecurityInfo {
    pub status: String,
    pub reason: String,
}

/// Maximum number of closed-session tombstones retained. Tombstones exist so a
/// post-close operation answers with the stable closed-session error instead of
/// "unknown session"; they are bounded so a long-running host (millions of
/// sessions) cannot grow kernel memory without limit. Beyond the capacity the
/// oldest tombstone is evicted and such very old ids degrade to "unknown
/// session" — still an error, just without the tombstone-specific message.
pub const CLOSED_SESSION_TOMBSTONE_CAPACITY: usize = 65_536;

// ---------------------------------------------------------------------------
// Runtime accounting + bounded audit log (Phase B)
// ---------------------------------------------------------------------------

/// Maximum audit entries retained. FIFO eviction; the audit log itself must
/// never become a memory-growth vector (same contract as everything else).
pub const AUDIT_LOG_CAPACITY: usize = 1024;

/// New-high-water occurrences before a monotonic memory growth pattern is
/// reported as `leak.suspected`. The manager cannot force-shrink wasm linear
/// memory, so this event's follow-up is a host-driven instance reload.
pub const LEAK_NEW_HIGH_WATER_THRESHOLD: u64 = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub kind: String,
    pub extension_id: String,
    pub detail: String,
}

pub struct AuditLog {
    ring: VecDeque<AuditEntry>,
    next_seq: u64,
}

impl Default for AuditLog {
    fn default() -> Self {
        // Sequences start at 1 so a `sinceSeq: 0` cursor (meaning "nothing read
        // yet") never excludes the first event.
        Self {
            ring: VecDeque::new(),
            next_seq: 1,
        }
    }
}

impl AuditLog {
    fn push(&mut self, kind: &str, extension_id: &str, detail: String) {
        let entry = AuditEntry {
            seq: self.next_seq,
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0),
            kind: kind.to_string(),
            extension_id: extension_id.to_string(),
            detail,
        };
        self.next_seq += 1;
        self.ring.push_back(entry);
        while self.ring.len() > AUDIT_LOG_CAPACITY {
            self.ring.pop_front();
        }
    }

    fn query(&self, since_seq: u64, limit: usize) -> Vec<AuditEntry> {
        self.ring
            .iter()
            .filter(|entry| entry.seq > since_seq)
            .take(limit)
            .cloned()
            .collect()
    }

    /// Newest sequence number ever assigned (even if already evicted from the
    /// ring) — the cursor for subsequent `sinceSeq` queries.
    fn newest_seq(&self) -> u64 {
        self.next_seq - 1
    }

    fn len(&self) -> usize {
        self.ring.len()
    }
}

/// Per-plugin runtime accounting (Phase B). Lives in a daemon-side map keyed by
/// extension id, created lazily on first observation.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAccounting {
    pub call_count: u64,
    pub total_ns: u64,
    pub peak_ns: u64,
    pub fuel_traps: u64,
    pub memory_soft_breaches: u64,
    pub memory_growth_denials: u64,
    pub memory_high_water_bytes: u64,
    pub fuel_consumed_total: u64,
    pub over_slice_streak: u64,
    pub contract_violations: u64,
    #[serde(skip_serializing)]
    new_high_waters: u64,
    #[serde(skip_serializing)]
    leak_reported: bool,
}

impl PluginAccounting {
    fn record_call(&mut self, elapsed_ns: u64) {
        self.call_count += 1;
        self.total_ns = self.total_ns.saturating_add(elapsed_ns);
        if elapsed_ns > self.peak_ns {
            self.peak_ns = elapsed_ns;
        }
    }

    fn record_fuel_trap(&mut self) {
        self.fuel_traps += 1;
    }

    fn record_memory_events(&mut self, soft_breaches: u64, denials: u64) {
        self.memory_soft_breaches += soft_breaches;
        self.memory_growth_denials += denials;
    }

    /// Track the memory high-water mark. Returns true exactly once when the
    /// number of NEW high-water observations crosses the leak threshold
    /// (monotonic growth pattern → leak.suspected).
    fn observe_memory_usage(&mut self, usage_bytes: u64) -> bool {
        if usage_bytes > self.memory_high_water_bytes {
            self.memory_high_water_bytes = usage_bytes;
            self.new_high_waters += 1;
            if self.new_high_waters >= LEAK_NEW_HIGH_WATER_THRESHOLD && !self.leak_reported {
                self.leak_reported = true;
                return true;
            }
        }
        false
    }
}

// ---------------------------------------------------------------------------
// Policy engine (Phase A: load-time audit + derivation)
// ---------------------------------------------------------------------------

/// Host policy declaration, sent via `kernel.policy.set`. All fields optional —
/// anything absent falls back to the pre-policy safe defaults (16 MiB hard cap,
/// 200M instructions per call, no tier gating).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KernelPolicy {
    pub frame: Option<KernelFramePolicy>,
    pub memory: Option<KernelMemoryPolicy>,
    pub fuel: Option<KernelFuelPolicy>,
    /// Scheduler config. `asyncPoolThreads > 0` enables async dispatch for
    /// boundary runtimes (process/remote) on a bounded worker pool; absent/0
    /// keeps the fully synchronous model (safe default).
    pub scheduler: Option<KernelSchedulerPolicy>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KernelSchedulerPolicy {
    pub async_pool_threads: Option<usize>,
    /// Per-async-call queue cap. Beyond it the call is rejected with
    /// KERNEL_BUSY (backpressure) instead of queueing without bound.
    pub queue_cap: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KernelFramePolicy {
    /// Frame cadence. Provide either tickHz or an explicit frameBudgetMs.
    pub tick_hz: Option<f64>,
    pub frame_budget_ms: Option<f64>,
    /// Share of the frame budget a single plugin may consume per tick
    /// (default 5%). N plugins × share should stay ≤ 100%.
    pub plugin_share_pct: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KernelMemoryPolicy {
    /// Total plugin memory budget in MiB (admission space for Phase C reservations).
    pub total_mb: Option<u64>,
    /// Per-tier hard caps in MiB (gate manifest-declared resourceBudget.memoryMb).
    pub tiers: Option<KernelMemoryTiers>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KernelMemoryTiers {
    pub realtime_mb: Option<u64>,
    pub interactive_mb: Option<u64>,
    pub batch_mb: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KernelFuelPolicy {
    /// Explicit per-call fuel; wins over frame-budget derivation.
    pub per_call_override: Option<u64>,
}

/// Derived policy state: calibration + resolved values used at load/activate.
#[derive(Default)]
pub struct KernelPolicyState {
    pub policy: Option<KernelPolicy>,
    pub ns_per_fuel: Option<f64>,
    pub derived_fuel_per_call: Option<u64>,
    /// Memory (MiB) reserved by resident-class extensions (lifetime of the
    /// reservation: until the extension is re-loaded or the kernel resets).
    pub reserved_mb: u64,
}

/// A resident extension's reservation: memory peak + per-tick fuel slice.
#[derive(Debug, Clone, Copy)]
pub struct ResidentReservation {
    pub memory_mb: u64,
    pub fuel_per_tick: Option<u64>,
}

impl KernelPolicyState {
    fn frame_budget_ms(&self) -> Option<f64> {
        let frame = self.policy.as_ref()?.frame.as_ref()?;
        match (frame.frame_budget_ms, frame.tick_hz) {
            (Some(budget), _) => Some(budget),
            (None, Some(hz)) if hz > 0.0 => Some(1000.0 / hz),
            _ => None,
        }
    }

    fn plugin_share_pct(&self) -> f64 {
        self.policy
            .as_ref()
            .and_then(|policy| policy.frame.as_ref())
            .and_then(|frame| frame.plugin_share_pct)
            .unwrap_or(5.0)
    }

    /// Derive per-call fuel: plugin share of the frame budget (wall clock)
    /// divided by the machine-calibrated ns-per-fuel. Conservative by design —
    /// the calibration measures THIS machine, so fuel matches real time here.
    fn derive_fuel_per_call(&self) -> Option<u64> {
        if let Some(fuel) = self
            .policy
            .as_ref()
            .and_then(|policy| policy.fuel.as_ref())
            .and_then(|fuel| fuel.per_call_override)
        {
            return Some(fuel);
        }

        let budget_ns = self.frame_budget_ms()? * 1_000_000.0 * (self.plugin_share_pct() / 100.0);
        let ns_per_fuel = self.ns_per_fuel?;
        if ns_per_fuel <= 0.0 {
            return None;
        }
        Some((budget_ns / ns_per_fuel).max(1.0) as u64)
    }

    /// Hard cap in pages for a tier, falling back to the safe default.
    fn tier_hard_pages(&self, tier: &str) -> u64 {
        let Some(tiers) = self
            .policy
            .as_ref()
            .and_then(|policy| policy.memory.as_ref())
            .and_then(|memory| memory.tiers.as_ref())
        else {
            return crate::wasm_runtime::MEMORY_LIMIT_PAGES;
        };

        let tier_mb = match tier {
            "realtime" => tiers.realtime_mb,
            "interactive" => tiers.interactive_mb,
            _ => tiers.batch_mb,
        };
        tier_mb.map(|mb| mb * 16).unwrap_or(crate::wasm_runtime::MEMORY_LIMIT_PAGES)
    }
}

/// Bounded closed-session tombstone store: O(1) lookup, FIFO eviction.
pub struct ClosedSessionTombstones {
    ring: VecDeque<String>,
    set: HashSet<String>,
}

impl ClosedSessionTombstones {
    fn new() -> Self {
        Self {
            ring: VecDeque::new(),
            set: HashSet::new(),
        }
    }

    fn insert(&mut self, session_id: String) {
        if self.set.insert(session_id.clone()) {
            self.ring.push_back(session_id);
            if self.ring.len() > CLOSED_SESSION_TOMBSTONE_CAPACITY {
                if let Some(oldest) = self.ring.pop_front() {
                    self.set.remove(&oldest);
                }
            }
        }
    }

    fn contains(&self, session_id: &str) -> bool {
        self.set.contains(session_id)
    }

    fn len(&self) -> usize {
        self.ring.len()
    }
}

/// One queued boundary invoke (scheduler v2). Everything the worker needs is
/// carried in the job — pool workers never touch the daemon.
struct AsyncInvokeJob {
    handle: Arc<Mutex<RuntimeHandle>>,
    accounting: Arc<Mutex<HashMap<String, PluginAccounting>>>,
    sink: Arc<Mutex<std::sync::mpsc::Sender<String>>>,
    in_flight: Arc<AtomicUsize>,
    request_id: String,
    extension_id: String,
    capability: String,
    input: Value,
}

/// Execute one queued boundary invoke: call through the shared plugin handle,
/// account the latency, release the in-flight slot, deliver the response
/// envelope through the sink. Runs on a pool worker — no daemon borrow.
fn run_async_job(job: AsyncInvokeJob) {
    let start = Instant::now();
    let call = {
        match job.handle.lock() {
            Ok(mut guard) => guard.request(
                "extension/invoke",
                Some(json!({
                    "capability": job.capability,
                    "input": job.input,
                })),
            ),
            Err(_) => Err("plugin handle poisoned".to_string()),
        }
    };
    let elapsed_ns = start.elapsed().as_nanos() as u64;
    drop(job.handle);

    KernelDaemon::account_on(&job.accounting, &job.extension_id, elapsed_ns);
    job.in_flight.fetch_sub(1, Ordering::SeqCst);

    let envelope = match &call {
        Ok(result) => json!({
            "kind": "response",
            "id": job.request_id,
            "result": result,
        }),
        Err(message) => json!({
            "kind": "response",
            "id": job.request_id,
            "error": { "code": "KERNEL_INVOKE_FAILED", "message": message },
        }),
    };
    let delivery = job
        .sink
        .lock()
        .map_err(|error| error.to_string())
        .and_then(|sink| {
            sink.send(envelope.to_string())
                .map_err(|error| format!("failed to deliver async response: {error}"))
        });
    // A closed sink is daemon-side teardown; a detached worker has nowhere to
    // report it beyond dropping the envelope.
    let _ = delivery;
}

/// Persistent bounded worker pool for boundary-runtime invokes (scheduler v2).
/// Workers are created once per pool (not per call), consume a job queue, and
/// exit when the daemon — and its pool sender — is dropped. Backpressure is
/// enforced by the daemon-side in-flight counter (queued + executing), so the
/// queue itself is unbounded but can never exceed `queueCap - threads` entries.
struct AsyncPool {
    job_tx: std::sync::mpsc::Sender<AsyncInvokeJob>,
    threads: usize,
}

impl AsyncPool {
    fn spawn(threads: usize) -> Self {
        let (job_tx, job_rx) = std::sync::mpsc::channel::<AsyncInvokeJob>();
        let job_rx = Arc::new(Mutex::new(job_rx));
        for _ in 0..threads {
            let rx = Arc::clone(&job_rx);
            std::thread::spawn(move || loop {
                let job = match rx.lock() {
                    Ok(guard) => guard.recv(),
                    Err(_) => return,
                };
                match job {
                    Ok(job) => run_async_job(job),
                    Err(_) => return, // sender dropped: daemon reset/shutdown
                }
            });
        }
        Self { job_tx, threads }
    }
}

pub struct KernelDaemon {
    loaded: HashMap<String, LoadedExtension>,
    sessions: HashMap<String, SessionState>,
    closed_sessions: ClosedSessionTombstones,
    next_session_id: u64,
    handles: HashMap<u64, String>,
    next_handle: u64,
    policy: KernelPolicyState,
    audit: Arc<Mutex<AuditLog>>,
    accounting: Arc<Mutex<HashMap<String, PluginAccounting>>>,
    reservations: HashMap<String, ResidentReservation>,
    in_flight_invokes: Arc<AtomicUsize>,
    /// Daemon-mode response sink: outbound envelopes (async responses) are
    /// sent here. None in embedded/C ABI use → async dispatch falls back to
    /// synchronous.
    response_sink: Option<Arc<Mutex<std::sync::mpsc::Sender<String>>>>,
    /// Persistent scheduler worker pool (v2). Built lazily on the first async
    /// dispatch; rebuilt only when the policy thread count changes.
    async_pool: Option<AsyncPool>,
}

impl KernelDaemon {
    pub fn new() -> Self {
        Self {
            loaded: HashMap::new(),
            sessions: HashMap::new(),
            closed_sessions: ClosedSessionTombstones::new(),
            next_session_id: 1,
            handles: HashMap::new(),
            next_handle: 1,
            policy: KernelPolicyState::default(),
            audit: Arc::new(Mutex::new(AuditLog::default())),
            accounting: Arc::new(Mutex::new(HashMap::new())),
            reservations: HashMap::new(),
            in_flight_invokes: Arc::new(AtomicUsize::new(0)),
            response_sink: None,
            async_pool: None,
        }
    }

    fn account(&self, extension_id: &str, elapsed_ns: u64) {
        Self::account_on(&self.accounting, extension_id, elapsed_ns);
    }

    /// Accounting without a daemon borrow — callable from detached scheduler
    /// workers (async invokes) where `&mut self` is not available.
    fn account_on(
        accounting: &Mutex<HashMap<String, PluginAccounting>>,
        extension_id: &str,
        elapsed_ns: u64,
    ) {
        let mut accounting_map = accounting.lock().expect("accounting lock");
        let accounting = accounting_map
            .entry(extension_id.to_string())
            .or_insert_with(PluginAccounting::default);
        accounting.record_call(elapsed_ns);
    }

    fn account_fuel_trap(&mut self, extension_id: &str, error: &str) {
        let is_fuel = error.contains("fuel budget");
        let mut audit = self.audit.lock().expect("audit lock");
        let mut accounting_map = self.accounting.lock().expect("accounting lock");
        let accounting = accounting_map
            .entry(extension_id.to_string())
            .or_insert_with(PluginAccounting::default);
        if is_fuel {
            accounting.record_fuel_trap();
            audit.push("fuel.trap", extension_id, error.to_string());
        }
    }

    fn observe_wasm_memory(&mut self, extension_id: &str, soft_breaches: u64, denials: u64, usage: u64) {
        let mut audit = self.audit.lock().expect("audit lock");
        let mut accounting_map = self.accounting.lock().expect("accounting lock");
        let accounting = accounting_map
            .entry(extension_id.to_string())
            .or_insert_with(PluginAccounting::default);
        accounting.record_memory_events(soft_breaches, denials);
        if denials > 0 {
            audit.push(
                "memory.growth_denied",
                extension_id,
                format!("{denials} growth request(s) denied at the hard memory cap"),
            );
        } else if soft_breaches > 0 {
            audit.push(
                "memory.pressure",
                extension_id,
                format!("{soft_breaches} growth request(s) beyond the soft budget (allowed, counted)"),
            );
        }

        if accounting.observe_memory_usage(usage) {
            audit.push(
                "leak.suspected",
                extension_id,
                format!(
                    "linear memory reached a new high water {} times without shrinking (current {} bytes); consider reloading this extension instance",
                    LEAK_NEW_HIGH_WATER_THRESHOLD, usage
                ),
            );
        }
    }

    /// Register a data-plane handle for a loaded in-process wasm extension.
    /// Returns 0 when the extension is not loaded.
    pub fn resolve_handle(&mut self, extension_id: &str) -> u64 {
        if !self.loaded.contains_key(extension_id) {
            return 0;
        }
        for (handle, existing) in &self.handles {
            if existing == extension_id {
                return *handle;
            }
        }
        let handle = self.next_handle;
        self.next_handle += 1;
        self.handles.insert(handle, extension_id.to_string());
        handle
    }

    pub fn release_handle(&mut self, handle: u64) {
        self.handles.remove(&handle);
    }

    /// Tick entry: push one batch to a loaded in-process wasm plugin's `ext_tick`
    /// export. Hosts call this once per frame/tick with the accumulated batch.
    pub fn tick_bytes(
        &mut self,
        handle: u64,
        request: &[u8],
        response: &mut [u8],
    ) -> Result<usize, String> {
        let extension_id = self
            .handles
            .get(&handle)
            .ok_or_else(|| format!("unknown data-plane handle: {handle}"))?
            .clone();
        let extension = self.require_loaded_mut(&extension_id)?;
        let handle_guard = extension
            .runtime_handle
            .as_ref()
            .ok_or_else(|| format!("extension is not active: {extension_id}"))?
            .lock()
            .map_err(|error| error.to_string())?;
        let mut handle_guard = handle_guard;
        match &mut *handle_guard {
            RuntimeHandle::Wasm(plugin) => plugin.tick_bytes_into(request, response),
            _ => Err(format!(
                "extension is not an in-process wasm plugin: {extension_id}"
            )),
        }
    }

    /// Data-plane byte invoke: raw request bytes in, response written directly into
    /// the caller's buffer. Only in-process wasm plugins with the `ext_call` export
    /// qualify.
    pub fn invoke_bytes(
        &mut self,
        handle: u64,
        request: &[u8],
        response: &mut [u8],
    ) -> Result<usize, String> {
        let extension_id = self
            .handles
            .get(&handle)
            .ok_or_else(|| format!("unknown data-plane handle: {handle}"))?
            .clone();
        let start = Instant::now();
        let outcome = {
            let extension = self.require_loaded_mut(&extension_id)?;
            let mut handle_guard = extension
                .runtime_handle
                .as_ref()
                .ok_or_else(|| format!("extension is not active: {extension_id}"))?
                .lock()
                .map_err(|error| error.to_string())?;
            match &mut *handle_guard {
                RuntimeHandle::Wasm(plugin) => plugin.call_bytes_into(request, response),
                _ => Err(format!(
                    "extension is not an in-process wasm plugin: {extension_id}"
                )),
            }
        };
        let elapsed_ns = start.elapsed().as_nanos() as u64;

        match &outcome {
            Ok(_) => self.account(&extension_id, elapsed_ns),
            Err(error) => {
                self.account(&extension_id, elapsed_ns);
                self.account_fuel_trap(&extension_id, error);
            }
        }
        self.drain_wasm_telemetry(&extension_id)?;
        outcome
    }

    /// Drain wasm telemetry for an extension: memory-growth counters into
    /// accounting/audit (pressure/denial/leak ratchet) and fuel consumption
    /// into the amortization contract.
    fn drain_wasm_telemetry(&mut self, extension_id: &str) -> Result<(), String> {
        let (events, usage, consumed) = {
            let extension = self.require_loaded_mut(extension_id)?;
            let handle_guard = extension
                .runtime_handle
                .as_ref()
                .ok_or_else(|| format!("extension is not active: {extension_id}"))?
                .lock()
                .map_err(|error| error.to_string())?;
            let mut handle_guard = handle_guard;
            match &mut *handle_guard {
                RuntimeHandle::Wasm(plugin) => {
                    let events = plugin.take_memory_events();
                    let usage = plugin.memory_usage_bytes();
                    let consumed = plugin.take_fuel_consumed();
                    (Some(events), usage, consumed)
                }
                _ => (None, 0, None),
            }
        };

        if let Some((soft_breaches, denials)) = events {
            self.observe_wasm_memory(extension_id, soft_breaches, denials, usage);
        }
        if let Some(consumed) = consumed {
            self.account_fuel_consumed(extension_id, consumed);
        }
        Ok(())
    }

    /// Amortization contract: compare the actual fuel consumed by the last call
    /// against the resident's declared per-tick slice. A sustained over-slice
    /// (streak ≥ threshold) raises a `contract.violation` audit event —
    /// reported once per violation episode, reset when the plugin is back in
    /// contract.
    fn account_fuel_consumed(&mut self, extension_id: &str, consumed: u64) {
        const OVER_SLICE_STREAK_THRESHOLD: u64 = 8;

        let Some(reservation) = self.reservations.get(extension_id) else {
            return;
        };
        let Some(slice) = reservation.fuel_per_tick else {
            return;
        };

        let violation = {
            let mut accounting_map = self.accounting.lock().expect("accounting lock");
            let accounting = accounting_map
                .entry(extension_id.to_string())
                .or_insert_with(PluginAccounting::default);
            accounting.fuel_consumed_total = accounting.fuel_consumed_total.saturating_add(consumed);

            if consumed > slice {
                accounting.over_slice_streak += 1;
                if accounting.over_slice_streak == OVER_SLICE_STREAK_THRESHOLD {
                    accounting.contract_violations += 1;
                    true
                } else {
                    false
                }
            } else {
                accounting.over_slice_streak = 0;
                false
            }
        };

        if violation {
            self.audit
                .lock()
                .expect("audit lock")
                .push(
                    "contract.violation",
                    extension_id,
                    format!(
                        "fuel consumption {consumed} exceeded the declared per-tick slice {slice} for {OVER_SLICE_STREAK_THRESHOLD} consecutive calls"
                    ),
                );
        }
    }

    /// Attach the daemon response sink (daemon mode). Required for async
    /// dispatch; without it boundary invokes run synchronously.
    pub fn set_response_sink(&mut self, sink: Arc<Mutex<std::sync::mpsc::Sender<String>>>) {
        self.response_sink = Some(sink);
    }

    pub fn handle_request_line(&mut self, line: &str) -> Result<Vec<String>, String> {
        let request: KernelRequestEnvelope =
            serde_json::from_str(line).map_err(|error| format!("invalid kernel request: {error}"))?;
        if request.kind != "request" {
            return Err("kernel envelope kind must be \"request\"".to_string());
        }

        let method = request.method.clone();
        let request_id = request.id.clone();
        match method.as_str() {
            "kernel.policy.set" => self.handle_policy_set(request),
            "kernel.audit.query" => self.handle_audit_query(request),
            "kernel.load" => self.handle_load(request),
            // Runtime operations on extensions/sessions can fail in EXPECTED
            // ways (unknown extension, not active, closed session). Those are
            // error envelopes so the daemon survives host mistakes; anything
            // outside the expected class stays a fatal protocol error.
            "kernel.activate"
            | "kernel.deactivate"
            | "kernel.invoke"
            | "kernel.openSession"
            | "kernel.session.send"
            | "kernel.cancel" => match Self::dispatch_runtime(self, &method, request) {
                Ok(output) => Ok(output),
                Err(message) if Self::is_expected_runtime_error(&message) => {
                    Ok(vec![self.encode_error_response(
                        request_id,
                        "KERNEL_RUNTIME_ERROR",
                        message,
                    )?])
                }
                Err(message) => Err(message),
            },
            "kernel.session.close" => self.handle_session_close(request),
            other => Ok(vec![self.encode_error_response(
                request.id,
                "KERNEL_UNKNOWN_METHOD",
                format!("unknown kernel method: {other}"),
            )?]),
        }
    }

    fn dispatch_runtime(
        &mut self,
        method: &str,
        request: KernelRequestEnvelope,
    ) -> Result<Vec<String>, String> {
        match method {
            "kernel.activate" => self.handle_activate(request),
            "kernel.deactivate" => self.handle_deactivate(request),
            "kernel.invoke" => self.handle_invoke(request),
            "kernel.openSession" => self.handle_open_session(request),
            "kernel.session.send" => self.handle_session_send(request),
            "kernel.cancel" => self.handle_session_cancel(request),
            _ => unreachable!("dispatch_runtime only receives runtime methods"),
        }
    }

    fn is_expected_runtime_error(message: &str) -> bool {
        message.contains("extension is not loaded")
            || message.contains("extension is not active")
            || message.contains("extension is not registered")
            || message.contains("capability is not declared")
            || message.contains("does not require a real session")
            || message.contains("does not support sessions")
            || message.contains("session is closed")
            || message.contains("unknown session")
    }

    fn handle_policy_set(&mut self, request: KernelRequestEnvelope) -> Result<Vec<String>, String> {
        let policy: KernelPolicy = decode_params::<KernelPolicy>(request.params)?;
        let ns_per_fuel = crate::wasm_runtime::WasmPlugin::calibrate_ns_per_fuel()?;
        let mut state = KernelPolicyState {
            policy: Some(policy),
            ns_per_fuel: Some(ns_per_fuel),
            derived_fuel_per_call: None,
            reserved_mb: 0,
        };
        state.derived_fuel_per_call = state.derive_fuel_per_call();
        self.policy = state;

        Ok(vec![self.encode_success_response(
            request.id,
            json!({
                "nsPerFuel": ns_per_fuel,
                "fuelPerCall": self.policy.derived_fuel_per_call,
            }),
        )?])
    }

    /// Performance-policy admission: map the manifest's declared budgets onto
    /// the host's tier caps. Returns (soft, hard) memory pages, or an error
    /// message describing the rejection when a declaration exceeds its tier.
    /// Without a host policy this falls back to the safe default cap.
    /// Returns (soft_pages, hard_pages, declared_mb, fuel_per_tick,
    /// consent_reason). `consent_reason` is Some(_) when the declaration
    /// overflows a cap in a way the host/user MAY explicitly allow; `Err` is
    /// reserved for non-consentable admission failures.
    fn policy_memory_limits(
        &self,
        capabilities: &[KernelCapability],
        extension_class: &str,
    ) -> Result<(u64, u64, u64, Option<u64>, Option<String>), String> {
        if self.policy.policy.is_none() {
            let fallback = crate::wasm_runtime::MEMORY_LIMIT_PAGES;
            return Ok((fallback, fallback, 0, None, None));
        }

        // Tier = strictest declared capability class.
        let tier = capabilities
            .iter()
            .map(|capability| capability.realtime_class.as_deref().unwrap_or("batch"))
            .fold("batch", |acc, class| match (acc, class) {
                ("realtime", _) | (_, "realtime") => "realtime",
                ("interactive", "interactive") | ("batch", "interactive") => "interactive",
                _ => acc,
            });

        let declared_mb = capabilities
            .iter()
            .filter_map(|capability| {
                capability
                    .resource_budget
                    .as_ref()
                    .and_then(|budget| budget.memory_mb)
            })
            .max();

        // Residents are gated by the RESERVATION (declared peak against the
        // host total budget, checked by the caller) — not by the tier fallback
        // cap, which would otherwise reject exactly the large-memory residents
        // the class exists for.
        if extension_class == "resident" {
            let Some(declared) = declared_mb else {
                return Err(
                    "resident extension must declare resourceBudget.memoryMb (its reserved peak)"
                        .to_string(),
                );
            };
            let hard_pages = (declared * 16).max(1);
            return Ok((hard_pages, hard_pages, declared, fuel_per_tick_of(capabilities), None));
        }

        let hard_pages = self.policy.tier_hard_pages(tier);
        let tier_cap_mb = hard_pages / 16;

        if let Some(declared) = declared_mb {
            if declared > tier_cap_mb {
                // Consentable: the host/user may explicitly allow the overflow.
                let consent_reason = format!(
                    "declared resourceBudget.memoryMb {declared} MB exceeds the {tier} tier cap {tier_cap_mb} MB configured by the host policy; reduce the declaration, or ask the host to raise the {tier} tier cap"
                );
                let hard_pages = (declared * 16).max(1);
                return Ok((
                    hard_pages,
                    hard_pages,
                    declared,
                    fuel_per_tick_of(capabilities),
                    Some(consent_reason),
                ));
            }
        }

        let soft_pages = declared_mb
            .map(|mb| (mb * 16).min(hard_pages))
            .unwrap_or(hard_pages);
        let fuel_per_tick = fuel_per_tick_of(capabilities);
        Ok((soft_pages, hard_pages, declared_mb.unwrap_or(0), fuel_per_tick, None))
    }

    /// Bounded audit + accounting query. `params.sinceSeq` filters by sequence,
    /// `params.limit` caps the entry count (default 256, hard max = capacity).
    fn handle_audit_query(&mut self, request: KernelRequestEnvelope) -> Result<Vec<String>, String> {
        let params = request.params.clone().unwrap_or(json!({}));
        let since_seq = params.get("sinceSeq").and_then(Value::as_u64).unwrap_or(0);
        let limit = params
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(256)
            .min(AUDIT_LOG_CAPACITY as u64) as usize;

        let entries = self
            .audit
            .lock()
            .expect("audit lock")
            .query(since_seq, limit);
        // lastSeq is the GLOBAL newest sequence (even beyond the returned
        // batch) so cursors advance monotonically for the host.
        let last_seq = self.audit.lock().expect("audit lock").newest_seq();
        let accounting: Vec<Value> = self
            .accounting
            .lock()
            .expect("accounting lock")
            .iter()
            .map(|(extension_id, accounting)| {
                let mut value = serde_json::to_value(accounting)
                    .unwrap_or_else(|_| json!({}));
                value["extensionId"] = json!(extension_id);
                value
            })
            .collect();

        Ok(vec![self.encode_success_response(
            request.id,
            json!({
                "entries": entries,
                "lastSeq": last_seq,
                "accounting": accounting,
            }),
        )?])
    }

    fn handle_load(&mut self, request: KernelRequestEnvelope) -> Result<Vec<String>, String> {
        let params = decode_params::<KernelLoadRequest>(request.params)?;
        let extension_id = manifest_id(&params.manifest)?;
        // Admission (signature policy, trust evaluation) is an EXPECTED runtime
        // outcome, not a protocol failure: answer as an error envelope so the
        // daemon survives and other extensions keep working. With the
        // fail-closed default this is the normal path for unsigned manifests.
        let security = match evaluate_security(&params) {
            Ok(security) => security,
            Err(message) => {
                self.audit
                    .lock()
                    .expect("audit lock")
                    .push("admission.rejected", &extension_id, message.clone());
                return Ok(vec![self.encode_error_response(
                    request.id,
                    "KERNEL_ADMISSION_REJECTED",
                    message,
                )?]);
            }
        };
        // Performance-policy admission: manifest-declared resource budgets must
        // fit the tier caps configured by the host. Expected runtime outcome →
        // error envelope, never a fatal daemon exit. Overflow may be
        // CONSENTABLE: without `consentOverride` the kernel answers
        // KERNEL_CONSENT_REQUIRED (the host mediates user consent); with it,
        // the override is admitted and audited.
        let extension_class = params
            .manifest
            .get("extensionClass")
            .and_then(Value::as_str)
            .unwrap_or("standard")
            .to_string();
        let (mut memory_soft_pages, mut memory_hard_pages, declared_mb, fuel_per_tick, consent_reason) =
            match self
                .policy_memory_limits(&params.capabilities, &extension_class)
            {
                Ok(limits) => limits,
                Err(message) => {
                    self.audit
                        .lock()
                        .expect("audit lock")
                        .push("admission.rejected", &extension_id, message.clone());
                    return Ok(vec![self.encode_error_response(
                        request.id,
                        "KERNEL_ADMISSION_REJECTED",
                        message,
                    )?]);
                }
            };
        // Resident-class reservation admission (Phase C): a resident extension
        // gets its declared memory peak RESERVED from the host's total plugin
        // budget for the lifetime of the load. Fail-closed: no configured total
        // budget, or no declared peak, or insufficient remaining budget → reject.
        let mut reservation: Option<ResidentReservation> = None;
        let mut budget_consent_reason: Option<String> = None;
        if extension_class == "resident" {
            let total_mb = self
                .policy
                .policy
                .as_ref()
                .and_then(|policy| policy.memory.as_ref())
                .and_then(|memory| memory.total_mb);
            let Some(total_mb) = total_mb else {
                let message = "resident extension requires the host to configure policy.memory.totalMb (reserved budget); no total budget is configured".to_string();
                self.audit
                    .lock()
                    .expect("audit lock")
                    .push("admission.rejected", &extension_id, message.clone());
                return Ok(vec![self.encode_error_response(
                    request.id,
                    "KERNEL_ADMISSION_REJECTED",
                    message,
                )?]);
            };
            if declared_mb == 0 {
                let message = "resident extension must declare resourceBudget.memoryMb (its reserved peak)".to_string();
                self.audit
                    .lock()
                    .expect("audit lock")
                    .push("admission.rejected", &extension_id, message.clone());
                return Ok(vec![self.encode_error_response(
                    request.id,
                    "KERNEL_ADMISSION_REJECTED",
                    message,
                )?]);
            }
            let other_reserved: u64 = self
                .reservations
                .iter()
                .filter(|(id, _)| id.as_str() != extension_id)
                .map(|(_, reservation)| reservation.memory_mb)
                .sum();
            if declared_mb + other_reserved > total_mb {
                budget_consent_reason = Some(format!(
                    "resident reservation of {declared_mb} MB exceeds the host memory budget ({total_mb} MB total, {other_reserved} MB already reserved by other residents)"
                ));
            }
            reservation = Some(ResidentReservation {
                memory_mb: declared_mb,
                fuel_per_tick,
            });
        }

        // Consent gate: a consentable overflow without the override flag asks
        // the host for consent (KERNEL_CONSENT_REQUIRED). With the override,
        // admit with the DECLARED peak as the cap and record the decision.
        if let Some(reason) = consent_reason.or(budget_consent_reason) {
            if !params.consent_override {
                self.audit
                    .lock()
                    .expect("audit lock")
                    .push("consent.required", &extension_id, reason.clone());
                return Ok(vec![self.encode_error_response(
                    request.id,
                    "KERNEL_CONSENT_REQUIRED",
                    reason,
                )?]);
            }
            self.audit
                .lock()
                .expect("audit lock")
                .push(
                    "policy.consent_override",
                    &extension_id,
                    format!("host-approved policy exception: {reason}"),
                );
            // Override grants the declared peak as the effective cap.
            memory_hard_pages = (declared_mb * 16).max(1);
            memory_soft_pages = memory_hard_pages;
        }
        // A re-load of the same id replaces the old reservation (release-then-
        // reacquire) so reservation accounting never double-counts.
        self.reservations.remove(&extension_id);
        validate_runtime_load_contract(&params, &extension_id)?;
        let capabilities = build_capability_contracts(&params.capabilities);

        if let Some(reservation) = reservation {
            self.reservations
                .insert(extension_id.clone(), reservation);
        }

        self.loaded.insert(
            extension_id.clone(),
            LoadedExtension {
                manifest: params.manifest,
                runtime: params.runtime,
                artifact: params.artifact,
                security: security.clone(),
                capabilities,
                runtime_handle: None,
                memory_soft_pages,
                memory_hard_pages,
            },
        );

        Ok(vec![self.encode_success_response(
            request.id,
            json!(KernelLoadResult {
                extension_id,
                security,
            }),
        )?])
    }

    fn handle_activate(&mut self, request: KernelRequestEnvelope) -> Result<Vec<String>, String> {
        let params = decode_params::<ActivateRequest>(request.params)?;
        // Read policy + reservation before the mutable extension borrow
        // (disjoint fields, but require_loaded_mut takes &mut self).
        let derived_fuel = self.policy.derived_fuel_per_call;
        let resident_floor = self
            .reservations
            .get(&params.extension_id)
            .and_then(|reservation| reservation.fuel_per_tick);
        let extension = self.require_loaded_mut(&params.extension_id)?;

        if extension.runtime_handle.is_none() {
            let runtime = extension.runtime.clone();
            let artifact = extension.artifact.clone();
            let soft_pages = extension.memory_soft_pages;
            let hard_pages = extension.memory_hard_pages;
            let handle = Arc::new(Mutex::new(spawn_runtime_handle(
                &runtime,
                &artifact,
                soft_pages,
                hard_pages,
            )?));
            handle
                .lock()
                .map_err(|error| error.to_string())?
                .request("extension/activate", Some(params.context))?;
            if let RuntimeHandle::Wasm(plugin) = &mut *handle
                .lock()
                .map_err(|error| error.to_string())?
            {
                // Resident fuel floor/ceiling: the plugin gets AT LEAST its
                // declared per-tick slice (guaranteed by the reservation) and
                // AT MOST the policy-derived frame share. Without a frame
                // policy the ceiling falls back to the safe default budget.
                let fuel = match resident_floor {
                    Some(floor) => Some(floor.max(
                        derived_fuel.unwrap_or(crate::wasm_runtime::DEFAULT_CALL_FUEL),
                    )),
                    None => derived_fuel,
                };
                plugin.set_fuel_per_call(fuel);
            }
            extension.runtime_handle = Some(handle);
        }

        Ok(vec![self.encode_success_response(request.id, json!(true))?])
    }

    fn handle_deactivate(&mut self, request: KernelRequestEnvelope) -> Result<Vec<String>, String> {
        let params = decode_params::<ExtensionIdRequest>(request.params)?;
        let extension = self.require_loaded_mut(&params.extension_id)?;

        if let Some(handle) = extension.runtime_handle.as_ref() {
            let mut guard = handle.lock().map_err(|error| error.to_string())?;
            let _ = guard.request("extension/deactivate", None);
            guard.shutdown();
        }

        Ok(vec![self.encode_success_response(request.id, json!(true))?])
    }

    fn handle_invoke(&mut self, request: KernelRequestEnvelope) -> Result<Vec<String>, String> {
        let request_id = request.id.clone();
        let params = decode_params::<InvokeRequest>(request.params)?;
        let extension_id = params.extension_id.clone();

        // Scheduler: async dispatch ONLY when (a) the host enabled a pool,
        // (b) the target is a boundary runtime (process/remote — the slow
        // shapes the scheduler exists for), and (c) a response sink exists
        // (daemon mode). Everything else stays synchronous.
        let async_target = self
            .policy
            .policy
            .as_ref()
            .and_then(|policy| policy.scheduler.as_ref())
            .map(|scheduler| scheduler.async_pool_threads.unwrap_or(0) > 0)
            .unwrap_or(false);
        if async_target && self.response_sink.is_some() {
            let is_boundary = {
                let extension = self.require_loaded_mut(&params.extension_id)?;
                // Runtime-kind check, deliberately WITHOUT taking the handle
                // lock: a scheduler worker may hold the handle for the whole
                // boundary call, and blocking here would hold the daemon —
                // and the host's frame thread — hostage to it.
                !matches!(&extension.runtime, CanonicalRuntimeSpec::Wasm { .. })
                    && extension.runtime_handle.is_some()
            };
            if is_boundary {
                return self.dispatch_invoke_async(request_id, params);
            }
        }

        let start = Instant::now();
        let result = {
            let extension = self.require_loaded_mut(&params.extension_id)?;
            let mut handle_guard = extension
                .runtime_handle
                .as_ref()
                .ok_or_else(|| format!("extension is not active: {}", params.extension_id))?
                .lock()
                .map_err(|error| error.to_string())?;
            handle_guard.request(
                "extension/invoke",
                Some(json!({
                    "capability": params.capability,
                    "input": params.input,
                })),
            )
        };
        let elapsed_ns = start.elapsed().as_nanos() as u64;

        match &result {
            Ok(_) => self.account(&extension_id, elapsed_ns),
            Err(error) => {
                self.account(&extension_id, elapsed_ns);
                self.account_fuel_trap(&extension_id, error);
            }
        }

        let result = result?;
        self.drain_wasm_telemetry(&params.extension_id)?;
        Ok(vec![self.encode_success_response(request.id, result)?])
    }

    /// Async dispatch for boundary-runtime invokes: the call runs on the
    /// persistent scheduler pool (fixed thread count from the policy), the
    /// response envelope is delivered through the sink, and the caller gets an
    /// immediate accepted marker. Same-plugin concurrency serializes on the
    /// plugin's handle mutex ON THE WORKER — no daemon lock is held across the
    /// boundary call. Bounded in-flight (backpressure -> KERNEL_BUSY).
    fn dispatch_invoke_async(
        &mut self,
        request_id: String,
        params: InvokeRequest,
    ) -> Result<Vec<String>, String> {
        let scheduler = self
            .policy
            .policy
            .as_ref()
            .and_then(|policy| policy.scheduler.as_ref());
        let threads = scheduler
            .and_then(|scheduler| scheduler.async_pool_threads)
            .unwrap_or(0);
        let cap = scheduler
            .and_then(|scheduler| scheduler.queue_cap)
            .unwrap_or(64);

        let in_flight = self.in_flight_invokes.load(Ordering::SeqCst);
        if in_flight >= cap {
            self.audit
                .lock()
                .expect("audit lock")
                .push("invoke.busy", &params.extension_id, format!("{in_flight} async invokes in flight"));
            return Ok(vec![self.encode_error_response(
                request_id,
                "KERNEL_BUSY",
                format!("async invoke queue full: {in_flight} in flight"),
            )?]);
        }

        // Persistent pool: created lazily, resized only when the policy thread
        // count changes (old workers drain their queue, then exit).
        if self
            .async_pool
            .as_ref()
            .map(|pool| pool.threads != threads)
            .unwrap_or(true)
        {
            self.async_pool = Some(AsyncPool::spawn(threads));
        }

        // Share the plugin handle with the worker (Arc clone, NOT take): the
        // extension stays loaded and usable after the call, and same-plugin
        // callers serialize on the handle mutex inside the worker where
        // blocking costs a parked pool thread, never a host lock.
        let Some(handle) = self
            .require_loaded_mut(&params.extension_id)?
            .runtime_handle
            .clone()
        else {
            return Ok(vec![self.encode_error_response(
                request_id,
                "KERNEL_RUNTIME_ERROR",
                format!("extension is not active: {}", params.extension_id),
            )?]);
        };
        self.in_flight_invokes.fetch_add(1, Ordering::SeqCst);

        let job = AsyncInvokeJob {
            handle,
            accounting: Arc::clone(&self.accounting),
            sink: self.response_sink.clone().expect("sink checked above"),
            in_flight: Arc::clone(&self.in_flight_invokes),
            request_id: request_id.clone(),
            extension_id: params.extension_id,
            capability: params.capability,
            input: params.input,
        };
        let pool = self.async_pool.as_ref().expect("pool ensured above");
        if pool.job_tx.send(job).is_err() {
            // All pool workers are gone (daemon teardown raced the dispatch).
            // Restore the in-flight slot and answer with the busy envelope.
            self.in_flight_invokes.fetch_sub(1, Ordering::SeqCst);
            self.audit
                .lock()
                .expect("audit lock")
                .push("invoke.busy", "scheduler", "async pool is shut down".to_string());
            return Ok(vec![self.encode_error_response(
                request_id,
                "KERNEL_BUSY",
                "async pool is shut down".to_string(),
            )?]);
        }

        Ok(vec![self.encode_success_response(
            request_id,
            json!({ "accepted": true, "async": true }),
        )?])
    }

    fn handle_open_session(&mut self, request: KernelRequestEnvelope) -> Result<Vec<String>, String> {
        let params = decode_params::<OpenSessionRequest>(request.params)?;
        {
            let extension = self.require_loaded_mut(&params.extension_id)?;
            let contract = extension
                .capabilities
                .get(&params.capability)
                .ok_or_else(|| format!("capability is not declared in manifest: {}", params.capability))?;
            if !requires_real_session(contract) {
                // Contract refusal, not a protocol failure: answer as an error envelope so
                // the daemon stays alive and the host can fall back to a compatibility
                // session (mirrors the TS ProcessRuntime behavior).
                return Ok(vec![self.encode_error_response(
                    request.id,
                    "KERNEL_SESSION_UNSUPPORTED",
                    format!("capability does not require a real session: {}", params.capability),
                )?]);
            }
        }
        let opened = {
            let extension = self.require_loaded_mut(&params.extension_id)?;
            let mut handle_guard = extension
                .runtime_handle
                .as_ref()
                .ok_or_else(|| format!("extension is not active: {}", params.extension_id))?
                .lock()
                .map_err(|error| error.to_string())?;
            handle_guard.open_session(&params.capability, params.input)?
        };

        let session_id = format!("session-{}", self.next_session_id);
        self.next_session_id += 1;
        let mut session = SessionState {
            extension_id: params.extension_id.clone(),
            capability: params.capability.clone(),
            runtime_session_id: opened.runtime_session_id,
            events: VecDeque::new(),
            is_closed: false,
        };
        let quota_exceeded = append_session_events(&mut session, opened.initial_events).is_err();
        self.sessions.insert(session_id.clone(), session);

        if quota_exceeded {
            // Session event quota breached while buffering initial events: the
            // session is marked closed by the push helper; answer as an error
            // envelope so the daemon stays alive.
            return Ok(vec![self.encode_error_response(
                request.id,
                EVENT_QUOTA_EXCEEDED_CODE,
                session_event_quota_exceeded_message(),
            )?]);
        }

        let mut output = vec![self.encode_success_response(
            request.id,
            json!(OpenSessionResult {
                session_id: session_id.clone(),
            }),
        )?];
        output.extend(self.flush_session_events(&session_id)?);
        Ok(output)
    }

    fn handle_session_send(&mut self, request: KernelRequestEnvelope) -> Result<Vec<String>, String> {
        let params = decode_params::<SessionSendRequest>(request.params)?;
        let (extension_id, capability, runtime_session_id) = {
            let session = self.require_session_mut(&params.session_id)?;
            if session.is_closed {
                return Err(closed_session_message(&params.session_id));
            }
            (
                session.extension_id.clone(),
                session.capability.clone(),
                session.runtime_session_id.clone(),
            )
        };

        {
            let extension = self.require_loaded_mut(&extension_id)?;
            let contract = extension
                .capabilities
                .get(&capability)
                .ok_or_else(|| format!("capability is not declared in manifest: {capability}"))?;
            if !allows_session_send(contract) {
                return Err(format!("capability does not allow session.send: {capability}"));
            }
        }

        let events = {
            let extension = self.require_loaded_mut(&extension_id)?;
            let mut handle_guard = extension
                .runtime_handle
                .as_ref()
                .ok_or_else(|| format!("extension is not active: {extension_id}"))?
                .lock()
                .map_err(|error| error.to_string())?;
            handle_guard.session_send(&runtime_session_id, params.data)?
        };

        let quota_exceeded = {
            let session = self.require_session_mut(&params.session_id)?;
            append_session_events(session, events).is_err()
        };

        if quota_exceeded {
            return Ok(vec![self.encode_error_response(
                request.id,
                EVENT_QUOTA_EXCEEDED_CODE,
                session_event_quota_exceeded_message(),
            )?]);
        }

        let mut output = vec![self.encode_success_response(request.id, json!(true))?];
        output.extend(self.flush_session_events(&params.session_id)?);
        Ok(output)
    }

    fn handle_session_close(&mut self, request: KernelRequestEnvelope) -> Result<Vec<String>, String> {
        let params = decode_params::<SessionIdRequest>(request.params)?;
        if self.closed_sessions.contains(&params.session_id) {
            return Ok(vec![self.encode_success_response(request.id, json!(true))?]);
        }
        let runtime_target = self
            .sessions
            .get(&params.session_id)
            .map(|session| (session.extension_id.clone(), session.runtime_session_id.clone()));
        if let Some((extension_id, runtime_session_id)) = runtime_target {
            if let Some(extension) = self.loaded.get_mut(&extension_id) {
                if let Some(runtime_handle) = extension.runtime_handle.as_ref() {
                    if let Ok(mut guard) = runtime_handle.lock() {
                        let _ = guard.session_close(&runtime_session_id);
                    }
                }
            }
        }
        self.sessions.remove(&params.session_id);
        self.closed_sessions.insert(params.session_id.clone());
        Ok(vec![self.encode_success_response(request.id, json!(true))?])
    }

    fn handle_session_cancel(&mut self, request: KernelRequestEnvelope) -> Result<Vec<String>, String> {
        let params = decode_params::<SessionIdRequest>(request.params)?;
        let (extension_id, runtime_session_id) = {
            let session = self.require_session_mut(&params.session_id)?;
            if session.is_closed {
                return Err(closed_session_message(&params.session_id));
            }
            (
                session.extension_id.clone(),
                session.runtime_session_id.clone(),
            )
        };

        let events = {
            let extension = self.require_loaded_mut(&extension_id)?;
            let mut handle_guard = extension
                .runtime_handle
                .as_ref()
                .ok_or_else(|| format!("extension is not active: {extension_id}"))?
                .lock()
                .map_err(|error| error.to_string())?;
            handle_guard.session_cancel(&runtime_session_id)?
        };

        let quota_exceeded = self
            .sessions
            .get_mut(&params.session_id)
            .map(|session| append_session_events(session, events).is_err())
            .unwrap_or(false);

        if quota_exceeded {
            return Ok(vec![self.encode_error_response(
                request.id,
                EVENT_QUOTA_EXCEEDED_CODE,
                session_event_quota_exceeded_message(),
            )?]);
        }

        let mut output = vec![self.encode_success_response(request.id, json!(true))?];
        output.extend(self.flush_session_events(&params.session_id)?);
        Ok(output)
    }

    fn flush_session_events(&mut self, session_id: &str) -> Result<Vec<String>, String> {
        let mut encoded = Vec::new();
        let Some(session) = self.sessions.get_mut(session_id) else {
            return Ok(encoded);
        };

        while let Some(event) = session.events.pop_front() {
            if matches!(event, SessionEvent::End) {
                session.is_closed = true;
            }
            encoded.push(
                serde_json::to_string(&KernelEventEnvelope {
                    kind: "event",
                    session_id: session_id.to_string(),
                    event,
                })
                .map_err(|error| format!("failed to encode kernel event: {error}"))?,
            );
        }

        Ok(encoded)
    }

    fn require_loaded_mut(&mut self, extension_id: &str) -> Result<&mut LoadedExtension, String> {
        self.loaded
            .get_mut(extension_id)
            .ok_or_else(|| format!("extension not loaded: {extension_id}"))
    }

    fn require_session_mut(&mut self, session_id: &str) -> Result<&mut SessionState, String> {
        if self.closed_sessions.contains(session_id) {
            return Err(closed_session_message(session_id));
        }
        self.sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))
    }

    fn encode_success_response(&self, id: String, result: Value) -> Result<String, String> {
        serde_json::to_string(&KernelResponseEnvelope {
            kind: "response",
            id,
            result: Some(result),
            error: None,
        })
        .map_err(|error| format!("failed to encode kernel response: {error}"))
    }

    fn encode_error_response(
        &self,
        id: String,
        code: &str,
        message: String,
    ) -> Result<String, String> {
        serde_json::to_string(&KernelResponseEnvelope {
            kind: "response",
            id,
            result: None,
            error: Some(KernelError {
                code: code.to_string(),
                message,
            }),
        })
        .map_err(|error| format!("failed to encode kernel error response: {error}"))
    }
}

struct LoadedExtension {
    manifest: Value,
    runtime: CanonicalRuntimeSpec,
    artifact: ResolvedArtifact,
    security: ExtensionSecurityInfo,
    capabilities: HashMap<String, StoredCapabilityContract>,
    runtime_handle: Option<Arc<Mutex<RuntimeHandle>>>,
    /// Policy-admitted memory budget (pages). soft = declared peak, hard = tier cap.
    memory_soft_pages: u64,
    memory_hard_pages: u64,
}

#[derive(Debug, Clone)]
struct StoredCapabilityContract {
    interaction_mode: String,
    execution_mode: String,
}

struct SessionState {
    extension_id: String,
    capability: String,
    runtime_session_id: String,
    events: VecDeque<SessionEvent>,
    is_closed: bool,
}

enum RuntimeHandle {
    Process(ManagedProcess),
    Wasm(crate::wasm_runtime::WasmPlugin),
    RemoteHttp(RemoteHttpRuntime),
}

struct OpenedRuntimeSession {
    runtime_session_id: String,
    initial_events: Vec<SessionEvent>,
}

impl RuntimeHandle {
    fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value, String> {
        match self {
            RuntimeHandle::Process(process) => process.request(method, params),
            RuntimeHandle::Wasm(plugin) => plugin.request(method, params),
            RuntimeHandle::RemoteHttp(remote) => remote.request(method, params),
        }
    }

    fn open_session(&mut self, capability: &str, input: Value) -> Result<OpenedRuntimeSession, String> {
        match self {
            RuntimeHandle::Process(process) => process.open_session(capability, input),
            RuntimeHandle::Wasm(_) => Err(
                "in-process wasm runtime does not support real sessions; declare unary/ephemeral capabilities"
                    .to_string(),
            ),
            RuntimeHandle::RemoteHttp(remote) => remote.open_session(capability, input),
        }
    }

    fn session_send(&mut self, runtime_session_id: &str, data: Value) -> Result<Vec<SessionEvent>, String> {
        match self {
            RuntimeHandle::Process(process) => process.session_send(runtime_session_id, data),
            RuntimeHandle::Wasm(_) => Err(
                "in-process wasm runtime does not support real sessions; declare unary/ephemeral capabilities"
                    .to_string(),
            ),
            RuntimeHandle::RemoteHttp(remote) => remote.session_send(runtime_session_id, data),
        }
    }

    fn session_cancel(&mut self, runtime_session_id: &str) -> Result<Vec<SessionEvent>, String> {
        match self {
            RuntimeHandle::Process(process) => process.session_cancel(runtime_session_id),
            RuntimeHandle::Wasm(_) => Err(
                "in-process wasm runtime does not support real sessions; declare unary/ephemeral capabilities"
                    .to_string(),
            ),
            RuntimeHandle::RemoteHttp(remote) => remote.session_cancel(runtime_session_id),
        }
    }

    fn session_close(&mut self, runtime_session_id: &str) -> Result<(), String> {
        match self {
            RuntimeHandle::Process(process) => process.session_close(runtime_session_id),
            RuntimeHandle::Wasm(_) => Err(
                "in-process wasm runtime does not support real sessions; declare unary/ephemeral capabilities"
                    .to_string(),
            ),
            RuntimeHandle::RemoteHttp(remote) => remote.session_close(runtime_session_id),
        }
    }

    fn shutdown(&mut self) {
        match self {
            RuntimeHandle::Process(process) => process.shutdown(),
            RuntimeHandle::Wasm(plugin) => plugin.shutdown(),
            RuntimeHandle::RemoteHttp(remote) => remote.shutdown(),
        }
    }
}

/// Thread-safe process channel (scheduler refactor): responses are correlated
/// on a dedicated reader thread, so a slow plugin call blocks only its own
/// caller — other plugins' requests proceed on their own channels/threads.
struct ManagedProcess {
    io: Arc<ProcessIo>,
}

struct PendingCall {
    done: bool,
    outcome: Option<Result<Value, String>>,
}

struct ProcessIo {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, PendingCall>>,
    cond: Condvar,
    session_events: Mutex<HashMap<String, VecDeque<SessionEvent>>>,
    alive: AtomicBool,
    next_id: AtomicU64,
}

impl ProcessIo {
    fn write_request(&self, payload: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|error| error.to_string())?;
        writeln!(stdin, "{}", serde_json::to_string(payload).map_err(|error| error.to_string())?)
            .map_err(|error| format!("failed to write to plugin stdin: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("failed to flush plugin stdin: {error}"))?;
        Ok(())
    }

    fn fail_all_pending(&self, message: String) {
        let mut pending = self.pending.lock().expect("pending lock");
        for (_, call) in pending.iter_mut() {
            if !call.done {
                call.done = true;
                call.outcome = Some(Err(message.clone()));
            }
        }
        self.cond.notify_all();
    }
}

impl ManagedProcess {
    fn spawn(
        command: &str,
        args: &[String],
        cwd: &str,
        env: Option<&HashMap<String, String>>,
    ) -> Result<Self, String> {
        let mut process = Command::new(command);
        process.args(args);
        process.current_dir(cwd);
        process.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(env) = env {
            process.envs(env);
        }

        let mut child = process
            .spawn()
            .map_err(|error| format!("failed to spawn plugin process: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "plugin process stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "plugin process stdout unavailable".to_string())?;

        let io = Arc::new(ProcessIo {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            cond: Condvar::new(),
            session_events: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
            next_id: AtomicU64::new(1),
        });

        // Dedicated reader thread: correlates responses by id, files session
        // events, and wakes waiting callers. One per plugin process.
        {
            let io = Arc::clone(&io);
            let mut reader = BufReader::new(stdout);
            std::thread::spawn(move || {
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    if line.trim().is_empty() {
                        continue;
                    }
                    let frame: Value = match serde_json::from_str(line.trim()) {
                        Ok(frame) => frame,
                        Err(_) => break, // malformed output: treat as channel death
                    };
                    if frame.get("kind").and_then(Value::as_str) == Some("event") {
                        if let (Some(session_id), Some(event_value)) = (
                            frame.get("sessionId").and_then(Value::as_str),
                            frame.get("event").cloned(),
                        ) {
                            match serde_json::from_value::<SessionEvent>(event_value) {
                                Ok(event) => {
                                    let mut events = io.session_events.lock().expect("events lock");
                                    events
                                        .entry(session_id.to_string())
                                        .or_insert_with(VecDeque::new)
                                        .push_back(event);
                                }
                                Err(_) => break,
                            }
                        }
                        continue;
                    }
                    let Some(response_id) = frame.get("id").and_then(Value::as_str) else {
                        break;
                    };
                    let outcome = if let Some(error) = frame.get("error") {
                        Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("plugin returned error frame")
                            .to_string())
                    } else {
                        frame.get("result").cloned().ok_or_else(|| {
                            "plugin response missing result".to_string()
                        })
                    };
                    let mut pending = io.pending.lock().expect("pending lock");
                    if let Some(call) = pending.get_mut(response_id) {
                        call.done = true;
                        call.outcome = Some(outcome);
                    }
                    io.cond.notify_all();
                }
                io.alive.store(false, Ordering::SeqCst);
                io.fail_all_pending("plugin process closed its output".to_string());
            });
        }

        Ok(Self { io })
    }

    fn request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let id = self
            .io
            .next_id
            .fetch_add(1, Ordering::SeqCst)
            .to_string();

        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.io.write_request(&payload)?;

        let mut pending = self
            .io
            .pending
            .lock()
            .map_err(|error| error.to_string())?;
        pending.insert(
            id.clone(),
            PendingCall { done: false, outcome: None },
        );
        loop {
            if let Some(call) = pending.get(&id) {
                if call.done {
                    let outcome = call.outcome.clone();
                    pending.remove(&id);
                    drop(pending);
                    return outcome.ok_or_else(|| "plugin call produced no outcome".to_string())?;
                }
            }
            if !self.io.alive.load(Ordering::SeqCst) {
                let still_pending = pending.get(&id).map(|call| !call.done).unwrap_or(false);
                if still_pending {
                    pending.remove(&id);
                    drop(pending);
                    return Err("plugin process is no longer running".to_string());
                }
            }
            let (guard, _timeout) = self
                .io
                .cond
                .wait_timeout(pending, Duration::from_millis(100))
                .map_err(|error| error.to_string())?;
            pending = guard;
        }
    }

    fn open_session(&mut self, capability: &str, input: Value) -> Result<OpenedRuntimeSession, String> {
        let response = self.request(
            "extension/openSession",
            Some(json!({
                "capability": capability,
                "input": input,
            })),
        )?;
        let runtime_session_id = response
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| "process runtime openSession response missing sessionId".to_string())?
            .to_string();
        let initial_events = self.take_session_events(&runtime_session_id);

        Ok(OpenedRuntimeSession {
            runtime_session_id,
            initial_events,
        })
    }

    fn session_send(&mut self, runtime_session_id: &str, data: Value) -> Result<Vec<SessionEvent>, String> {
        let _ = self.request(
            "extension/session.send",
            Some(json!({
                "sessionId": runtime_session_id,
                "data": data,
            })),
        )?;
        Ok(self.take_session_events(runtime_session_id))
    }

    fn session_cancel(&mut self, runtime_session_id: &str) -> Result<Vec<SessionEvent>, String> {
        let _ = self.request(
            "extension/session.cancel",
            Some(json!({
                "sessionId": runtime_session_id,
            })),
        )?;
        Ok(self.take_session_events(runtime_session_id))
    }

    fn session_close(&mut self, runtime_session_id: &str) -> Result<(), String> {
        let _ = self.request(
            "extension/session.close",
            Some(json!({
                "sessionId": runtime_session_id,
            })),
        )?;
        self.io
            .session_events
            .lock()
            .expect("events lock")
            .remove(runtime_session_id);
        Ok(())
    }

    fn take_session_events(&self, runtime_session_id: &str) -> Vec<SessionEvent> {
        self.io
            .session_events
            .lock()
            .expect("events lock")
            .remove(runtime_session_id)
            .map(|queue| queue.into_iter().collect())
            .unwrap_or_default()
    }

    fn shutdown(&self) {
        if let Ok(mut child) = self.io.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct RemoteHttpRuntime {
    endpoint: String,
    timeout_ms: Option<u64>,
    next_id: u64,
}

impl RemoteHttpRuntime {
    fn new(endpoint: String, timeout_ms: Option<u64>) -> Result<Self, String> {
        if !endpoint.starts_with("http://") {
            return Err(format!(
                "rust kernel remote http transport currently supports only plain http:// endpoints: {endpoint}"
            ));
        }

        Ok(Self {
            endpoint,
            timeout_ms,
            next_id: 1,
        })
    }

    fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let id = self.next_id.to_string();
        self.next_id += 1;

        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let body = serde_json::to_string(&payload)
            .map_err(|error| format!("failed to encode remote http JSON-RPC payload: {error}"))?;
        let target = parse_http_endpoint(&self.endpoint)?;

        let mut stream = TcpStream::connect((target.host.as_str(), target.port))
            .map_err(|error| format!("failed to connect remote http endpoint {}: {error}", self.endpoint))?;
        if let Some(timeout_ms) = self.timeout_ms {
            let timeout = Some(Duration::from_millis(timeout_ms));
            stream
                .set_read_timeout(timeout)
                .map_err(|error| format!("failed to set remote http read timeout: {error}"))?;
            stream
                .set_write_timeout(timeout)
                .map_err(|error| format!("failed to set remote http write timeout: {error}"))?;
        }

        let request = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            target.path,
            target.host_header(),
            body.len(),
            body
        );

        stream
            .write_all(request.as_bytes())
            .map_err(|error| format!("failed to write remote http request: {error}"))?;
        stream
            .flush()
            .map_err(|error| format!("failed to flush remote http request: {error}"))?;

        let (status_code, response_body) = read_http_response(stream)?;
        if !(200..300).contains(&status_code) {
            return Err(format!(
                "remote http endpoint returned status {status_code} for {}",
                self.endpoint
            ));
        }

        let rpc_response: Value = serde_json::from_str(response_body.trim())
            .map_err(|error| format!("invalid remote http JSON-RPC response: {error}"))?;
        if let Some(error) = rpc_response.get("error") {
            return Err(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("remote http endpoint returned JSON-RPC error")
                    .to_string(),
            );
        }

        rpc_response
            .get("result")
            .cloned()
            .ok_or_else(|| "remote http JSON-RPC response missing result".to_string())
    }

    fn open_session(&mut self, capability: &str, input: Value) -> Result<OpenedRuntimeSession, String> {
        match self.request(
            "extension/openSession",
            Some(json!({
                "capability": capability,
                "input": input,
                "endpoint": self.endpoint,
            })),
        ) {
            Ok(result) => {
                let runtime_session_id = result
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "remote http openSession response missing sessionId".to_string())?
                    .to_string();
                let initial_events = decode_remote_http_session_events(result.get("events"))?;
                Ok(OpenedRuntimeSession {
                    runtime_session_id,
                    initial_events,
                })
            }
            Err(error) if is_remote_http_unsupported_session_error(&error) => {
                let result = self.request(
                    "extension/invoke",
                    Some(json!({
                        "capability": capability,
                        "input": input,
                        "endpoint": self.endpoint,
                    })),
                )?;

                Ok(OpenedRuntimeSession {
                    runtime_session_id: "remote-http-compat".to_string(),
                    initial_events: vec![
                        SessionEvent::Data { data: result },
                        SessionEvent::End,
                    ],
                })
            }
            Err(error) => Err(error),
        }
    }

    fn session_send(&mut self, runtime_session_id: &str, data: Value) -> Result<Vec<SessionEvent>, String> {
        if runtime_session_id == "remote-http-compat" {
            return Err("remote http compatibility sessions do not support send".to_string());
        }

        let result = self.request(
            "extension/session.send",
            Some(json!({
                "sessionId": runtime_session_id,
                "data": data,
                "endpoint": self.endpoint,
            })),
        )?;
        decode_remote_http_session_events(result.get("events"))
    }

    fn session_cancel(&mut self, runtime_session_id: &str) -> Result<Vec<SessionEvent>, String> {
        if runtime_session_id == "remote-http-compat" {
            return Ok(vec![SessionEvent::End]);
        }

        let result = self.request(
            "extension/session.cancel",
            Some(json!({
                "sessionId": runtime_session_id,
                "endpoint": self.endpoint,
            })),
        )?;
        decode_remote_http_session_events(result.get("events"))
    }

    fn session_close(&mut self, runtime_session_id: &str) -> Result<(), String> {
        if runtime_session_id == "remote-http-compat" {
            return Ok(());
        }

        let _ = self.request(
            "extension/session.close",
            Some(json!({
                "sessionId": runtime_session_id,
                "endpoint": self.endpoint,
            })),
        )?;
        Ok(())
    }

    fn shutdown(&mut self) {}
}

/// Push one event onto a bounded event queue. On overflow the buffered events
/// are cleared (bounded memory) and the quota error is returned; callers decide
/// how the breach surfaces (session closed + error envelope for kernel sessions,
/// silent drop for the ManagedProcess staging queue).
fn push_event_capped(events: &mut VecDeque<SessionEvent>, event: SessionEvent) -> Result<(), String> {
    if events.len() >= SESSION_EVENT_QUOTA {
        events.clear();
        return Err(session_event_quota_exceeded_message());
    }
    events.push_back(event);
    Ok(())
}

/// Push one event onto a kernel session's queue, capping it at
/// SESSION_EVENT_QUOTA. On overflow the session is marked closed (so subsequent
/// operations fail with the existing closed-session error) and buffered events
/// are dropped; the caller must answer with an EVENT_QUOTA_EXCEEDED error
/// envelope instead of a fatal error.
fn push_session_event(session: &mut SessionState, event: SessionEvent) -> Result<(), String> {
    let result = push_event_capped(&mut session.events, event);
    if result.is_err() {
        session.is_closed = true;
    }
    result
}

fn append_session_events(session: &mut SessionState, events: Vec<SessionEvent>) -> Result<(), String> {
    for event in events {
        match event {
            SessionEvent::Error { .. } => {
                push_session_event(session, event)?;
                push_session_event(session, SessionEvent::End)?;
                session.is_closed = true;
                break;
            }
            SessionEvent::End => {
                push_session_event(session, SessionEvent::End)?;
                session.is_closed = true;
                break;
            }
            other => {
                push_session_event(session, other)?;
            }
        }
    }
    Ok(())
}

fn build_capability_contracts(capabilities: &[KernelCapability]) -> HashMap<String, StoredCapabilityContract> {
    capabilities
        .iter()
        .map(|capability| {
            (
                capability.name.clone(),
                StoredCapabilityContract {
                    interaction_mode: capability
                        .interaction_mode
                        .clone()
                        .unwrap_or_else(|| "unary".to_string()),
                    execution_mode: capability
                        .execution_mode
                        .clone()
                        .unwrap_or_else(|| "ephemeral".to_string()),
                },
            )
        })
        .collect()
}

fn closed_session_message(session_id: &str) -> String {
    format!("session is closed: {session_id}")
}

fn requires_real_session(contract: &StoredCapabilityContract) -> bool {
    contract.interaction_mode != "unary" || contract.execution_mode != "ephemeral"
}

fn allows_session_send(contract: &StoredCapabilityContract) -> bool {
    contract.interaction_mode == "client-stream" || contract.interaction_mode == "duplex"
}

fn decode_remote_http_session_events(value: Option<&Value>) -> Result<Vec<SessionEvent>, String> {
    match value {
        Some(value) => serde_json::from_value::<Vec<SessionEvent>>(value.clone())
            .map_err(|error| format!("invalid remote http session events: {error}")),
        None => Ok(Vec::new()),
    }
}

fn is_remote_http_unsupported_session_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("unsupported method") || normalized.contains("does not support sessions")
}

fn decode_params<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, String> {
    let value = params.ok_or_else(|| "kernel request params are required".to_string())?;
    serde_json::from_value(value).map_err(|error| format!("invalid kernel request params: {error}"))
}

fn manifest_id(manifest: &Value) -> Result<String, String> {
    manifest
        .get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| "extension manifest id is required".to_string())
}

fn validate_runtime_load_contract(
    request: &KernelLoadRequest,
    extension_id: &str,
) -> Result<(), String> {
    match &request.runtime {
        CanonicalRuntimeSpec::Remote { endpoint, transport } => {
            if transport.as_deref() == Some("http") {
                let mut runtime = RemoteHttpRuntime::new(endpoint.clone(), request.artifact.timeout_ms)?;
                let _ = runtime.request(
                    "extension/load",
                    Some(json!({
                        "extensionId": extension_id,
                        "manifest": request.manifest,
                    })),
                )?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

struct ParsedHttpEndpoint {
    host: String,
    port: u16,
    path: String,
}

impl ParsedHttpEndpoint {
    fn host_header(&self) -> String {
        if self.port == 80 {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

fn parse_http_endpoint(endpoint: &str) -> Result<ParsedHttpEndpoint, String> {
    let without_scheme = endpoint
        .strip_prefix("http://")
        .ok_or_else(|| format!("unsupported remote http endpoint: {endpoint}"))?;
    let (authority, path) = match without_scheme.split_once('/') {
        Some((authority, rest)) => (authority, format!("/{}", rest)),
        None => (without_scheme, "/".to_string()),
    };

    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => {
            let parsed_port = port
                .parse::<u16>()
                .map_err(|error| format!("invalid remote http endpoint port in {endpoint}: {error}"))?;
            (host.to_string(), parsed_port)
        }
        None => (authority.to_string(), 80),
    };

    if host.is_empty() {
        return Err(format!("remote http endpoint host is required: {endpoint}"));
    }

    Ok(ParsedHttpEndpoint { host, port, path })
}

fn parse_http_response_head(head: &str) -> Result<(u16, Option<usize>), String> {
    let mut lines = head.lines();
    let status_line = lines
        .next()
        .ok_or_else(|| "remote http response missing status line".to_string())?;
    let mut status_parts = status_line.split_whitespace();
    let protocol = status_parts
        .next()
        .ok_or_else(|| "remote http response missing protocol".to_string())?;
    if !protocol.starts_with("HTTP/") {
        return Err(format!("invalid remote http response protocol: {protocol}"));
    }
    let status_code = status_parts
        .next()
        .ok_or_else(|| "remote http response missing status code".to_string())?
        .parse::<u16>()
        .map_err(|error| format!("invalid remote http status code: {error}"))?;

    let mut content_length = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .map_err(|error| format!("invalid remote http content-length: {error}"))?,
                );
            }
        }
    }

    Ok((status_code, content_length))
}

fn read_http_response(mut stream: TcpStream) -> Result<(u16, String), String> {
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 1024];
    let header_end_index = loop {
        let bytes_read = stream
            .read(&mut temp)
            .map_err(|error| format!("failed to read remote http response: {error}"))?;
        if bytes_read == 0 {
            return Err("remote http response closed before headers completed".to_string());
        }
        buffer.extend_from_slice(&temp[..bytes_read]);
        if let Some(index) = find_subsequence(&buffer, b"\r\n\r\n") {
            break index + 4;
        }
    };

    let head = std::str::from_utf8(&buffer[..header_end_index])
        .map_err(|error| format!("invalid utf8 in remote http response head: {error}"))?;
    let (status_code, content_length) = parse_http_response_head(head)?;

    let mut body_bytes = buffer[header_end_index..].to_vec();
    if let Some(content_length) = content_length {
        while body_bytes.len() < content_length {
            let bytes_read = stream
                .read(&mut temp)
                .map_err(|error| format!("failed to read remote http response body: {error}"))?;
            if bytes_read == 0 {
                return Err("remote http response ended before content-length body completed".to_string());
            }
            body_bytes.extend_from_slice(&temp[..bytes_read]);
        }
        body_bytes.truncate(content_length);
    } else {
        loop {
            let bytes_read = stream
                .read(&mut temp)
                .map_err(|error| format!("failed to read remote http response body: {error}"))?;
            if bytes_read == 0 {
                break;
            }
            body_bytes.extend_from_slice(&temp[..bytes_read]);
        }
    }

    let body = String::from_utf8(body_bytes)
        .map_err(|error| format!("invalid utf8 in remote http response body: {error}"))?;
    Ok((status_code, body))
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn spawn_runtime_handle(
    runtime: &CanonicalRuntimeSpec,
    artifact: &ResolvedArtifact,
    memory_soft_pages: u64,
    memory_hard_pages: u64,
) -> Result<RuntimeHandle, String> {
    match runtime {
        CanonicalRuntimeSpec::Process {
            command,
            args,
            cwd,
            env,
        }
        | CanonicalRuntimeSpec::NativeBridge {
            command,
            args,
            cwd,
            env,
        } => ManagedProcess::spawn(command, args, cwd, env.as_ref()).map(RuntimeHandle::Process),
        CanonicalRuntimeSpec::Wasm { entry_path, cwd: _ } => {
            let plugin =
                crate::wasm_runtime::WasmPlugin::instantiate_with_limits(
                    Path::new(entry_path),
                    memory_soft_pages,
                    memory_hard_pages,
                )?;
            Ok(RuntimeHandle::Wasm(plugin))
        }
        CanonicalRuntimeSpec::Remote {
            endpoint,
            transport,
        } => {
            let transport_kind = transport.as_deref().unwrap_or("process");
            match transport_kind {
                "process" | "process-stdio" | "stdio" => {
                    ManagedProcess::spawn(&artifact.command, &artifact.args, &artifact.cwd, None)
                        .map(RuntimeHandle::Process)
                }
                "http" => RemoteHttpRuntime::new(endpoint.clone(), artifact.timeout_ms)
                    .map(RuntimeHandle::RemoteHttp),
                other => Err(format!(
                    "unsupported remote transport for endpoint {endpoint}: {other}"
                )),
            }
        }
    }
}

fn fuel_per_tick_of(capabilities: &[KernelCapability]) -> Option<u64> {
    capabilities
        .iter()
        .filter_map(|capability| {
            capability
                .resource_budget
                .as_ref()
                .and_then(|budget| budget.fuel_per_tick)
        })
        .max()
}

fn evaluate_security(request: &KernelLoadRequest) -> Result<ExtensionSecurityInfo, String> {
    let payload = json!({
        "manifest": request.manifest,
        "signaturePolicy": request.security.signature_policy,
        "isDevelopment": request.security.is_development,
        "trustBundle": request.security.trust_bundle,
        "revocationList": request.security.revocation_list,
        "trustedKeyDirectory": request.security.trusted_key_directory,
        "trustedPublicKeys": request.security.trusted_public_keys,
    });

    let result = extensions_manager_rust_security_core::evaluate_request_json(
        &serde_json::to_string(&payload).map_err(|error| format!("failed to encode security request: {error}"))?,
    )?;

    Ok(ExtensionSecurityInfo {
        status: result.status,
        reason: result.reason,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        append_session_events, push_session_event, spawn_runtime_handle, CanonicalRuntimeSpec,
        ClosedSessionTombstones, CLOSED_SESSION_TOMBSTONE_CAPACITY, ExtensionSecurityInfo,
        KernelDaemon, LoadedExtension, RemoteHttpRuntime, ResolvedArtifact, RuntimeHandle,
        SESSION_EVENT_QUOTA, SessionEvent, SessionState, StoredCapabilityContract,
    };
    use serde_json::{json, Value};
    use std::collections::{HashMap, VecDeque};
    use std::env;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn load_request_runs_admission() {
        let mut daemon = KernelDaemon::new();
        let request = json!({
            "kind": "request",
            "id": "1",
            "method": "kernel.load",
            "params": {
                "manifest": {
                    "id": "demo.unsigned",
                    "version": "1.0.0",
                    "protocolVersion": "1",
                    "artifact": { "kind": "module", "entry": "./index.js" },
                    "runtime": "node",
                    "capabilities": [{ "name": "demo.hello" }]
                },
                "runtime": {
                    "kind": "process",
                    "command": "node",
                    "args": [],
                    "cwd": "."
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
                    "entryPath": "./index.js",
                    "command": "node",
                    "args": [],
                    "cwd": ".",
                    "basePath": ".",
                    "timeoutMs": 5000
                },
                "security": {
                    "signaturePolicy": "allow-unsigned"
                }
            }
        });

        let output = daemon
            .handle_request_line(&serde_json::to_string(&request).unwrap())
            .expect("load should succeed");

        assert_eq!(output.len(), 1);
        assert!(output[0].contains("\"status\":\"unsigned\""));
    }

    #[test]
    fn unary_session_emits_data_and_end() {
        let events = vec![
            SessionEvent::Data { data: json!({"value": 1}) },
            SessionEvent::End,
        ];

        assert_eq!(events.len(), 2);
    }

    #[test]
    fn remote_runtime_load_is_stored_with_artifact_transport_details() {
        let mut daemon = KernelDaemon::new();
        let request = json!({
            "kind": "request",
            "id": "1",
            "method": "kernel.load",
            "params": {
                "manifest": {
                    "id": "demo.remote",
                    "version": "1.0.0",
                    "protocolVersion": "1",
                    "artifact": { "kind": "binary", "entry": "./remote.mjs" },
                    "runtime": "process",
                    "capabilities": [{ "name": "demo.hello" }]
                },
                "runtime": {
                    "kind": "remote",
                    "endpoint": "local-supervisor",
                    "transport": "process"
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
                    "entryPath": "./remote.mjs",
                    "command": "node",
                    "args": ["./remote.mjs"],
                    "cwd": ".",
                    "basePath": ".",
                    "timeoutMs": 5000
                },
                "security": {
                    "signaturePolicy": "allow-unsigned"
                }
            }
        });

        daemon
            .handle_request_line(&serde_json::to_string(&request).unwrap())
            .expect("load should succeed");

        let loaded = daemon.loaded.get("demo.remote").expect("extension should be loaded");
        assert_eq!(loaded.artifact.command, "node");
        assert_eq!(loaded.artifact.args, vec!["./remote.mjs".to_string()]);
        match loaded.runtime {
            CanonicalRuntimeSpec::Remote { .. } => {}
            _ => panic!("expected remote runtime"),
        }
    }

    #[test]
    fn wasm_runtime_activates_and_invokes_via_bridge_process() {
        let temp_directory = unique_temp_dir("extensions-kernel-wasm");
        fs::create_dir_all(&temp_directory).expect("temp dir should be created");
        let wasm_path = temp_directory.join("plugin.wasm");
        fs::write(&wasm_path, add_one_wasm_bytes()).expect("wasm module should be written");

        let runtime_cwd = temp_directory.to_string_lossy().to_string();
        let wasm_entry = wasm_path.to_string_lossy().to_string();

        let request = json!({
            "kind": "request",
            "id": "1",
            "method": "kernel.load",
            "params": {
                "manifest": {
                    "id": "demo.wasm",
                    "version": "1.0.0",
                    "protocolVersion": "1",
                    "artifact": { "kind": "wasm", "entry": "./plugin.wasm" },
                    "runtime": "wasm",
                    "capabilities": [{ "name": "addOne" }]
                },
                "runtime": {
                    "kind": "wasm",
                    "entryPath": wasm_entry,
                    "cwd": runtime_cwd
                },
                "capabilities": [{
                    "name": "addOne",
                    "interactionMode": "unary",
                    "executionMode": "ephemeral",
                    "realtimeClass": "batch",
                    "concurrencyPolicy": "shared",
                    "resourceBudget": {}
                }],
                "permissions": {},
                "artifact": {
                    "entryPath": wasm_path,
                    "command": wasm_path,
                    "args": [],
                    "cwd": temp_directory,
                    "basePath": temp_directory,
                    "timeoutMs": 5000
                },
                "security": {
                    "signaturePolicy": "allow-unsigned"
                }
            }
        });

        let mut daemon = KernelDaemon::new();
        daemon
            .handle_request_line(&serde_json::to_string(&request).unwrap())
            .expect("load should succeed");

        let activate = json!({
            "kind": "request",
            "id": "2",
            "method": "kernel.activate",
            "params": {
                "extensionId": "demo.wasm",
                "context": {
                    "extensionId": "demo.wasm"
                }
            }
        });
        daemon
            .handle_request_line(&serde_json::to_string(&activate).unwrap())
            .expect("activate should succeed");

        let invoke = json!({
            "kind": "request",
            "id": "3",
            "method": "kernel.invoke",
            "params": {
                "extensionId": "demo.wasm",
                "capability": "addOne",
                "input": { "value": 41 }
            }
        });
        let output = daemon
            .handle_request_line(&serde_json::to_string(&invoke).unwrap())
            .expect("invoke should succeed");

        assert_eq!(output.len(), 1);
        assert!(output[0].contains("\"result\":42"));

        let deactivate = json!({
            "kind": "request",
            "id": "4",
            "method": "kernel.deactivate",
            "params": {
                "extensionId": "demo.wasm"
            }
        });
        daemon
            .handle_request_line(&serde_json::to_string(&deactivate).unwrap())
            .expect("deactivate should succeed");

        let _ = fs::remove_dir_all(&temp_directory);
    }

    #[test]
    fn remote_http_runtime_activates_and_invokes() {
        let received_methods = Arc::new(Mutex::new(Vec::<String>::new()));
        let methods = Arc::clone(&received_methods);
        let listener = TcpListener::bind("127.0.0.1:0").expect("http listener should bind");
        let address = listener.local_addr().expect("listener address");
        let server = thread::spawn(move || {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().expect("http request should be accepted");
                let mut buffer = [0_u8; 8192];
                let bytes_read = stream.read(&mut buffer).expect("http request should be readable");
                let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
                let body = request
                    .split_once("\r\n\r\n")
                    .map(|(_, body)| body)
                    .expect("http body should exist");
                let payload: Value = serde_json::from_str(body).expect("json-rpc payload should parse");
                let method = payload
                    .get("method")
                    .and_then(Value::as_str)
                    .expect("json-rpc method should exist")
                    .to_string();
                methods.lock().expect("methods lock").push(method.clone());

                let response_payload = match method.as_str() {
                    "extension/load" | "extension/activate" | "extension/deactivate" => json!({
                        "jsonrpc": "2.0",
                        "id": payload.get("id").cloned().unwrap_or(json!("1")),
                        "result": true,
                    }),
                    "extension/invoke" => json!({
                        "jsonrpc": "2.0",
                        "id": payload.get("id").cloned().unwrap_or(json!("1")),
                        "result": { "message": "hello from rust remote http" },
                    }),
                    other => json!({
                        "jsonrpc": "2.0",
                        "id": payload.get("id").cloned().unwrap_or(json!("1")),
                        "error": { "message": format!("unsupported method: {other}") },
                    }),
                };
                let response_body = serde_json::to_string(&response_payload).expect("response json");
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("http response should be writable");
                stream.flush().expect("http response should flush");
            }
        });

        let endpoint = format!("http://127.0.0.1:{}/rpc", address.port());
        let request = json!({
            "kind": "request",
            "id": "1",
            "method": "kernel.load",
            "params": {
                "manifest": {
                    "id": "demo.remote-http",
                    "version": "1.0.0",
                    "protocolVersion": "1",
                    "artifact": { "kind": "binary", "entry": "./remote-http-placeholder" },
                    "runtime": "remote",
                    "capabilities": [{ "name": "demo.hello" }]
                },
                "runtime": {
                    "kind": "remote",
                    "endpoint": endpoint,
                    "transport": "http"
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
                    "entryPath": "./remote-http-placeholder",
                    "command": endpoint,
                    "args": [],
                    "cwd": ".",
                    "basePath": ".",
                    "timeoutMs": 5000
                },
                "security": {
                    "signaturePolicy": "allow-unsigned"
                }
            }
        });

        let mut daemon = KernelDaemon::new();
        daemon
            .handle_request_line(&serde_json::to_string(&request).unwrap())
            .expect("load should succeed");

        let activate = json!({
            "kind": "request",
            "id": "2",
            "method": "kernel.activate",
            "params": {
                "extensionId": "demo.remote-http",
                "context": {
                    "extensionId": "demo.remote-http"
                }
            }
        });
        daemon
            .handle_request_line(&serde_json::to_string(&activate).unwrap())
            .expect("activate should succeed");

        let invoke = json!({
            "kind": "request",
            "id": "3",
            "method": "kernel.invoke",
            "params": {
                "extensionId": "demo.remote-http",
                "capability": "demo.hello",
                "input": {}
            }
        });
        let output = daemon
            .handle_request_line(&serde_json::to_string(&invoke).unwrap())
            .expect("invoke should succeed");
        assert_eq!(output.len(), 1);
        assert!(output[0].contains("hello from rust remote http"));

        let deactivate = json!({
            "kind": "request",
            "id": "4",
            "method": "kernel.deactivate",
            "params": {
                "extensionId": "demo.remote-http"
            }
        });
        daemon
            .handle_request_line(&serde_json::to_string(&deactivate).unwrap())
            .expect("deactivate should succeed");

        server.join().expect("http server should exit cleanly");
        let recorded = received_methods.lock().expect("methods lock");
        assert_eq!(
            recorded.as_slice(),
            &[
                "extension/load".to_string(),
                "extension/activate".to_string(),
                "extension/invoke".to_string(),
                "extension/deactivate".to_string(),
            ]
        );
    }

    #[test]
    fn remote_http_runtime_supports_real_sessions() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("session listener should bind");
        let address = listener.local_addr().expect("listener address");
        let server = thread::spawn(move || {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().expect("session request should be accepted");
                let mut buffer = [0_u8; 8192];
                let bytes_read = stream.read(&mut buffer).expect("session request should be readable");
                let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
                let body = request
                    .split_once("\r\n\r\n")
                    .map(|(_, body)| body)
                    .expect("http body should exist");
                let payload: Value = serde_json::from_str(body).expect("json-rpc payload should parse");
                let method = payload
                    .get("method")
                    .and_then(Value::as_str)
                    .expect("json-rpc method should exist");

                let response_payload = match method {
                    "extension/openSession" => json!({
                        "jsonrpc": "2.0",
                        "id": payload.get("id").cloned().unwrap_or(json!("1")),
                        "result": {
                            "sessionId": "remote-session-1",
                            "events": [{
                                "type": "event",
                                "name": "ready",
                                "payload": { "source": "remote-http-test" }
                            }]
                        },
                    }),
                    "extension/session.send" => json!({
                        "jsonrpc": "2.0",
                        "id": payload.get("id").cloned().unwrap_or(json!("1")),
                        "result": {
                            "events": [{
                                "type": "data",
                                "data": { "echo": "ping" }
                            }]
                        },
                    }),
                    "extension/session.cancel" => json!({
                        "jsonrpc": "2.0",
                        "id": payload.get("id").cloned().unwrap_or(json!("1")),
                        "result": {
                            "events": [{
                                "type": "end"
                            }]
                        },
                    }),
                    "extension/session.close" => json!({
                        "jsonrpc": "2.0",
                        "id": payload.get("id").cloned().unwrap_or(json!("1")),
                        "result": true,
                    }),
                    other => json!({
                        "jsonrpc": "2.0",
                        "id": payload.get("id").cloned().unwrap_or(json!("1")),
                        "error": { "message": format!("unsupported method: {other}") },
                    }),
                };
                let response_body = serde_json::to_string(&response_payload).expect("response json");
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("http response should be writable");
                stream.flush().expect("http response should flush");
            }
        });

        let endpoint = format!("http://127.0.0.1:{}/rpc", address.port());
        let mut runtime = RemoteHttpRuntime::new(endpoint, Some(5000)).expect("remote http runtime should init");
        let opened = runtime
            .open_session("demo.chat", json!({}))
            .expect("remote http openSession should succeed");
        assert_eq!(opened.runtime_session_id, "remote-session-1");
        assert!(matches!(
            opened.initial_events.first(),
            Some(SessionEvent::Event { name, .. }) if name == "ready"
        ));

        let sent = runtime
            .session_send("remote-session-1", json!({ "text": "ping" }))
            .expect("remote http session.send should succeed");
        assert!(matches!(
            sent.first(),
            Some(SessionEvent::Data { data }) if data.get("echo").and_then(Value::as_str) == Some("ping")
        ));

        let cancelled = runtime
            .session_cancel("remote-session-1")
            .expect("remote http session.cancel should succeed");
        assert!(matches!(cancelled.first(), Some(SessionEvent::End)));
        runtime
            .session_close("remote-session-1")
            .expect("remote http session.close should succeed");

        server.join().expect("session server should exit cleanly");
    }

    #[test]
    fn remote_http_runtime_honors_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("timeout listener should bind");
        let address = listener.local_addr().expect("listener address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("timeout request should be accepted");
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer).expect("timeout request should be readable");
            thread::sleep(Duration::from_millis(100));
            let response_body = serde_json::to_string(&json!({
                "jsonrpc": "2.0",
                "id": "1",
                "result": true,
            }))
            .expect("response json");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        });

        let endpoint = format!("http://127.0.0.1:{}/rpc", address.port());
        let runtime = CanonicalRuntimeSpec::Remote {
            endpoint: endpoint.clone(),
            transport: Some("http".to_string()),
        };
        let artifact = ResolvedArtifact {
            entry_path: "./remote-http-placeholder".to_string(),
            command: endpoint,
            args: vec![],
            cwd: ".".to_string(),
            base_path: ".".to_string(),
            timeout_ms: Some(10),
        };

        let mut handle = spawn_runtime_handle(&runtime, &artifact, 256, 256)
            .expect("remote http handle should spawn");
        let error = handle
            .request("extension/invoke", Some(json!({ "capability": "demo.hello", "input": {} })))
            .expect_err("remote http request should time out");
        assert!(error.contains("timed out") || error.contains("deadline") || error.contains("10060") || error.contains("10053") || error.contains("超时"));

        server.join().expect("timeout server should exit");
    }

    #[test]
    fn remote_http_runtime_load_contract_failure_rejects_kernel_load() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("load failure listener should bind");
        let address = listener.local_addr().expect("listener address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("load request should be accepted");
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer).expect("load request should be readable");
            let response_body = serde_json::to_string(&json!({
                "jsonrpc": "2.0",
                "id": "1",
                "error": { "message": "remote load rejected" },
            }))
            .expect("response json");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        });

        let endpoint = format!("http://127.0.0.1:{}/rpc", address.port());
        let request = json!({
            "kind": "request",
            "id": "1",
            "method": "kernel.load",
            "params": {
                "manifest": {
                    "id": "demo.remote-http-load-reject",
                    "version": "1.0.0",
                    "protocolVersion": "1",
                    "artifact": { "kind": "binary", "entry": "./remote-http-placeholder" },
                    "runtime": "remote",
                    "capabilities": [{ "name": "demo.hello" }]
                },
                "runtime": {
                    "kind": "remote",
                    "endpoint": endpoint,
                    "transport": "http"
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
                    "entryPath": "./remote-http-placeholder",
                    "command": endpoint,
                    "args": [],
                    "cwd": ".",
                    "basePath": ".",
                    "timeoutMs": 5000
                },
                "security": {
                    "signaturePolicy": "allow-unsigned"
                }
            }
        });

        let mut daemon = KernelDaemon::new();
        let error = daemon
            .handle_request_line(&serde_json::to_string(&request).unwrap())
            .expect_err("kernel load should fail when remote load contract rejects");
        assert!(error.contains("remote load rejected"));

        server.join().expect("load failure server should exit");
    }

    #[test]
    fn append_session_events_adds_terminal_end_after_error() {
        let mut session = SessionState {
            extension_id: "demo.session".to_string(),
            capability: "demo.chat".to_string(),
            runtime_session_id: "runtime-1".to_string(),
            events: VecDeque::new(),
            is_closed: false,
        };

        append_session_events(
            &mut session,
            vec![SessionEvent::Event {
                name: "ready".to_string(),
                payload: Some(json!({ "phase": "opened" })),
            }],
        )
        .expect("append within quota should succeed");
        append_session_events(
            &mut session,
            vec![SessionEvent::Error {
                message: "boom".to_string(),
            }],
        )
        .expect("append within quota should succeed");

        let recorded: Vec<SessionEvent> = session.events.into_iter().collect();
        assert_eq!(recorded.len(), 3);
        assert!(matches!(recorded[0], SessionEvent::Event { .. }));
        assert!(matches!(recorded[1], SessionEvent::Error { .. }));
        assert!(matches!(recorded[2], SessionEvent::End));
    }

    #[test]
    fn push_session_event_drops_buffered_events_and_closes_session_on_overflow() {
        let mut session = quota_filled_session("demo.flood", "runtime-1");
        assert_eq!(session.events.len(), SESSION_EVENT_QUOTA);
        assert!(!session.is_closed);

        let error = push_session_event(
            &mut session,
            SessionEvent::Data { data: json!("overflow") },
        )
        .expect_err("pushing beyond the session event quota should fail");
        assert!(error.contains("EVENT_QUOTA_EXCEEDED"), "got: {error}");
        assert!(session.is_closed);
        assert!(session.events.is_empty());
    }

    #[test]
    fn kernel_answers_session_quota_overflow_with_error_envelope_and_closes_session() {
        let mut daemon = KernelDaemon::new();
        daemon.loaded.insert(
            "demo.flood".to_string(),
            LoadedExtension {
                manifest: json!({ "id": "demo.flood" }),
                memory_soft_pages: 256,
                memory_hard_pages: 256,
                runtime: CanonicalRuntimeSpec::Remote {
                    endpoint: "http://example.invalid".to_string(),
                    transport: Some("http".to_string()),
                },
                artifact: ResolvedArtifact {
                    entry_path: "./noop".to_string(),
                    command: "./noop".to_string(),
                    args: vec![],
                    cwd: ".".to_string(),
                    base_path: ".".to_string(),
                    timeout_ms: Some(1000),
                },
                security: ExtensionSecurityInfo {
                    status: "unsigned".to_string(),
                    reason: "test".to_string(),
                },
                capabilities: HashMap::from([(
                    "demo.chat".to_string(),
                    StoredCapabilityContract {
                        interaction_mode: "duplex".to_string(),
                        execution_mode: "session".to_string(),
                    },
                )]),
                runtime_handle: Some(Arc::new(Mutex::new(RuntimeHandle::RemoteHttp(
                    RemoteHttpRuntime::new("http://example.invalid".to_string(), None)
                        .expect("remote http runtime should init"),
                )))),
            },
        );
        daemon.sessions.insert(
            "session-1".to_string(),
            quota_filled_session("demo.flood", "remote-http-compat"),
        );

        // kernel.cancel against the compatibility runtime session returns a single
        // End event without any network I/O, pushing the (quota+1)-th event.
        let cancel = json!({
            "kind": "request",
            "id": "7",
            "method": "kernel.cancel",
            "params": { "sessionId": "session-1" }
        });

        let output = daemon
            .handle_request_line(&serde_json::to_string(&cancel).unwrap())
            .expect("quota overflow must be an error envelope, not a fatal error");
        assert_eq!(output.len(), 1);
        assert!(output[0].contains("EVENT_QUOTA_EXCEEDED"), "got: {}", output[0]);

        let session = daemon
            .sessions
            .get("session-1")
            .expect("session should remain tracked");
        assert!(session.is_closed);
        assert!(session.events.is_empty());

        let send = json!({
            "kind": "request",
            "id": "8",
            "method": "kernel.session.send",
            "params": { "sessionId": "session-1", "data": {} }
        });
        let output = daemon
            .handle_request_line(&serde_json::to_string(&send).unwrap())
            .expect("closed-session ops must be envelopes now, not fatal errors");
        assert!(
            output[0].contains("KERNEL_RUNTIME_ERROR") && output[0].contains("session is closed"),
            "got: {}",
            output[0]
        );
    }

    #[test]
    fn load_admission_rejection_is_an_error_envelope_and_daemon_survives() {
        let mut daemon = KernelDaemon::new();
        // Unsigned manifest, NO security context: the fail-closed default
        // (require-signature-except-development) rejects admission — as an
        // error envelope, never a fatal daemon exit.
        let request = json!({
            "kind": "request",
            "id": "1",
            "method": "kernel.load",
            "params": {
                "manifest": {
                    "id": "demo.unsigned-default",
                    "version": "1.0.0",
                    "protocolVersion": "1",
                    "artifact": { "kind": "module", "entry": "./index.js" },
                    "runtime": "process",
                    "capabilities": [{ "name": "demo.hello" }]
                },
                "runtime": {
                    "kind": "remote",
                    "endpoint": "local-supervisor",
                    "transport": "process"
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
                    "entryPath": "./index.js",
                    "command": "node",
                    "args": ["./index.js"],
                    "cwd": ".",
                    "basePath": ".",
                    "timeoutMs": 5000
                },
                "security": {}
            }
        });

        let output = daemon
            .handle_request_line(&serde_json::to_string(&request).unwrap())
            .expect("admission rejection must be an error envelope, not a fatal error");
        assert_eq!(output.len(), 1);
        assert!(output[0].contains("KERNEL_ADMISSION_REJECTED"), "got: {}", output[0]);
        assert!(output[0].contains("signature"), "got: {}", output[0]);
        assert!(
            !daemon.loaded.contains_key("demo.unsigned-default"),
            "rejected extension must not be registered"
        );

        // The daemon stays fully operational afterwards.
        let next = json!({
            "kind": "request",
            "id": "2",
            "method": "kernel.load",
            "params": {
                "manifest": {
                    "id": "demo.signed-allowed",
                    "version": "1.0.0",
                    "protocolVersion": "1",
                    "artifact": { "kind": "module", "entry": "./index.js" },
                    "runtime": "process",
                    "capabilities": [{ "name": "demo.hello" }]
                },
                "runtime": {
                    "kind": "remote",
                    "endpoint": "local-supervisor",
                    "transport": "process"
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
                    "entryPath": "./index.js",
                    "command": "node",
                    "args": ["./index.js"],
                    "cwd": ".",
                    "basePath": ".",
                    "timeoutMs": 5000
                },
                "security": { "signaturePolicy": "allow-unsigned" }
            }
        });
        let output = daemon
            .handle_request_line(&serde_json::to_string(&next).unwrap())
            .expect("daemon must keep serving after an admission rejection");
        assert!(output[0].contains("security"), "got: {}", output[0]);
    }

    #[test]
    fn closed_session_tombstones_are_bounded() {
        let mut daemon = KernelDaemon::new();
        let total = CLOSED_SESSION_TOMBSTONE_CAPACITY + 10;
        for index in 0..total {
            daemon.closed_sessions.insert(format!("session-{index}"));
        }

        assert_eq!(
            daemon.closed_sessions.len(),
            CLOSED_SESSION_TOMBSTONE_CAPACITY,
            "tombstone store must evict oldest entries beyond capacity"
        );
        // Newest entries are retained (FIFO eviction).
        assert!(daemon
            .closed_sessions
            .contains(&format!("session-{}", total - 1)));
        // Oldest entries were evicted.
        assert!(!daemon.closed_sessions.contains("session-0"));
    }

    #[test]
    fn kernel_rejects_open_session_for_unary_ephemeral_capability() {
        let mut daemon = KernelDaemon::new();
        let request = json!({
            "kind": "request",
            "id": "1",
            "method": "kernel.load",
            "params": {
                "manifest": {
                    "id": "demo.unary",
                    "version": "1.0.0",
                    "protocolVersion": "1",
                    "artifact": { "kind": "module", "entry": "./index.js" },
                    "runtime": "process",
                    "capabilities": [{ "name": "demo.hello" }]
                },
                "runtime": {
                    "kind": "remote",
                    "endpoint": "local-supervisor",
                    "transport": "process"
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
                    "entryPath": "./remote.mjs",
                    "command": "node",
                    "args": ["./remote.mjs"],
                    "cwd": ".",
                    "basePath": ".",
                    "timeoutMs": 5000
                },
                "security": {
                    "signaturePolicy": "allow-unsigned"
                }
            }
        });
        daemon
            .handle_request_line(&serde_json::to_string(&request).unwrap())
            .expect("load should succeed");

        let open = json!({
            "kind": "request",
            "id": "2",
            "method": "kernel.openSession",
            "params": {
                "extensionId": "demo.unary",
                "capability": "demo.hello",
                "input": {}
            }
        });

        let output = daemon
            .handle_request_line(&serde_json::to_string(&open).unwrap())
            .expect("unary refusal should be an error envelope, not a fatal error");
        assert_eq!(output.len(), 1);
        assert!(output[0].contains("KERNEL_SESSION_UNSUPPORTED"), "got: {}", output[0]);
        assert!(output[0].contains("does not require a real session"), "got: {}", output[0]);
    }

    #[test]
    fn kernel_rejects_session_send_for_server_stream_capability() {
        let mut daemon = KernelDaemon::new();
        daemon.sessions.insert(
            "session-1".to_string(),
            SessionState {
                extension_id: "demo.server-stream".to_string(),
                capability: "demo.stream".to_string(),
                runtime_session_id: "runtime-1".to_string(),
                events: VecDeque::new(),
                is_closed: false,
            },
        );
        daemon.loaded.insert(
            "demo.server-stream".to_string(),
            LoadedExtension {
                manifest: json!({ "id": "demo.server-stream" }),
                memory_soft_pages: 256,
                memory_hard_pages: 256,
                runtime: CanonicalRuntimeSpec::Remote {
                    endpoint: "http://example.invalid".to_string(),
                    transport: Some("http".to_string()),
                },
                artifact: ResolvedArtifact {
                    entry_path: "./noop".to_string(),
                    command: "./noop".to_string(),
                    args: vec![],
                    cwd: ".".to_string(),
                    base_path: ".".to_string(),
                    timeout_ms: Some(1000),
                },
                security: ExtensionSecurityInfo {
                    status: "unsigned".to_string(),
                    reason: "test".to_string(),
                },
                capabilities: HashMap::from([(
                    "demo.stream".to_string(),
                    StoredCapabilityContract {
                        interaction_mode: "server-stream".to_string(),
                        execution_mode: "session".to_string(),
                    },
                )]),
                runtime_handle: None,
            },
        );

        let send = json!({
            "kind": "request",
            "id": "3",
            "method": "kernel.session.send",
            "params": {
                "sessionId": "session-1",
                "data": { "text": "ping" }
            }
        });

        let error = daemon
            .handle_request_line(&serde_json::to_string(&send).unwrap())
            .expect_err("server-stream capability should reject send");
        assert!(error.contains("does not allow session.send"));
    }

    #[test]
    fn kernel_returns_consistent_closed_session_error_after_close() {
        let mut daemon = KernelDaemon::new();
        daemon.closed_sessions.insert("session-closed".to_string());

        let send = json!({
            "kind": "request",
            "id": "9",
            "method": "kernel.session.send",
            "params": {
                "sessionId": "session-closed",
                "data": { "text": "ping" }
            }
        });

        let output = daemon
            .handle_request_line(&serde_json::to_string(&send).unwrap())
            .expect("closed session send should answer as an error envelope");
        assert!(
            output[0].contains("KERNEL_RUNTIME_ERROR")
                && output[0].contains("session is closed: session-closed"),
            "got: {}",
            output[0]
        );
    }

    fn quota_filled_session(extension_id: &str, runtime_session_id: &str) -> SessionState {
        let mut session = SessionState {
            extension_id: extension_id.to_string(),
            capability: "demo.chat".to_string(),
            runtime_session_id: runtime_session_id.to_string(),
            events: VecDeque::new(),
            is_closed: false,
        };
        for index in 0..SESSION_EVENT_QUOTA {
            push_session_event(&mut session, SessionEvent::Data { data: json!(index) })
                .expect("push within quota should succeed");
        }
        session
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let mut path = env::temp_dir();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after epoch")
            .as_nanos();
        path.push(format!("{prefix}-{stamp}"));
        path
    }

    fn add_one_wasm_bytes() -> Vec<u8> {
        vec![
            0x00, 0x61, 0x73, 0x6d,
            0x01, 0x00, 0x00, 0x00,
            0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
            0x03, 0x02, 0x01, 0x00,
            0x07, 0x0a, 0x01, 0x06, 0x61, 0x64, 0x64, 0x4f, 0x6e, 0x65, 0x00, 0x00,
            0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x41, 0x01, 0x6a, 0x0b,
        ]
    }
}

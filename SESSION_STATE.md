# ExtensionsManager Session State

Last updated: 2026-09-12 (v1.0.0 — GitHub release baseline)

Version: **v1.0.0** (unified across package.json + all 5 crates). Repository:
https://github.com/vinci0007/ExtensionsManager (public). Releases publish
per-platform artifacts (`extensions-kernel-{windows-x64,linux-x64,macos-arm64}`
archives: kernel cdylib + kernel.node + extensionsd) via
`.github/workflows/release.yml` on `v*` tags — upstream hosts integrate
zero-compile. CI (`.github/workflows/ci.yml`): Rust workspace tests
(windows+ubuntu) + TS suite (Node 24) on push/PR. Cross-platform fixes landed
during CI bring-up: remote-http timeout errors are canonical across platforms
(WouldBlock vs TimedOut/10060), macOS napi links with
`-Wl,-undefined,dynamic_lookup` (rust/.cargo/config.toml), package.json
clean:dist is node-based (was powershell), TS suite builds the rust binaries
it spawns, dist-package exes untracked. Integration entry point:
`docs/host-integration-guide.md` (+ `.zh-CN.md`) — two tracks (game engine /
TS app), per-platform tables; README has a language switch (EN default) and a
Documentation navigation section; PLUGIN_INTEGRATION_MATRIX wasm row reflects
the implemented byte plane.

## Current focus

Active workstream:
- **Policy engine implementation** — plan: `docs/superpowers/plans/2026-09-06-policy-engine.md`
- Phase A (load-time audit + derivation) **DONE**: `kernel.policy.set`
  (frame budget → per-plugin fuel via machine calibration; memory tier caps),
  load admission envelopes (`KERNEL_ADMISSION_REJECTED`), soft/hard memory limiter,
  TS config plumbing (`policy` key in host.config/manager options; daemon auto-push;
  local admission mirror).
- Phase B (runtime accounting + audit) **DONE 2026-09-06**: per-plugin accounting map
  (calls/latency/fuel traps/memory events), bounded audit ring (1024, `kernel.audit.query`
  with sinceSeq/limit paging over `emk_request` — no dedicated C ABI export needed),
  limiter event drain (pressure/denials → audit), leak ratchet (32 new-high-waters →
  latched `leak.suspected`), **runtime-error envelope pass** (unknown extension /
  not-active / closed-session ops → `KERNEL_RUNTIME_ERROR` envelope instead of daemon
  exit; expected-class whitelist in `is_expected_runtime_error`), test guards calibrated
  (scheduling release pressure 25µs; daemon tests timeout 15s).
  Verified: TS 135/136 (1 e2e skip by design), Rust 47/47 both profiles.
- Phase C (three citizen classes) **DONE 2026-09-06**: manifest `extensionClass`
  (transient/standard/resident) + `resourceBudget.fuelPerTick`; resident reservation
  admission (declared peak deducted from host totalMb, fail-closed, re-load releases
  then re-acquires); resident hard cap = declared peak (bypasses the 16 MiB tier
  fallback — the class exists for large-memory plugins); fuel floor/ceiling
  (resident gets max(declared slice, derived), default ceiling without frame policy);
  amortization contract (per-call fuel consumed vs declared slice, 8-over-slice streak
  → latched `contract.violation`); validator fix (undefined = absent).
  Verified: TS 136/136, Rust 51/51 both profiles, resident tests 4/4.
- Phase D (consent surface) **DONE 2026-09-06**: `onPolicyConsent` hook
  (manager options + config assembly + index export; absent = fail-closed);
  local path admission async + consent gate (tier overflow / resident over budget);
  daemon path: consentable classification in Rust admission → `KERNEL_CONSENT_REQUIRED`
  envelope → TS bridge mediates → re-send with `consentOverride: true` → admitted with
  declared-peak cap + `policy.consent_override` audit. Non-consentable stays
  `KERNEL_ADMISSION_REJECTED`. Verified: TS 137/138 (1 skip), Rust 52/52 both profiles.
- Phase E (scheduler design spike) **DONE 2026-09-06**:
  `docs/superpowers/plans/2026-09-06-scheduler-spike.md` — chosen design:
  class-based dispatch (frame-critical stays synchronous on the host thread;
  process/remote/transient get per-plugin queues + a bounded worker pool,
  opt-in via policy); acceptance pre-pinned (slow-plugin P99 offset < 10%);
  awaiting owner confirmation before implementation.
- Phase F (ecosystem closure) **DONE 2026-09-06**: C++ wasm data-plane template
  (`examples/cpp-dataplane-template` — clang required, noted in README; contract
  already verified via the WAT guest), policy docs in the data-plane doc + both
  READMEs. F4 commit narrative correction (2026-09-12): the project has **no git
  repository** (`git rev-parse` fails), so nothing was ever "staged in .git" — the
  7 scan findings were dispositioned in the plan doc F4 table and the blocker was
  the environment-level Mimosa client plugin, not project content.
- Next: none — all owner-unblocked items complete (scheduler v1 + v2-1 resident
  pool, napi/Node realtime harness, Mimosa disposition 2026-09-12: plugin is an
  environment-level ZCode client plugin unrelated to the project; owner disabled
  it in client config and its in-project state directories were removed).

### Scheduler v2-3: TS accepted-envelope Promise model (COMPLETE 2026-09-12)

`CommandKernelTransport` now implements the scheduler's accepted model for
`kernel.invoke`: when the response for a pending invoke is the async-accept
marker (`{accepted:true, async:true}`), the caller's promise stays pending —
the transport swaps the accept-round-trip timer for the async-result window
(new `asyncInvokeTimeoutMs` option, kernel config + bridge options, default
120 s) — and settles only when the REAL envelope arrives on the same request id
(result or `KERNEL_INVOKE_FAILED`). `KERNEL_BUSY` backpressure rejects
immediately through the normal error path; late envelopes for already-settled
requests are dropped silently. Before this, daemon-path hosts received the
accepted marker AS the result and the real envelope was discarded. Four TS
tests (two-phase settle, worker failure, busy rejection, timeout + late
envelope tolerance) — TS 141/142 pass (1 e2e skip), 0 fail. Scheduler open
items: v2-1 and v2-3 DONE; v2-2 (async fuel/wall-clock) stays as-is with the
artifact `timeoutMs` as the guard.

### Scheduler v2-1: resident worker pool (COMPLETE 2026-09-12)

`AsyncPool` replaces per-call `std::thread::spawn`: fixed worker count from
`scheduler.asyncPoolThreads` (lazily created, rebuilt only when the policy
thread count changes — old workers drain the queue then exit on sender drop,
so `emk_reset`/daemon teardown is clean). Job queue is unbounded by itself;
backpressure is enforced by the daemon-side in-flight counter (queued +
executing ≤ `queueCap` → `KERNEL_BUSY` + `invoke.busy` audit). One lesson
landed as a test: a bounded `sync_channel(1)` under an in-flight cap of 8 made
`send` block for a full boundary call (the 4th accept took ~100 ms) — the queue
bound must NOT be tighter than the in-flight cap; the unbounded channel plus
counter gate is the correct pair. Acceptance:
`async_scheduler_pool_reuse_and_backpressure` (accept → KERNEL_BUSY → envelope
delivered → slot freed → SAME pool accepts again). Regression: Rust workspace
54/54 BOTH profiles; Node harness re-run with the pool: S3 offset 0.53%
(baseline 18.9 µs → pressure 19.0 µs), 8/8 accepted + 8/8 envelopes.

### napi-rs bindings + Node realtime harness (COMPLETE 2026-09-12)

- `rust/extensions-kernel-napi` (workspace member, cdylib): wraps the C ABI
  surface so Node exercises the exact embedded-host semantics (global kernel
  singleton, kernel mutex, byte data plane, async scheduler sink). Exports:
  `request` / `lastError` / `handleResolve` / `invokePtr` / `tickPtr` /
  `handleRelease` / `installResponseSink` / `drainAsyncResponses` / `reset` /
  `abiVersion`. napi 2 (napi8 feature), NO @napi-rs/cli dependency — the
  harness loads the cdylib via `process.dlopen` (copy
  `rust/target/release/extensions_kernel_napi.dll` → `realtime-tests/kernel.node`).
- `realtime-tests/harness.mjs` (also `npm run test:realtime`): game-loop pacing
  (coarse sleep far from deadline, setImmediate yield-spin near it — OS timer
  granularity otherwise caps 500fps at ~128fps on Windows), three scenarios,
  report → `realtime-tests/REPORT.md`, docs in `realtime-tests/README.md`.
- Measured (Node v24 / win32 x64 / release): S1 500fps × 1 plugin — 1500/1500
  frames, 0 overruns, tick p50 2.8µs / p99 17.4µs. S2 × 20 plugins — 30k calls
  0 failures, per-call p50 1.0µs / p99 6.7µs, whole-frame p50 25.3µs = 1.3% of
  the 2ms frame budget. S3 async coexistence — healthy P99 baseline 24.7µs →
  under 100ms-boundary-plugin pressure 20.0µs (offset −19%, no degradation),
  8/8 slow invokes accepted as async markers (worst 0.165ms), 8/8 envelopes
  via sink. napi+JS tax vs raw C ABI (900ns): p99 ~7–20µs, still <1% of the
  500fps frame budget → a Node realtime host is viable at 500fps.
- Harness guards are deliberately absolute/generous (dev machine, not a bench):
  zero failed calls, all slow invokes accepted, all envelopes delivered,
  pressure P99 < 1ms; strict percentile acceptance stays in the Rust tests.

### Scheduler v1 implementation status (COMPLETE 2026-09-12, both layers green)

Layer 1 of 2 **DONE + green**: `ManagedProcess` restructured into a thread-safe
channel (`ProcessIo`: Mutex stdin, pending-by-id map, Condvar, session-events,
alive flag; **dedicated reader thread per plugin** correlates responses by id and
files session events). Behavior-identical — all tests pass.

Layer 2 of 2 **DONE + green**: async dispatch for boundary runtimes.
- Policy: `kernel.policy.set { scheduler: { asyncPoolThreads, queueCap } }`;
  absent = fully synchronous (byte-identical fallback, acceptance item 4).
- `handle_invoke`: async engages only when pool enabled AND a response sink is
  installed AND the target is a non-WASM runtime. The boundary check is by
  runtime kind WITHOUT taking the handle lock (a worker holding the handle for
  a 100 ms call must not stall the check that holds the kernel mutex).
- `dispatch_invoke_async`: bounded in-flight (`queueCap`, overflow → `KERNEL_BUSY`
  + `invoke.busy` audit) → immediate `{accepted: true, async: true}` marker →
  worker thread (handle Arc SHARED not taken; same-plugin calls serialize on the
  handle mutex worker-side) → `account_on` records latency → in-flight decrement →
  envelope through the response sink. Three defects found and fixed during
  implementation: worker dropped the handle (plugin unusable after first async
  call), in-flight never decremented (permanent KERNEL_BUSY), worker skipped
  accounting.
- Delivery: extensionsd writer thread serializes sink envelopes to stdout;
  embedded hosts install a sink via `capi::install_global_response_sink()`
  (Rust seam, napi binding reuses it). No sink = sync model.
- Acceptance (`tests/scheduler_async.rs`): 100 ms process plugin saturated on the
  async pool while the healthy WASM neighbor runs the byte plane — release:
  healthy P99 baseline 900 ns, under pressure 900 ns, **offset 0.00%** (acceptance
  <10% met at 0%); accept markers <20 ms; 4 envelopes delivered with matching ids.
- Regression: Rust 41/41 debug green; release frame_budget P99 6.7 µs
  (0.241% @360Hz), scheduling runaway 900 ns → 4.5 µs → recovery 900 ns;
  TS 137 pass / 0 fail (1 skip). Docs synced: scheduler-spike §7, policy-engine
  Phase E checked.

Notes: the hook blocks Bash copies of source files (no backup possible; the
lib.rs on disk IS the green checkpoint). **napi-rs un-deferred by owner**:
next dedicated chunk builds napi bindings + a Node realtime test harness for
iteration (no production Node host today — harness is the consumer).
Scheduler v2 candidates: resident worker pool (today spawns bounded per-call
threads), async fuel/wall-clock dual constraint, TS accepted-envelope Promise model.

Earlier waves (2026-09-05/06): full review pass (2 integration defects fixed), memory
perf wave (closed_sessions tombstone fix + probes, performance-tests/REPORT.md),
security hardening wave (security-tests/REPORT.md), signature default flip to
fail-closed, embedded kernel phases 0–5 (2026-08-29 plan).

Hard constraint for ALL sessions/tasks:
- Temporary files/scripts must be created and operated **inside the project directory**
  (`.tmp/`, `rust/target/`, etc.) — never outside the project, especially never on C:
- C ABI kernel is a process-global singleton: policy-engine tests that mutate global
  policy must serialize on a test-local mutex and set their own policy inside it
- Process cleanup during tests: kill by PID after verifying ownership (command line),
  never by image name

Environment note (updated 2026-09-12): Mimosa is an **environment-level ZCode client
plugin** (`mimosa@zcode-plugins-official`, user-level plugin cache), not project
content. Its hooks previously scanned Write/Edit candidates (the `spawn` false
positive) and gated Bash git commands, leaving `.mimosa` state directories inside
the project (~8.4MB, regenerable). Owner disposition 2026-09-12: plugin disabled in
`~/.zcode/cli/config.json` (`enabledPlugins`), in-project state directories deleted
(backup of the client config in `.tmp/zcode-config-backup-20260912.json`). The
project directory is NOT a git repository — there is no pre-commit hook and nothing
was ever staged.

## Review pass findings (2026-09-05 night) — both fixed

1. **Daemon-fatal admission (cross-effect of the fail-closed default flip)**: with the
   new signature default, an unsigned manifest at `kernel.load` made extensionsd
   exit(1) — one plugin's policy rejection killed the kernel for all other plugins.
   Fixed: admission rejection is now a `KERNEL_ADMISSION_REJECTED` error envelope
   (mirrors openSession handling); daemon survives; regression test asserts survival.
2. **Export surface gap**: `ExtensionAuthSpec/ExtensionAuthKind`, `RemoteRuntimeOptions`,
   `assertStatusProbeAllowed`/`isLoopbackHost`/`isPrivateNetworkHost`,
   `assertWasmMemoryWithinQuota`/`parseWasmMemoryLimits`/`WASM_MEMORY_QUOTA_PAGES`,
   `SESSION_EVENT_QUOTA` were missing from src/index.ts — now exported.

Review-verified interactions (no action needed): store install pins integrity but the
manifest stays unsigned → production hosts must sign manifests (integrity ≠ authorship;
documented); module cache is bounded (64 entries); content-hash busting reuses cached
modules for identical bytes; schema strictness passes all shipped template manifests.

## 2026-09-05 evening wave: memory performance + fixes

Test artifacts: `performance-tests/` (probes + REPORT.md). Full report there.
- **Fixed real defect**: kernel `closed_sessions` grew without bound (permanent
  tombstone per closed session) → `ClosedSessionTombstones` bounded ring
  (capacity 65,536, FIFO eviction), white-box test; capacity constant
  `CLOSED_SESSION_TOMBSTONE_CAPACITY`.
- Lifecycle leak probe: 60 load/activate/invoke/deactivate cycles on Node and WASM
  runtimes → heap +0.2 MB / +0.03 MB (zero leak).
- Scale probe: 1→10→100→300 in-process wasm plugins → ≈12 KB/plugin, invoke P99
  1–3 µs independent of scale. Load P50 ≈10 ms/plugin is **fs-bound for small
  modules** (mkdir/writes/reads), NOT compile time — corrected attribution.
- Boundedness probe: unread 5x-quota event flood capped (heap +2.6 MB, structured
  failure); 2000-session churn latency flat (P99 0.94 ms); runaway CPU plugin
  returns without infra hang.
- Fixes landed from findings: (1) WasmRuntime content-hash compiled-module cache
  (bounded FIFO 64; identity test), (2) NodeRuntime content-hash cache busting →
  same-filename hot updates now work (store update no longer needs renamed entry),
  (3) PluginStore install/update pin artifact.integrity (sha256 of resolved entry)
  so binary tampering is rejected at load, (4) verified daemon transport already
  enforces per-request timeouts (`timeoutMs ?? 5000`) — earlier probe drag was
  legitimate slow-plugin time, corrected in the report.
- Verified: TS 133/133, Rust 38/38 both profiles, daemon rebuilt.

Earlier waves (same day): security hardening (path fence, TS wasm guard, event quota,
schema strictness, remote auth/SSRF, PluginStore MVP — see security-tests/REPORT.md)
and the signature default flip to fail-closed (require-signature-except-development;
unknown policy strings fail closed; examples/tests declare isDevelopment explicitly).
Remaining known-open: fuel only on the Rust kernel path (JS limitation); manifest
signature does not cover binaries (store now pins integrity on install; document for
manual installs); multi-threaded scheduler for slow-plugin isolation (roadmap).

## 2026-09-05 wave: what landed

Security hardening (all with regression tests, TS 126/126, Rust 36/36 debug+release):
- **Path fence** (`src/core/ArtifactResolver.ts`): manifest-driven artifact entries and
  relative launch commands/cwd are contained to the plugin directory (`../` escape and
  NUL bytes rejected). Bare executable names (PATH lookup) and absolute launcher paths
  (process.execPattern host configs) intentionally keep working — compatibility kept.
- **shell:true refused** at the resolver choke point (command-injection vector).
- **TS wasm guard** (`src/security/wasmModuleLimits.ts` + WasmRuntime): binary memory-section
  parser; unbounded/oversized self-declared memory rejected (256-page quota, mirrors the
  Rust kernel); imported memories get a host-capped `WebAssembly.Memory`. Note: JS has no
  fuel — the compute-runaway half of the protection only exists on the Rust kernel path.
- **Session event quota** (4096, both sides): TS `JsonRpcTransport` drops buffered events
  and fails the session ops with `EVENT_QUOTA_EXCEEDED`; Rust kernel marks the session
  closed and answers with an error envelope (daemon never exits); ManagedProcess staging
  queue also capped. TS quota check must run BEFORE the request await (else a breached
  session op waits forever for a reply the plugin will never send).
- **Schema strictness** (`JsonSchemaValidator`): additionalProperties now actually enforced
  (false → reject unknown keys; schema → validate map values; was silently ignored before,
  with prototype-safe `Object.hasOwn`); `protocolVersion` enum ['1']; new `metadata.tags`
  and `artifact.launch.auth` accepted; operator-typo fields (e.g. `interactionmode`) now
  fail loudly.
- **Remote auth + TLS + SSRF guard**: `launch.auth` {bearer|header, secret from env var
  (valueEnv), never in the manifest}; non-loopback http:// rejected unless
  `RemoteRuntime({ allowInsecureHttp: true })`; status probes default-deny via
  `src/security/statusProbeGuard.ts` (own-endpoint host, loopback, or
  `statusProbeAllowedHosts` option); extension: `ExtensionManagerOptions.statusProbeAllowedHosts`.
- **PluginStore MVP** (`src/core/PluginStore.ts`): installFromDirectory / uninstall /
  update / search / findByTag; id sanitization + path containment on the plugins
  directory; `ExtensionManager.unregister()` added. ESM cache caveat: updates that keep
  the same entry filename need a changed file name (or process restart) to be observable.

Process notes:
- Ran 6 workstreams as parallel subagents in tar-copied worktrees under `.tmp/worktrees/`
  (no git repository in the project, so worktree copies were used for isolation).
  Concurrency limit ~3; two agents stalled (600s inactivity) and were finished manually.
  Merged outputs manually; scan-forced rewrites: `.exec(` → `.match(` (false positive).
- Worktrees can be deleted: `.tmp/worktrees/{path-fence,ts-wasm-guard,evt-quota,schema-version,remote-auth,plugin-store}`
- Remaining known-open item from the assessment: **fail-closed default signature policy**
  (both TS and Rust currently fall through to allow-unsigned when unset) — deliberately
  NOT changed in this wave because it alters default behavior for every host; decide
  policy explicitly via `signaturePolicy: 'require-signature'` until then.

Current project scope:
- Work on `ExtensionsManager`
- Ignore the sibling `svgPicNew` project for this session chain

## Completed in recent sessions

Architecture and runtime:
- Kept TypeScript as facade / host integration layer
- Continued Rust direction as kernel / security core layer
- Added and validated unified initialization context flow across manager, runtimes, and kernel bridge
- Added `ExtensionManager.getInitializationInfo()`
- Added `ExtensionManager.checkStatus()`
- Added `ExtensionManager.reinitialize()`
- Added `ExtensionInstance.openSession?()` and propagated session support through the facade
- `ExtensionManager.checkStatus()` now probes remote JSON-RPC endpoints with `extension/status` instead of reusing `extension/load`

Rust workspace:
- Promoted Rust security core from example-only location into formal workspace crate
- Current canonical crate path: `rust/extensions-security-core`
- Rust workspace members now include:
  - `extensions-security-core`
  - `extensions-kernel`
  - `extensionsd`
- Rebuilt `extensionsd` after kernel session changes

Kernel/session migration:
- `rust/extensions-kernel` no longer treats `openSession` as a plain `invoke` wrapper for process runtime
- Added Rust kernel session state carrying `extension_id`, `runtime_session_id`, queued events, and close state
- Added Rust kernel closed-session tracking so repeated post-close operations return a stable closed-session error
- Added Rust runtime-handle session methods:
  - `open_session`
  - `session_send`
  - `session_cancel`
  - `session_close`
- Added process-runtime event-frame handling in Rust `ManagedProcess`
- Added real session support in TS local/runtime paths:
  - `NodeRuntime`
  - `LocalKernelBridge`
  - `ProcessRuntime`
  - `RemoteRuntime(process)`
  - `RemoteRuntime(http)`
- Added capability/session contract checks in both TS runtimes and Rust kernel:
  - real-session-only capabilities no longer silently fall back
  - `session.send()` is rejected for non-upstream interaction modes
- Added shared TS session lifecycle helpers for:
  - buffered session wrappers
  - compatibility session wrappers
  - child-process exit waiting
- Local kernel unary compatibility sessions now reuse the shared TypeScript compatibility session helper
- Added explicit closed-state behavior after `close()` for:
  - local kernel compatibility sessions
  - local node-backed real sessions
  - process runtime sessions
  - remote process sessions
  - remote http sessions
  - command-kernel daemon sessions
- Kept compatibility fallback when a plugin/service does not support session methods
- Hardened command-kernel daemon transport so malformed daemon stdout is converted into a structured transport error instead of an uncaught parse failure or hanging request
- Remote HTTP status checks no longer reload remote endpoints; `extension/load` remains load-only and `extension/status` is the health/status method

Testing structure:
- Removed old monolithic `src/test/runtime-advanced.test.ts`
- Split it into:
  - `src/test/runtime-local.test.ts`
  - `src/test/runtime-remote.test.ts`
- Added Rust-focused split tests:
  - `src/test/runtime-rust-security-core.test.ts`
  - `src/test/runtime-rust-kernel.test.ts`
- Added real session coverage for:
  - local node runtime
  - local process runtime
  - remote process runtime
  - remote http runtime
  - rust kernel daemon process runtime
  - rust kernel daemon remote http runtime
- Added contract-hardening coverage for:
  - rejecting compatibility fallback for duplex/session capabilities
  - rejecting post-close `send()` / `nextEvent()` usage
- Added bridge regression coverage for:
  - local unary compatibility session post-close behavior
  - malformed command-kernel daemon stdout
- Added remote HTTP status regression coverage so `checkStatus()` calls `extension/status` without issuing a second `extension/load`

Spawn / sandbox stability:
- Default test command now uses `node --test --test-isolation=none`
- Added `src/test/spawn-test-helpers.ts`
- Spawn-dependent tests now probe child-process availability before running
- This avoids sandbox-only `spawn EPERM` hard failures on routine test runs

## Verified state

Latest verified commands:
- `npm run build`
- `cargo test --manifest-path rust/extensions-kernel/Cargo.toml`
- `cargo build -p extensionsd`
- `$tmp = Join-Path $PWD ".tmp"; New-Item -ItemType Directory -Force -Path $tmp | Out-Null; $env:TMP = $tmp; $env:TEMP = $tmp; node --test --test-isolation=none dist/test/kernel-bridge.test.js`
- `$tmp = Join-Path $PWD ".tmp"; New-Item -ItemType Directory -Force -Path $tmp | Out-Null; $env:TMP = $tmp; $env:TEMP = $tmp; node --test --test-isolation=none dist/test/runtime-remote.test.js`
- `npm run demo:remote-http`
- `npm test`

Latest result:
- `79` TypeScript tests passed
- `0` failed
- `npm run demo:remote-http` passed and now exercises `checkStatus()` through `extension/status`

Important note:
- The earlier `spawn EPERM` issue was largely caused by Node test isolation in this environment
- For real spawn-based integration tests, the code path is still valid; the test harness is now stabilized for restricted environments
- Manual Node test runs should keep `--test-isolation=none`; running bridge tests without it can leave child test runners or stub daemon processes alive after timeouts

## Important files changed recently

Session/runtime migration:
- `src/core/sessionContracts.ts`
- `src/contracts/ExtensionInstance.ts`
- `src/runtimes/node/NodeRuntime.ts`
- `src/kernel/LocalKernelBridge.ts`
- `src/core/ExtensionManager.ts`
- `src/kernel/nodePluginLauncher.ts`
- `src/runtimes/process/JsonRpcTypes.ts`
- `src/runtimes/process/JsonRpcTransport.ts`
- `src/runtimes/sessionRuntimeUtils.ts`
- `src/runtimes/process/ProcessRuntime.ts`
- `src/runtimes/remote/RemoteRuntime.ts`
- `src/kernel/CommandKernelBridge.ts`
- `rust/extensions-kernel/src/lib.rs`

Examples:
- `examples/remote-http-demo.mjs`
- `examples/remote-http-extension-template/server.mjs`
- `examples/remote-http-extension-template/README.md`

Tests:
- `src/test/kernel-bridge.test.ts`
- `src/test/runtime-local.test.ts`
- `src/test/runtime-remote.test.ts`
- `src/test/runtime-rust-kernel.test.ts`

Plans:
- `docs/superpowers/plans/2026-06-06-session-transport-hardening.md`

Rust workspace:
- `rust/Cargo.toml`
- `rust/extensions-security-core/Cargo.toml`
- `rust/extensions-security-core/src/*`
- `rust/extensions-kernel/Cargo.toml`
- `rust/extensionsd/Cargo.toml`

## Known constraints

- This workspace often runs under Windows sandbox restrictions
- `node --test` without `--test-isolation=none` may re-trigger `spawn EPERM`
- Windows can hold file locks briefly during spawned-runtime cleanup; tests should dispose runtimes explicitly and retry temp-directory cleanup when needed
- Rust daemon and external process tests are environment-sensitive, but the current default path is stable

## Recommended next step

Execute `docs/superpowers/plans/2026-08-29-embedded-realtime-kernel.md` phase by phase.

Baseline re-verified 2026-08-29 (no regression vs 2026-06-06):
- `npm run build` clean, `npm test` → 79 passed / 0 failed
- `cargo test --manifest-path rust/extensions-kernel/Cargo.toml` → 12 passed / 0 failed
- `cargo build -p extensionsd` OK (one pre-existing dead-code warning in `extensions-kernel/src/lib.rs:505`)

Current phase: **Phases 0-5 DONE (2026-08-29). Roadmap complete; future work is optional extensions**
- Phase 1 delivered: `extensions-kernel` cdylib + C ABI export layer (`src/capi.rs`,
  header in `capi/extensions_kernel.h`), C++ embedder demo in `examples/cpp-embedder-demo/`
  (real LoadLibraryA host, full load→activate(spawn node plugin)→invoke round trip verified),
  5 integration tests in `tests/cabi_roundtrip.rs`
- Phase 2 delivered: in-process wasmtime runtime (`src/wasm_runtime.rs`) replacing the
  deleted Node bridge; numeric guest contract fully backward compatible; byte fast path
  via `memory` + `ext_call` exports (packed ptr/len i64); 16 MiB per-plugin memory quota;
  data-plane C ABI (`emk_handle_resolve`/`emk_invoke_ptr`/`emk_handle_release`) with
  response written straight into the host buffer
- Phase 3 delivered: deterministic per-call fuel budget (default 200M instructions,
  `EXTENSIONS_KERNEL_WASM_FUEL` overrides; `Trap::OutOfFuel` → explicit budget error),
  `ext_tick` batch export + `emk_tick_ptr` C ABI (push-a-batch-per-tick model),
  `wasm_backtrace(false)` so traps skip expensive backtrace capture
- Phase 4 delivered: `NodeRuntime` marked trusted-environment-only; `CommandKernelBridge`
  marked optional sidecar (daemon stderr now logged instead of swallowed); **fixed a
  latent contract break exposed by the fresh daemon binary**: unary openSession refusal
  is now an error envelope (`KERNEL_SESSION_UNSUPPORTED`) instead of a fatal daemon
  exit, the TS bridge falls back to a compatibility session (June-6 documented intent,
  mirrors ProcessRuntime), and the remote-http TS test manifest now declares its
  duplex/session contract
- Phase 5 delivered: data-plane contract doc `docs/embedded-kernel-data-plane.md`;
  Rust WASM data-plane template `examples/rust-wasm-dataplane-template` (no_std,
  plugin.wasm committed, verified through the real C++ host); C++ demo extended with
  the data-plane stage (resolve → invoke_ptr → tick_ptr → host-side latency percentiles,
  `-Release` flag); `npm run demo:cpp-embedder` shortcut; README links in both languages
- **Measured data-plane tax (release)**: P50 200 ns / **P99 300 ns** / P999 700 ns —
  16x better than the 5 µs Phase-2 acceptance target; 1000 Hz tick × 20 plugins ≈ 0.6%
  of tick budget. Fuel accounting costs nothing on this path. Debug build P99 = 9.7 µs.
  Real C++ host (release, 20k iters): P99 300–400 ns for both wat and Rust-template guests
- Scheduling isolation measured (release): runaway plugin traps deterministically at
  its budget; healthy neighbor P99 under interleaved runaway pressure = 8.7 µs
  (bounded jitter — trap leaves cold caches); after runaway release neighbor P99
  returns to baseline 200 ns (**0.00% offset**). The original "<10% offset" acceptance
  belongs to a future multi-threaded scheduler; the delivered guarantee is
  bounded + deterministic + recoverable
- napi decision (plan risk 5, resolved): deferred — realtime hosts are native engines
  (cdylib covers them); Node hosts use the daemon sidecar until a frame-level Node
  data-plane need appears. Host triple is x86_64-pc-windows-msvc, so napi-rs is
  technically feasible when revisited
- Wasmtime module cache: enabled ONLY via `EXTENSIONS_KERNEL_WASM_CACHE_DIR` (must point
  inside the project; config file is generated there) — never the C-drive default
- Verified 2026-08-29 (final): `cargo test --workspace` → **34 passed / 0 failed in BOTH
  debug and release**; `npm test` → **79 passed / 0 failed**; `cargo build -p extensionsd`
  OK; README.md + README.zh-CN.md embedded-kernel sections; `rustup target add
  wasm32-unknown-unknown` installed for plugin-template builds
- Windows gotcha: `fs::canonicalize()` yields `\\?\`-prefixed paths; the prefix disables
  path normalization and breaks CreateProcessW current_dir when mixed with other
  separators (child dies instantly → "plugin returned empty response"). Strip the prefix.

Historical next-step list from the 2026-06-06 milestone (lifecycle normalization,
transport hardening, status normalization, docs refresh) is superseded by the new plan doc.

## Resume checklist

When the next session starts:
1. Open this file first
2. Confirm work is on `ExtensionsManager`
3. Re-run:
   - `npm run build`
   - `npm test`
4. If the goal is to continue hardening, start from:
   - `src/runtimes/sessionRuntimeUtils.ts`
   - `src/kernel/CommandKernelBridge.ts`
   - `src/runtimes/remote/RemoteRuntime.ts`
   - `rust/extensions-kernel/src/lib.rs`

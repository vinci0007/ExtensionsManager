# Host Integration Guide

**English** | [简体中文](host-integration-guide.zh-CN.md)

End-to-end guide for upstream hosts — game engines and general applications —
integrating the ExtensionsManager plugin subsystem. Everything here is verified
against the shipped code and measured numbers (see
[embedded-kernel-data-plane.md](embedded-kernel-data-plane.md) for the raw
data-plane contract and [../realtime-tests/REPORT.md](../realtime-tests/REPORT.md)
for harness measurements).

## Which track are you on?

| Your host | Track | What you integrate |
|---|---|---|
| C++ / Unreal / Unity / custom engine (any language that can call C) | **[Track A — Game engine / native host](#track-a--game-engine-and-native-hosts-c-abi)** | the Rust kernel cdylib via the `emk_*` C ABI |
| Node.js / TypeScript application | **[Track B — General application (TS/Node)](#track-b--general-applications-tsnode)** | the `ExtensionManager` facade (npm/local build) |
| Node.js host that needs frame-level realtime (hundreds of fps ticks) | Track B + **[embedded napi kernel](#b3-kernel-modes)** | the same facade, backed by the in-process napi addon |

---

## Part 0 — Get the kernel

### Option 1: prebuilt binaries (zero toolchain)

Download the archive for your platform from the repository's
**Releases** page (built by CI for every `v*` tag):

| Archive | Contents | Runs on |
|---|---|---|
| `extensions-kernel-windows-x64.zip` | `extensions_kernel.dll` · `kernel.node` · `extensionsd.exe` | Windows 10+/Server, x64 |
| `extensions-kernel-linux-x64.tar.gz` | `libextensions_kernel.so` · `kernel.node` · `extensionsd` | Linux x64 (glibc 2.28+) |
| `extensions-kernel-macos-arm64.tar.gz` | `libextensions_kernel.dylib` · `kernel.node` · `extensionsd` | macOS 12+, Apple silicon |

- `extensions_kernel.*` — the embedded kernel cdylib (Track A).
- `kernel.node` — the same kernel wrapped as a Node N-API addon (Track B realtime).
- `extensionsd*` — the out-of-process daemon sidecar (Track B daemon mode).

### Option 2: build from source

Requires the Rust stable toolchain (`rustup`). All outputs land under
`rust/target/release/`:

```bash
cargo build --release -p extensions-kernel        # cdylib  -> extensions_kernel.dll / libextensions_kernel.so / libextensions_kernel.dylib
cargo build --release -p extensions-kernel-napi   # napi    -> extensions_kernel_napi.dll / libextensions_kernel_napi.{so,dylib}  (rename to kernel.node)
cargo build --release -p extensionsd              # daemon  -> extensionsd.exe / extensionsd
```

Platform notes:

- **Windows**: MSVC host triple (`x86_64-pc-windows-msvc`) is the default and
  recommended. The cdylib is plain C ABI — MinGW g++ links it fine too.
- **Linux/macOS**: nothing special; `cc` is only needed if you build the C++
  demo (`examples/cpp-embedder-demo`, MinGW g++ on Windows, clang/gcc elsewhere).
- **WASM plugin authors** need `rustup target add wasm32-unknown-unknown` —
  hosts themselves never touch this.

---

## Track A — Game engine and native hosts (C ABI)

Target reader: engine programmers integrating the kernel into a C++/Unreal/Unity
codebase, or any host able to call a C function table. One kernel instance per
process; everything runs in-process — no daemon, no sockets.

### A1. Load the library

| Platform | Load call | Symbol lookup |
|---|---|---|
| Windows | `LoadLibraryW(L"extensions_kernel.dll")` | `GetProcAddress` |
| Linux | `dlopen("libextensions_kernel.so", RTLD_NOW \| RTLD_LOCAL)` | `dlsym` |
| macOS | `dlopen("libextensions_kernel.dylib", RTLD_NOW)` | `dlsym` |
| Unreal Engine | `FPlatformProcess::GetDllHandle(_T("extensions_kernel.dll"))` | `FPlatformProcess::GetDllExport` |
| Unity (native plugin) | drop the dll/so into `Assets/Plugins/<platform>` | `[DllImport("extensions_kernel")]` bindings |

Keep the library next to your host executable (or on the loader search path).
The ABI is stable at revision 1 — gate your host with `emk_abi_version() == 1`.

### A2. C ABI reference

```c
/* Returns 1 (ABI revision) — check once after loading. */
uint32_t    emk_abi_version(void);

/* Submit ONE kernel request: a single JSON envelope line, no trailing newline.
   Returns a heap-allocated NUL-terminated JSON response (caller frees with
   emk_string_free), or NULL on transport-level failure (see emk_last_error). */
char*       emk_request(const char* request_json_line);

/* Borrow the last transport-level error on this thread (NULL if none).
   Pointer is invalidated by the next emk_request call on the same thread. */
const char* emk_last_error(void);

/* Free a string returned by emk_request. NULL is accepted. */
void        emk_string_free(char* ptr);

/* Drop all kernel state (loaded extensions, sessions, policy). Host reloads. */
void        emk_reset(void);

/* Resolve the byte-plane handle of a loaded extension. 0 = not loaded. */
uint64_t    emk_handle_resolve(const char* extension_id);

/* Byte invoke: request JSON bytes in, response written into YOUR buffer.
   Returns bytes written, or -1 (see emk_last_error). Buffers are caller-owned
   and reusable across frames — zero per-frame kernel-side allocation. */
int64_t     emk_invoke_ptr(uint64_t handle, const uint8_t* input, size_t input_len,
                           uint8_t* out, size_t out_capacity);

/* Tick entry: same transport, pushes one batch to the plugin's ext_tick export. */
int64_t     emk_tick_ptr(uint64_t handle, const uint8_t* input, size_t input_len,
                         uint8_t* out, size_t out_capacity);

void        emk_handle_release(uint64_t handle);
```

Threading contract: all `emk_*` calls are serialized by a process-global mutex.
Call them from your frame thread; kernel-internal scheduler workers (async
boundary invokes) never take that mutex, so a slow out-of-process plugin cannot
stall your frame loop (measured: healthy neighbor P99 offset 0.00–0.53% with a
100 ms/call plugin saturated on the pool — see the scheduler spike doc §7).

### A3. Envelope protocol (emk_request)

One JSON line in, one JSON line out (or several joined by `\n` when a call
produces session events):

```jsonc
// request
{ "kind": "request", "id": "your-opaque-id", "method": "kernel.activate", "params": { } }

// success response
{ "kind": "response", "id": "your-opaque-id", "result": true }

// kernel-level failure (NOT a transport failure — the kernel is alive)
{ "kind": "response", "id": "your-opaque-id", "error": { "code": "KERNEL_ADMISSION_REJECTED", "message": "..." } }

// unsolicited async/session event line
{ "kind": "event", "sessionId": "...", "event": { "type": "data", "data": { } } }
```

| Method | Params | Result |
|---|---|---|
| `kernel.load` | [load body](#a4-loading-a-plugin), `consentOverride?` | `{ extensionId, security: { status, reason } }` |
| `kernel.activate` | `{ extensionId, context: {} }` | `true` (spawns process runtimes, instantiates WASM) |
| `kernel.invoke` | `{ extensionId, capability, input }` | plugin result — **or** `{ accepted: true, async: true }` for boundary runtimes when the scheduler is on |
| `kernel.policy.set` | [policy body](#a6-policy-frame-memory-fuel-scheduler) | derived values (fuel etc.) |
| `kernel.openSession` | `{ extensionId, capability, input }` | `{ sessionId }` (duplex/session capabilities) |
| `kernel.session.send` / `kernel.cancel` / `kernel.session.close` | `{ sessionId, ... }` | `true`; events arrive as `kind:"event"` lines |
| `kernel.audit.query` | `{ sinceSeq?, limit? }` | `{ events[], newestSeq, accounting[] }` |

Error codes: `KERNEL_ADMISSION_REJECTED` (policy refused at load),
`KERNEL_CONSENT_REQUIRED` (host may re-send with `consentOverride: true`),
`KERNEL_RUNTIME_ERROR` (unknown extension / not active / closed session),
`KERNEL_BUSY` (scheduler queue full), `KERNEL_INVOKE_FAILED` (async worker
failure), `KERNEL_UNKNOWN_METHOD`, `KERNEL_SESSION_UNSUPPORTED`.

### A4. Loading a plugin

WASM plugin (the frame-critical data-plane shape):

```jsonc
{
  "kind": "request", "id": "load-1", "method": "kernel.load",
  "params": {
    "manifest": {
      "id": "game.aurora", "version": "1.0.0", "protocolVersion": "1",
      "artifact": { "kind": "wasm", "entry": "./aurora.wasm" },
      "runtime": "wasm",
      "capabilities": [{ "name": "dataplane" }]
    },
    "runtime":   { "kind": "wasm", "entryPath": "/abs/path/aurora.wasm", "cwd": "/abs/path" },
    "capabilities": [{
      "name": "dataplane", "interactionMode": "unary", "executionMode": "ephemeral",
      "realtimeClass": "batch", "concurrencyPolicy": "shared", "resourceBudget": {}
    }],
    "permissions": {},
    "artifact":  { "entryPath": ".", "command": ".", "args": [], "cwd": ".", "basePath": ".", "timeoutMs": 5000 },
    "security":  { "signaturePolicy": "allow-unsigned" }
  }
}
```

Out-of-process plugin (C++/Go/Python/Rust executable, JSON-RPC over stdio):
`runtime: "process"` with `command`/`args`/`cwd`; `artifact.command`,
`artifact.args`, `artifact.cwd`, `artifact.basePath`, `artifact.timeoutMs`.
`signaturePolicy` defaults to fail-closed — use `allow-unsigned` only in
development (see the signing sections in the README).

Then `kernel.activate`, then either drive it through `kernel.invoke` (JSON) or
— for frame-critical WASM — resolve the handle once and use the byte plane:

```c
uint64_t h = emk_handle_resolve("game.aurora");
// per frame:
int64_t written = emk_invoke_ptr(h, req, req_len, out_buf, OUT_CAP);
if (written > 0) { /* parse out_buf[0..written] */ }
```

### A5. The WASM guest contract (byte plane)

A data-plane guest exports `memory` plus either or both of:

```wat
(func (export "ext_call") (param i32 i32) (result i64))   ;; invoke
(func (export "ext_tick") (param i32 i32) (result i64))   ;; frame/tick batch
```

- The host writes request bytes into guest memory at `in_ptr` (length
  `in_len`), calls the export, and the guest answers with a packed i64
  `(out_ptr << 32) | out_len` pointing at its OWN memory. The kernel copies the
  response into the host's `out` buffer.
- Quota: 16 MiB memory ceiling (soft tier warnings + hard denials are audited),
  deterministic fuel per call (default 200M instructions, policy-derived).
- Working templates: [`examples/rust-wasm-dataplane-template`](../examples/rust-wasm-dataplane-template)
  (no_std Rust), [`examples/cpp-dataplane-template`](../examples/cpp-dataplane-template)
  (freestanding C++), [`examples/cpp-embedder-demo/dataplane-guest.wat`](../examples/cpp-embedder-demo/dataplane-guest.wat)
  (minimal WAT).

### A6. Policy (frame, memory, fuel, scheduler)

Send once before loading plugins; anything absent falls back to safe defaults:

```jsonc
{
  "kind": "request", "id": "policy-1", "method": "kernel.policy.set",
  "params": {
    "frame":    { "tickHz": 500, "pluginSharePct": 5 },
    "memory":   { "totalMb": 256, "tiers": { "realtimeMb": 64, "interactiveMb": 128, "batchMb": 256 } },
    "fuel":     { "perCallOverride": 200000000 },
    "scheduler": { "asyncPoolThreads": 2, "queueCap": 8 }
  }
}
```

- `frame` → per-call fuel is derived from the frame budget (machine-calibrated
  at startup); `memory.totalMb` is the admission space resident-class plugins
  reserve from; tiers gate declared peaks per `realtimeClass`.
- `scheduler` (opt-in): `asyncPoolThreads > 0` enables the persistent worker
  pool for boundary runtimes (process/remote). Accepted invokes return
  `{accepted:true, async:true}` immediately; the real envelope is delivered
  **through the daemon's stdout** in daemon mode. In a pure C-ABI embedding
  there is no sink, so boundary invokes stay synchronous — WASM data-plane
  calls (the frame path) are unaffected either way.
- Verification numbers: 20 plugins @ 500 fps whole-frame cost 1.3% of the
  2 ms frame budget; runaway WASM plugin trapped deterministically at its fuel
  budget; slow 100 ms process plugin isolated from healthy neighbors.

### A7. Platform checklist

| | Windows x64 | Linux x64 | macOS arm64 |
|---|---|---|---|
| Library name | `extensions_kernel.dll` | `libextensions_kernel.so` | `libextensions_kernel.dylib` |
| Load/lookup | `LoadLibraryW` / `GetProcAddress` | `dlopen` / `dlsym` | `dlopen` / `dlsym` |
| Known quirks | strip the `\\?\` prefix from canonicalized paths before spawning process plugins (kernel handles this internally) | nothing special | gate check on first run |
| Demo | `examples/cpp-embedder-demo/build.ps1` (MinGW g++) | `build.sh` | `build.sh` |

---

## Track B — General applications (TS/Node)

Target reader: application developers adding a plugin system to a Node.js
product. No Rust toolchain needed when using prebuilt realtime artifacts.

### B1. Install

```bash
npm install extensions-manager        # when published; or from source:
npm install && npm run build          # emits dist/ (tsc), no Rust required
```

### B2. Quickstart (local mode)

```ts
import { ExtensionManager, NodeRuntime } from 'extensions-manager'

const manager = new ExtensionManager({ workspacePath: process.cwd() })
manager.registerRuntime(new NodeRuntime())
await manager.loadManifestFile('./plugins/aurora')     // directory with extension.json
const result = await manager.invoke('store.aurora', 'aurora.convert', { text: 'hi' })
```

Full lifecycle (install/update/search/uninstall with integrity pinning) lives
in `PluginStore`; manifest schema, signing modes and onboarding configs are in
the [Plugin Integration Matrix](../PLUGIN_INTEGRATION_MATRIX.md) and the
[Onboarding Decision Tree](../PLUGIN_ONBOARDING_DECISION_TREE.zh-CN.md).

### B3. Kernel modes

Configured via `host.config.json` `kernel:` block (or `createExtensionManagerFromConfig`):

| Mode | What runs where | When to use |
|---|---|---|
| `local` (default) | TS facade loads plugins directly (node/process/wasm/remote runtimes) | standard applications |
| `daemon` | the Rust `extensionsd` sidecar owns plugins; the facade speaks the envelope protocol over stdio | out-of-process governance, non-Node runtimes, policy admission enforced by the Rust kernel |
| embedded (napi) | the Rust kernel runs in-process behind the same facade; the realtime harness (`npm run test:realtime`) shows the pattern via `process.dlopen` | frame-level realtime from Node (500 fps measured, 20 plugins at 1.3% of frame budget) |

Daemon + policy + consent example:

```json
{
  "pluginsDirectory": "./plugins",
  "kernel": {
    "mode": "daemon",
    "command": "./extensionsd.exe",
    "timeoutMs": 5000,
    "asyncInvokeTimeoutMs": 120000,
    "policy": {
      "frame": { "tickHz": 360 },
      "scheduler": { "asyncPoolThreads": 2, "queueCap": 8 }
    }
  },
  "onPolicyConsent": "see README consent section"
}
```

Async accepted model (daemon mode): a `kernel.invoke` on a boundary runtime
returns the real result — the bridge keeps the promise pending through the
`{accepted}` marker and settles it when the kernel delivers the envelope
(`asyncInvokeTimeoutMs` window, default 120 s; `KERNEL_BUSY` rejects
immediately).

### B4. Realtime (embedded napi) path

Download `kernel.node` from Releases (or build it), then:

```js
import process from 'node:process'
const mod = { exports: {} }
process.dlopen(mod, './kernel.node')
const kernel = mod.exports           // request / handleResolve / invokePtr / tickPtr / ...
kernel.installResponseSink()         // async scheduler deliveries → drainAsyncResponses()
```

The full working loop — 500 fps cadence, percentile measurement, slow-plugin
coexistence — is [`realtime-tests/harness.mjs`](../realtime-tests/harness.mjs);
its report is [`realtime-tests/REPORT.md`](../realtime-tests/REPORT.md).

---

## Where to go next

- Raw data-plane contract + policy reference: [embedded-kernel-data-plane.md](embedded-kernel-data-plane.md)
- Plugin authoring (13 language/form matrix, signing, onboarding kits): [Plugin Integration Matrix](../PLUGIN_INTEGRATION_MATRIX.md)
- Manual plugin installation integrity: [manual-install-integrity-guide.md](manual-install-integrity-guide.md)
- Scheduler design + implementation record: [scheduler spike §7](superpowers/plans/2026-09-06-scheduler-spike.md)

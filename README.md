# ExtensionsManager

ExtensionsManager is a multi-runtime plugin manager for Node.js hosts, with an
embeddable Rust kernel for realtime hosts.

## Embedded realtime kernel (Rust, C ABI)

Since 2026-08 the kernel ships as an embeddable cdylib (`extensions_kernel.dll` /
`libextensions_kernel.so`) that any language can load in-process — no Node required.

- Management plane: JSON kernel envelopes over `emk_request` (load / activate /
  invoke / lifecycle), same protocol as the `extensionsd` daemon
- Data plane: byte transport over wasm linear memory (`emk_handle_resolve`,
  `emk_invoke_ptr`, `emk_tick_ptr`, `emk_handle_release`) for per-tick hosts
- In-process WASM via wasmtime: numeric guest contract (capability-named exports,
  e.g. the `wasm-extension-template`), optional byte fast path (`memory` +
  `ext_call`), optional `ext_tick` batch entry for frame-driven hosts
- Isolation: 16 MiB per-plugin memory quota; deterministic per-call fuel budget
  (default 200M instructions, `EXTENSIONS_KERNEL_WASM_FUEL` overrides) — a runaway
  plugin traps at its budget instead of hanging the host
- Measured per-call data-plane tax (release): **P99 ≈ 300 ns** — suitable for
  240 FPS+ game loops and 1000 Hz tick schedulers
- C header: `rust/extensions-kernel/capi/extensions_kernel.h`
- C++ embedder demo: `examples/cpp-embedder-demo` (builds with MinGW g++,
  artifacts stay inside the project; `-Release` flag for the latency numbers)
- Data-plane guest contract and host guidance:
  `docs/embedded-kernel-data-plane.md`
- Rust WASM data-plane plugin template:
  `examples/rust-wasm-dataplane-template`
- Roadmap and acceptance results:
  `docs/superpowers/plans/2026-08-29-embedded-realtime-kernel.md`

Wasmtime module caching is opt-in: set `EXTENSIONS_KERNEL_WASM_CACHE_DIR` to a
directory inside the host project (the cache config file is generated there).

### Performance policy engine

Declare a performance budget and the kernel derives + enforces per-plugin
limits automatically (no env vars needed):

```json
{
  "policy": {
    "frame": { "tickHz": 500, "pluginSharePct": 5 },
    "memory": { "totalMb": 512, "tiers": { "realtimeMb": 64, "interactiveMb": 128, "batchMb": 256 } }
  }
}
```

- Frame budget → per-call fuel via one-time machine calibration (a runaway
  guest traps within its declared slice);
- Memory tiers gate manifest-declared `resourceBudget.memoryMb` and drive a
  per-plugin soft/hard limiter (soft free / pressure counted / hard denied);
- `extensionClass: "resident"` (frame-critical, large memory) requires a
  declared peak reserved from `memory.totalMb` plus a `fuelPerTick`
  amortization contract (sustained over-slice → audited violation);
- Consentable overflows surface `KERNEL_CONSENT_REQUIRED`; approve them via
  the `onPolicyConsent` hook (absent = fail-closed);
- Everything is auditable: `kernel.audit.query` (bounded ring) + per-plugin
  accounting (calls/latency/fuel/memory high-water).

See `docs/embedded-kernel-data-plane.md` for the full policy reference.

## Supported extension forms

- Node package/module plugins
- External process plugins
- Source files and source folders via manifest resolution
- Platform-specific binaries through launch metadata
- WASM modules (in-process via the Rust kernel; numeric or byte contracts)

## Manifest

Each extension is described by an `extension.json` manifest.

- `artifact.kind` describes the packaging form
- `artifact.entry` points to the entry file or platform map
- `artifact.launch` configures process-based execution
- `artifact.integrity` can pin a content digest
- `signature` can protect the manifest itself
- `runtime` selects the adapter
- `capabilities` declares exposed operations

## Node extensions

Node extensions export a `capabilities` map.

```js
export default {
  capabilities: {
    'demo.hello': async () => ({ message: 'hello' }),
  },
}
```

## Process extensions

Process plugins communicate over JSON-RPC on stdio.

## Example plugin modes

The repository now includes examples for different plugin languages and packaging styles.

A dedicated cross-language compatibility table is available in `PLUGIN_INTEGRATION_MATRIX.md`.

### Runnable with the current implementation

- `examples/node-extension` - basic Node module plugin
- `examples/node-source-file-extension` - Node source file plugin using `artifact.kind: "source-file"`
- `examples/node-source-dir-extension` - Node source directory plugin using `artifact.kind: "source-dir"`
- `examples/node-package-extension` - Node package-style plugin using `artifact.kind: "package"`
- `examples/process-extension` - Node child-process plugin over JSON-RPC
- `examples/process-python-extension` - Python child-process plugin over JSON-RPC

Run the mixed-format demo with:

```bash
npm run demo:formats
```

Run the remote HTTP demo with:

```bash
npm run demo:remote-http
```

### Templates for current or external builds

- `examples/process-binary-extension-template` - compiled executable plugin template
- `examples/rust-process-extension-template` - Rust JSON-RPC process plugin template
- `examples/go-process-extension-template` - Go JSON-RPC process plugin template
- `examples/c-process-extension-template` - C JSON-RPC process plugin template
- `examples/cpp-process-extension-template` - C++ JSON-RPC process plugin template
- `examples/remote-http-extension-template` - remote HTTP JSON-RPC endpoint template
- `examples/native-shared-library-template` - native bridge-process shared-library template
- `examples/wasm-extension-template` - WASM extension template

### Rust kernel daemon demo

The repository now includes a Rust kernel stack backed by the `rust/` workspace:

- `rust/extensions-security-core` - shared signature / trust / revocation evaluator
- `rust/extensions-kernel` - kernel library
- `rust/extensionsd` - daemon executable

The host-facing packaging example remains at `examples/rust-security-core-host`.

The current daemon is still intentionally scoped, but it already exercises the new TS facade + Rust kernel architecture:

- it accepts framed kernel envelopes over stdio
- it performs manifest admission using the shared Rust signature / trust / revocation evaluator
- it normalizes legacy host manifests into canonical runtime specs
- it activates and invokes process-backed plugins
- it supports real session flows for:
  - process-backed runtimes
  - remote HTTP runtimes
- it enforces capability-level session contracts for:
  - session open
  - `session.send()`
- it returns stable closed-session errors after `close()`

This is still not the full end-state kernel, because `embedded` mode and the broader remote supervisor model are not implemented yet. The current daemon already supports `process`, `native-bridge`, `wasm`, and a scoped `remote` path.

Current remote support is intentionally scoped:

- `runtime: "remote"` can target `http` JSON-RPC endpoints from the TS facade, while `https` remains planned work
- the Rust kernel currently supports canonical `remote` with:
  - `process`-style supervised transport
  - real remote HTTP session methods
- full socket transport, multiplexed remote supervisors, and production supervisor semantics are still future work

### Session semantics

The current implementation now distinguishes between:

- compatibility session fallback for simple unary/ephemeral capabilities
- real session implementations for capabilities that declare streamed or session-oriented behavior

At the TypeScript runtime layer and the Rust kernel daemon layer:

- `interactionMode` / `executionMode` are checked before falling back to a compatibility session
- `session.send()` is rejected for capabilities that do not permit upstream messages
- `close()` transitions the session into a closed state
- after `close()`, `send()` and `nextEvent()` return a closed-session error instead of silently draining or hanging

This behavior is now covered by runtime and daemon integration tests.

Run it with:

```bash
npm run demo:rust-security-core
```

Build a host-facing bundle with:

```bash
npm run package:rust-security-core
```

That command writes `examples/rust-security-core-host/dist-package/extensions-manager-rust-security-core/` with:

- `bin/` containing the Rust kernel daemon
- `config/host.config.example.json` already pointing at the packaged daemon
- `config/trust-bundle.example.json` and `config/revocation-list.example.json`
- `package-manifest.json` describing the generated package layout
- `trusted-keys/` and `plugins/` directories for host deployment
- `README.md` documenting startup steps and file placement

### Format guidance

- Use `runtime: "node"` for JS/TS plugins loaded in-process.
- Use `runtime: "process"` for Python, Rust, Go, C++, or any language that can speak JSON-RPC over stdio.
- Use `runtime: "remote"` when the extension is exposed through an HTTP JSON-RPC endpoint rather than a local process.
- Use `artifact.kind: "binary"` when the plugin is a built executable.
- Use `artifact.kind: "shared-library"` with `runtime: "native"` when a bridge process will load the dynamic library.
- Static libraries are not directly loadable plugin artifacts in the current architecture. They must be linked into another executable or wrapped by another runtime adapter.

## Dedicated onboarding kit

A reusable onboarding kit is available at `examples/onboarding-kit`.

It is intended to be copied or referenced directly when integrating a new plugin. In most cases, another plugin only needs to modify one config file or a small set of fields.

Included files:

- `PLUGIN_ONBOARDING_GUIDE.md` - dedicated onboarding instructions
- `plugin-onboarding.config.json` - default reusable onboarding config
- `plugin-onboarding.file.config.json` - file-based trusted key mode example
- `plugin-onboarding.inline.config.json` - inline trusted public key mode example
- `plugin-onboarding.go.file.config.json` - Go process plugin onboarding config in file mode
- `plugin-onboarding.go.inline.config.json` - Go process plugin onboarding config in inline mode
- `plugin-onboarding.c.file.config.json` - C process plugin onboarding config in file mode
- `plugin-onboarding.c.inline.config.json` - C process plugin onboarding config in inline mode
- `plugin-onboarding.cpp.file.config.json` - C++ process plugin onboarding config in file mode
- `plugin-onboarding.cpp.inline.config.json` - C++ process plugin onboarding config in inline mode
- `plugin-onboarding.native.file.config.json` - native bridge plugin onboarding config in file mode
- `plugin-onboarding.native.inline.config.json` - native bridge plugin onboarding config in inline mode
- `plugin-onboarding.wasm.file.config.json` - WASM plugin onboarding config in file mode
- `plugin-onboarding.wasm.inline.config.json` - WASM plugin onboarding config in inline mode
- `extension.template.json` - reusable manifest starting point
- `trusted-keys/` - drop-in directory for signer public keys

Run the onboarding kit demo with:

```bash
npm run demo:onboarding
```

That demo now prepares and validates signed onboarding flows for Node, native bridge, and WASM examples.

## Signing

You can generate a key pair, sign a manifest, and verify it with trusted keys.

```ts
import {
  generateSigningKeyPair,
  signManifest,
  PublicKeySignatureVerifier,
  InMemoryTrustedKeyStore,
  FileTrustedKeyStore,
} from './dist/index.js'
```

Signature policy can be configured through `ExtensionManagerOptions.signaturePolicy`:

- `allow-unsigned`
- `require-signature`
- `require-signature-except-development`

### Which signature trust mode is used

The current onboarding flow supports two explicit host-side verification modes:

- `trustedKeyMode: "file"` - verify with public key files from `trusted-keys/<keyId>.pem`
- `trustedKeyMode: "inline"` - verify with PEM public key strings embedded in host config

Recommended default: `trustedKeyMode: "file"`.

That means signature verification is normally done with **public key files**, not private keys and not a shared secret string.

Inline public key strings are also supported for demos, tests, or embedded host distributions.

### Minimal signed manifest example

```ts
import {
  generateSigningKeyPair,
  signManifest,
  PublicKeySignatureVerifier,
  InMemoryTrustedKeyStore,
} from './dist/index.js'

const keyPair = generateSigningKeyPair('ed25519')

const manifest = {
  id: 'demo.signed-extension',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: { kind: 'module', entry: './index.js' },
  runtime: 'node',
  capabilities: [{ name: 'demo.hello' }],
}

const signature = signManifest(manifest, {
  algorithm: 'ed25519',
  keyId: 'demo-key',
  privateKeyPem: keyPair.privateKeyPem,
})

const verifier = new PublicKeySignatureVerifier(
  new InMemoryTrustedKeyStore({
    'demo-key': keyPair.publicKeyPem,
  }),
)

verifier.verify({
  ...manifest,
  signature,
})
```

A runnable version of this flow is available at `examples/sign-manifest.mjs`:

```bash
npm run sign:manifest
```

### Plugin onboarding: signature distribution and verification

When onboarding a new plugin under strict signature policy, the distribution and verification flow is:

1. The plugin author generates a signing key pair and keeps the private key outside the host environment.
2. The plugin author signs `extension.json` and distributes the signed manifest together with the plugin artifact.
3. The host operator installs the author's public key as `trusted-keys/<keyId>.pem`, or embeds the PEM public key into host-side config when inline mode is intentionally chosen.
4. `ExtensionManager.loadManifestFile()` verifies the manifest signature against that trusted public key before the runtime is allowed to load.

The private key is never distributed with the plugin package.

For production-style loading, you can combine strict policy with a file-backed trusted key store:

```ts
import {
  ExtensionManager,
  NodeRuntime,
  PublicKeySignatureVerifier,
  FileTrustedKeyStore,
} from './dist/index.js'

const manager = new ExtensionManager({
  signaturePolicy: 'require-signature',
  signatureVerifier: new PublicKeySignatureVerifier(
    new FileTrustedKeyStore('./trusted-keys'),
  ),
})

manager.registerRuntime(new NodeRuntime())
```

Trusted keys are resolved as `<keyId>.pem` files inside the configured directory.

### Trust bundle and revocation list

The local trust model can also classify whether a signed plugin is officially authorized or still treated as an untrusted third-party plugin.

A manifest can include trust metadata such as:

```json
{
  "trust": {
    "publisherId": "publisher.demo",
    "trustDomain": "third-party",
    "issuedBy": "third-party-issuer",
    "signingIdentityId": "signing-identity.demo"
  }
}
```

You can then pass these host-side inputs into `ExtensionManager`:

- `trustBundle`
- `revocationList`

### Security statuses

Loaded extensions now expose `extension.security.status` and `extension.security.reason`.

Possible statuses are:

- `authorized-safe` - signature is valid and the issuer is marked with `authorization: "authorized"`
- `third-party-untrusted` - signature is valid but there is no official authorization
- `unsigned` - the extension has no manifest signature

This means **a valid signature alone does not make a plugin safe**.

### Trust bundle JSON example

```json
{
  "version": "1",
  "issuers": [
    {
      "id": "official-issuer",
      "trustDomain": "official",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
      "authorization": "authorized",
      "allowedPublisherIds": ["publisher.official"]
    },
    {
      "id": "third-party-issuer",
      "trustDomain": "third-party",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
      "authorization": "untrusted"
    }
  ]
}
```

### Revocation list JSON example

```json
{
  "version": "1",
  "revokedSignatureKeys": [
    { "keyId": "demo-key" }
  ],
  "revokedIssuers": [
    { "issuerId": "third-party-issuer" }
  ],
  "revokedPublishers": [
    { "publisherId": "publisher.revoked" }
  ]
}
```

### Load trust config from JSON files

```ts
import {
  ExtensionManager,
  NodeRuntime,
  PublicKeySignatureVerifier,
  FileTrustedKeyStore,
  loadTrustBundleFile,
  loadRevocationListFile,
} from './dist/index.js'

const trustBundle = await loadTrustBundleFile('./trust-bundle.json')
const revocationList = await loadRevocationListFile('./revocation-list.json')

const manager = new ExtensionManager({
  signaturePolicy: 'require-signature',
  signatureVerifier: new PublicKeySignatureVerifier(
    new FileTrustedKeyStore('./trusted-keys'),
  ),
  trustBundle,
  revocationList,
})

manager.registerRuntime(new NodeRuntime())
```

A runnable end-to-end version of this flow is available at `examples/load-signed-extension.mjs`:

```bash
npm run demo:signed
```

## Runtime environment requirements

Not every plugin type can run without its matching runtime environment. It depends on the artifact form:

- `runtime: "node"`
  - JS / TS plugins still require the host itself to run on Node.js.
  - They usually do not require an extra per-plugin language runtime beyond the host Node environment.
- `runtime: "process"` + `artifact.kind: "binary"`
  - If the plugin is distributed as a compiled executable for the target platform, it usually does not require the original language toolchain.
  - Typical examples: compiled Go / Rust / C / C++ process plugins.
- Python process plugins
  - If the entry depends on `python` / `python3`, the target machine still needs Python installed.
- Rust / Go / C / C++ templates in this repo
  - These are onboarding templates.
  - Whether extra runtime setup is needed depends on whether you distribute source or compiled binaries.
- `runtime: "wasm"`
  - The project now supports a minimal practical WASM runtime.
  - It does not require the target machine to have the original language interpreter installed.
  - It currently works best for compute-style capabilities, with numeric input or `{ value: number }` input.
- `runtime: "native"`
  - The project now supports a practical native bridge mode.
  - It does not directly load `.dll` / `.so` / `.dylib` into the host process.
  - Instead, it requires `artifact.launch.command` to point at a bridge process that receives the shared library path.

### Comparison: interpreter-free plugin packaging options

| Option | Core idea | Host interpreter dependency | Security boundary | Capability ceiling | Cross-platform packaging | Best fit |
| --- | --- | --- | --- | --- | --- | --- |
| A. WASM | Run the plugin inside the built-in WASM runtime | No preinstalled interpreter required | Strongest control surface of the three | Lowest of the three | Usually best | Pure compute, rule, transform, or sandbox-friendly logic |
| B. Self-contained process plugin | Ship the interpreter and dependencies inside the plugin package | No host interpreter required, but the plugin carries its own runtime | Process isolation, but looser than WASM | High | Usually per-platform packages | Existing Python or other scripting ecosystems with minimal rewrite |
| C. Compiled standalone binary | Ship a native executable artifact directly | No extra runtime usually required | Process isolation, with the fewest moving runtime parts | Highest | Usually per-platform builds | Production-grade plugins where stability and operations matter most |

In practice:

- choose **C** when you want the most stable production delivery model
- choose **A** when you want the plugin manager itself to run the plugin without relying on a host interpreter
- choose **B** when you need to preserve an existing interpreted codebase with the least rewrite


## Host integration helpers

You can now assemble a host-side manager with:

- `createExtensionManagerFromConfig()`
- `createConfiguredExtensionManager()`
- `createExtensionManagerFromHostConfig()`
- `loadPluginsDirectory()`

Host config can now enable the Rust kernel daemon through `kernel`, while `commandSecurityCore` remains as a compatibility input that normalizes into the new kernel block.

```ts
import {
  createExtensionManagerFromConfig,
} from './dist/index.js'

const { manager, loaded } = await createExtensionManagerFromConfig({
  workspacePath: process.cwd(),
  signaturePolicy: 'require-signature',
  trustedKeyDirectory: './trusted-keys',
  trustBundlePath: './trust-bundle.json',
  revocationListPath: './revocation-list.json',
  pluginsDirectory: './plugins',
  pluginsRecursive: true,
})
```

Or load a full `host.config.json` directly:

```ts
import { createExtensionManagerFromHostConfig } from './dist/index.js'

const { manager, loaded } = await createExtensionManagerFromHostConfig('./host.config.json')
```

- `trustedKeyDirectory` loads `trusted-keys/<keyId>.pem`
- `trustBundlePath` loads issuer authorization policy
- `revocationListPath` loads the revocation list
- `pluginsDirectory` auto-scans and loads plugins on startup
- Node, process, native, and WASM runtimes are registered by default

Example `host.config.json` using the Rust kernel daemon:

```json
{
  "pluginsDirectory": "./plugins",
  "signaturePolicy": "require-signature",
  "trustedKeyDirectory": "./trusted-keys",
  "trustBundlePath": "./trust-bundle.json",
  "revocationListPath": "./revocation-list.json",
  "kernel": {
    "mode": "daemon",
    "transport": "pipe",
    "command": "./security-core/extensionsd.exe",
    "timeoutMs": 5000
  }
}
```

`kernel.command` may be an absolute path, a relative path resolved from the config file directory, or an executable name available on `PATH`.
`kernel` inherits top-level `signaturePolicy`, `isDevelopment`, `trustedKeyDirectory`, `trustBundlePath`, and `revocationListPath` unless you override them inside the nested block.
Legacy `commandSecurityCore` config is still accepted and normalized into the new kernel daemon configuration for compatibility.

If you want a ready-to-copy host package layout for the Rust example, run `npm run package:rust-security-core` and use `examples/rust-security-core-host/dist-package/extensions-manager-rust-security-core/config/host.config.example.json` as the starting point.

Runnable examples are available at:

- `examples/host-autoload-demo.mjs`
- `examples/host-config-demo.mjs`
- `examples/onboarding-kit/host.config.example.json`

```bash
npm run demo:host-autoload
npm run demo:host-config
```

## Usage
```ts
import { ExtensionManager, NodeRuntime, ProcessRuntime } from './dist/index.js'

const manager = new ExtensionManager()
manager.registerRuntime(new NodeRuntime())
manager.registerRuntime(new ProcessRuntime())

await manager.loadManifestFile('./examples/node-extension')
await manager.loadManifestFile('./examples/process-extension')

const result = await manager.invoke('demo.node-extension', 'demo.hello', {})
```

## Scripts

- `npm run build`
- `npm run check`
- `npm run demo`
- `npm run demo:formats`
- `npm run demo:rust-security-core`
- `npm run demo:onboarding`
- `npm run demo:signed`
- `npm run sign:manifest`
- `npm run smoke`
- `npm test`

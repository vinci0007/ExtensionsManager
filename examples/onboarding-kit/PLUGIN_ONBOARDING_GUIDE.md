# Plugin onboarding guide

This guide is a dedicated onboarding reference for extension authors and host operators.

For a cross-language compatibility summary, also see `../../PLUGIN_INTEGRATION_MATRIX.md`.
For a Chinese decision-tree style onboarding guide, see `../../PLUGIN_ONBOARDING_DECISION_TREE.zh-CN.md`.

## What to change to onboard a new plugin

You can usually onboard a new plugin by editing only these files:

- `plugin-onboarding.config.json`
- `extension.template.json`
- optionally `trusted-keys/<keyId>.pem`

For language-specific starting points, you can also reuse:

- `plugin-onboarding.go.file.config.json`
- `plugin-onboarding.go.inline.config.json`
- `plugin-onboarding.c.file.config.json`
- `plugin-onboarding.c.inline.config.json`
- `plugin-onboarding.cpp.file.config.json`
- `plugin-onboarding.cpp.inline.config.json`
- `plugin-onboarding.native.file.config.json`
- `plugin-onboarding.native.inline.config.json`
- `plugin-onboarding.wasm.file.config.json`
- `plugin-onboarding.wasm.inline.config.json`

## Recommended plugin onboarding flow

1. Copy `extension.template.json` into your plugin directory as `extension.json`.
2. Update `id`, `artifact.kind`, `artifact.entry`, `runtime`, and `capabilities`.
3. Choose the signing trust mode in `plugin-onboarding.config.json`.
4. If using file-based trust, place the signer's public key at `trusted-keys/<keyId>.pem`.
5. If using inline trust, paste the signer's public key PEM into the config.
6. Sign the manifest with the private key held by the plugin publisher.
7. Load the plugin with the onboarding runner.

## Signature verification modes

The current onboarding kit supports two explicit verification modes:

### 1. File-based trusted key mode

- Config: `trustedKeyMode: "file"`
- Verification source: `trusted-keys/<keyId>.pem`
- Recommended for production and multi-plugin hosts

This is the default recommended mode because trusted public keys are managed separately from plugin packages.

### 2. Inline trusted key mode

- Config: `trustedKeyMode: "inline"`
- Verification source: `trustedPublicKeys[<keyId>] = "-----BEGIN PUBLIC KEY----- ..."`
- Useful for demos, tests, or embedded distributions

## Language-specific guidance

### JS / TS plugins

- Prefer `runtime: "node"`
- Reuse the default `extension.template.json`
- Typical entry: `./index.js` or built output like `./dist/index.js`

### Python / Rust / Go / C++ plugins

- Prefer `runtime: "process"`
- Use `artifact.kind: "binary"` for built executables
- Speak JSON-RPC over stdio
- Reuse the process plugin templates under `examples/`

### Go plugins

Use `examples/go-process-extension-template` as the starting point.

Recommended onboarding config starting points:

- `plugin-onboarding.go.file.config.json`
- `plugin-onboarding.go.inline.config.json`

### C plugins

Use `examples/c-process-extension-template` as the starting point.

Recommended onboarding config starting points:

- `plugin-onboarding.c.file.config.json`
- `plugin-onboarding.c.inline.config.json`

### C++ plugins

Use `examples/cpp-process-extension-template` as the starting point.

Recommended onboarding config starting points:

- `plugin-onboarding.cpp.file.config.json`
- `plugin-onboarding.cpp.inline.config.json`

### Native shared-library plugins

Use `examples/native-shared-library-template` as the starting point.

Recommended onboarding config starting points:

- `plugin-onboarding.native.file.config.json`
- `plugin-onboarding.native.inline.config.json`

Notes:

- use `runtime: "native"`
- provide `artifact.launch.command` and `artifact.launch.args` for the bridge process
- if your bridge is a Node script, prefer an absolute Node executable path such as `process.execPath` in generated host-side manifests, or ensure `node` is resolvable on the target PATH
- the bridge process must speak JSON-RPC over stdio
- the runtime appends the resolved shared-library path to the bridge arguments automatically

### WASM plugins

Use `examples/wasm-extension-template` as the starting point.

Recommended onboarding config starting points:

- `plugin-onboarding.wasm.file.config.json`
- `plugin-onboarding.wasm.inline.config.json`

Notes:

- use `runtime: "wasm"`
- point `artifact.entry` at the compiled `.wasm` file
- map host capability names to exported WASM functions with `capabilities[].binding`
- current practical input shape is numeric input or `{ value: number }`

## Onboarding runner runtime support

`examples/run-onboarding-config.mjs` now supports these runtime values directly:

- `node`
- `process`
- `native`
- `wasm`

After running the preparation step, you can validate the generated onboarding flows with commands such as:

```bash
node examples/prepare-onboarding-kit.mjs
node examples/run-onboarding-config.mjs plugin-onboarding.file.config.json
node examples/run-onboarding-config.mjs plugin-onboarding.native.file.config.json
node examples/run-onboarding-config.mjs plugin-onboarding.wasm.file.config.json
```

## What is actually signed and distributed

- The plugin publisher signs `extension.json`.
- The signed manifest is distributed together with the plugin artifact.
- The private key is never distributed with the plugin.
- The public key is distributed separately to the host trust store, or embedded in host-side config if inline mode is chosen.

## Current recommendation

Use file-based trust in real deployments:

- easier key rotation
- cleaner separation between plugin package and host trust
- less accidental exposure of trusted key material in app config

Use inline trust only when you intentionally want a self-contained host config.

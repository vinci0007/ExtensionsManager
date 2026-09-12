# Rust Kernel Host

This example directory is now a host-facing packaging and demo shell around the Rust workspace crates rather than the source location of the security core itself.

The actual Rust sources now live under:

- `rust/extensions-security-core`
- `rust/extensions-kernel`
- `rust/extensionsd`

The daemon binary is built from that `rust/` workspace and currently provides:

- manifest admission using the shared Rust signature/trust/revocation evaluator
- framed kernel request/response/event envelopes over stdio
- process-backed plugin activation, invocation, and unary session compatibility
- host-config integration through the new `kernel` block

It is still intentionally scoped: `embedded` mode and the broader streamed remote supervisor model remain future integration targets.

The daemon now supports:

- process-backed plugins
- native bridge plugins
- minimal WASM execution
- minimal plain-HTTP remote runtime and supervised process remote runtimes

The bundled `examples/rust-security-core-host.mjs` script wires a signed plugin through `host.config.json` using the Rust `extensionsd` daemon, so the example exercises the new kernel bridge path end to end.

Run the end-to-end demo from the repository root:

```bash
npm run demo:rust-security-core
```

Build a distributable host bundle from the repository root:

```bash
npm run package:rust-security-core
```

That command produces `examples/rust-security-core-host/dist-package/extensions-manager-rust-security-core/` with:

- `bin/` containing the Rust kernel daemon executable
- `config/host.config.example.json` wired to the packaged daemon
- `config/trust-bundle.example.json` and `config/revocation-list.example.json`
- `package-manifest.json` describing the generated package layout
- `trusted-keys/` and `plugins/` drop-in directories
- `README.md` with host startup steps

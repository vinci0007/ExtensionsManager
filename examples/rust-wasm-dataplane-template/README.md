# Rust WASM Data-Plane Plugin Template

A `no_std` Rust guest module for the embedded extensions kernel data plane
(in-process wasmtime). Demonstrates both invocation contracts:

- **Byte fast path**: `memory` (auto-exported by rustc for cdylib wasm targets) +
  `ext_call(in_ptr, in_len) -> i64`, plus the optional `ext_tick` batch entry.
  The host writes request bytes at linear-memory offset 0; the plugin returns
  `(out_ptr << 32) | out_len` packed in an i64 (negative = plugin failure).
- **Numeric contract**: plain capability exports like `addOne(i32) -> i32`,
  invoked with numeric or `{"value": n}` input — same as
  `examples/wasm-extension-template`.

## Build

```bash
rustup target add wasm32-unknown-unknown   # one-time
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/rust_wasm_dataplane_template.wasm plugin.wasm
```

## Run

Load `plugin.wasm` through the kernel with `runtime.kind = "wasm"`,
`entryPath = ./plugin.wasm`. Reference: `docs/embedded-kernel-data-plane.md`.

Constraints enforced by the kernel: linear memory quota 16 MiB (256 pages),
per-call fuel budget (default 200M instructions, deterministic),
input payload up to 1 MiB written at offset 0.

# WASM extension template

This template shows a currently supported `runtime: "wasm"` extension shape.

## Current status

`WasmRuntime` is implemented and can load a `.wasm` module directly.

## Included files

- `extension.json` - WASM plugin manifest template
- `plugin.wat` - minimal text-format WebAssembly source template
- `plugin.wasm` - compiled artifact referenced by the manifest

## When to use this shape

Use this template when your plugin can be packaged as a WebAssembly module and your capability is primarily compute-oriented.

Current practical fit:

- numeric input
- `{ value: number }` input
- exported WebAssembly functions mapped through capability `binding`

## Manifest notes

- `artifact.kind: "wasm"` points to the compiled `.wasm` file
- `runtime: "wasm"` selects the built-in WASM runtime
- `capabilities[].name` is the host-facing capability name
- `capabilities[].binding` maps that capability to the exported WASM function name

Example:

```json
{
  "artifact": {
    "kind": "wasm",
    "entry": "./plugin.wasm"
  },
  "runtime": "wasm",
  "capabilities": [
    {
      "name": "demo.addOne",
      "binding": "addOne"
    }
  ]
}
```

## Minimal source template

The included `plugin.wat` matches the manifest above:

```wat
(module
  (func (export "addOne") (param i32) (result i32)
    local.get 0
    i32.const 1
    i32.add)
)
```

## Build the `.wasm` artifact

If you have the WebAssembly Binary Toolkit installed, you can compile the included source with:

```bash
wat2wasm plugin.wat -o plugin.wasm
```

After that, keep `extension.json` and `plugin.wasm` together in the same plugin directory.

## Packaging guidance

- compile your plugin to a `.wasm` artifact
- export functions whose names match the configured capability `binding`
- prefer pure-function style capabilities with simple numeric inputs
- use `.wat` only as a source form or teaching template; the runtime loads `.wasm`

If you need richer object exchange or direct access to host libraries, prefer `runtime: "process"` or `runtime: "node"` instead.

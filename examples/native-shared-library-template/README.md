# Native shared-library template

This template shows the currently supported bridge-process form of `runtime: "native"`.

## Current status

`NativeRuntime` is implemented through a bridge-process model.

The host does not load `.dll` / `.so` / `.dylib` directly into its own process. Instead, it starts the configured bridge command and passes the resolved shared-library path to that bridge.

## Included files

- `extension.json` - native plugin manifest template
- `bridge.mjs` - minimal JSON-RPC bridge template
- `src/plugin.c` - example native source file

## When to use this shape

Use `artifact.kind: "shared-library"` when your plugin artifact is a platform-specific dynamic library such as:

- `.dll`
- `.so`
- `.dylib`

Use `runtime: "native"` when you want host-side manifest management but still need a separate bridge process to speak JSON-RPC over stdio.

## Manifest notes

- `artifact.entry` can provide platform-specific shared-library paths
- `artifact.launch.command` is required and points to the bridge process
- `artifact.launch.args` contains the bridge arguments before the library path is appended
- `artifact.launch.cwd: "${basePath}"` keeps relative bridge paths stable when the host loads the plugin from another working directory
- the runtime will append the resolved library path to the bridge-process arguments automatically

Example:

```json
{
  "artifact": {
    "kind": "shared-library",
    "entry": {
      "win32-x64": "./build/plugin.dll",
      "linux-x64": "./build/libplugin.so",
      "darwin-arm64": "./build/libplugin.dylib",
      "default": "./build/libplugin.so"
    },
    "launch": {
      "command": "node",
      "args": ["./bridge.mjs"],
      "cwd": "${basePath}",
      "timeoutMs": 5000
    }
  },
  "runtime": "native"
}
```

At runtime, the effective bridge command becomes equivalent to:

```bash
node ./bridge.mjs <resolved-shared-library-path>
```

## Bridge process contract

Your bridge process must communicate with the host over JSON-RPC on stdio, the same way as a `runtime: "process"` plugin.

The included `bridge.mjs` is a minimal template that:

1. receives the shared-library path from the command line
2. verifies that the library file exists
3. responds to `extension/activate`
4. responds to `extension/invoke`
5. exits on `extension/deactivate`

You can replace the placeholder response logic with real FFI calls from Node, or rewrite the bridge in another language as long as it preserves the same stdio JSON-RPC contract.

## Static library note

Static libraries are not directly loadable plugin artifacts in the current architecture. They must be linked into a host executable or wrapped by another runtime-specific adapter.

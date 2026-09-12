# Remote HTTP Extension Template

This template demonstrates the canonical `runtime: "remote"` path using an HTTP JSON-RPC endpoint.

It is intended for extensions that run outside the local host process and are reached through a URL rather than stdio.

## Files

- `extension.json` declares a `remote` runtime with `transport: "http"`
- `server.mjs` is a minimal JSON-RPC endpoint that responds to:
  - `extension/load`
  - `extension/status`
  - `extension/activate`
  - `extension/invoke`
  - `extension/deactivate`

## Notes

- The endpoint URL is currently baked into `extension.json` as `http://127.0.0.1:47111/...`.
- The TypeScript facade supports `http` and `https` remote endpoints.
- `ExtensionManager.checkStatus()` calls `extension/status`, so health checks can be implemented without re-running `extension/load`.
- The current Rust kernel daemon supports minimal canonical `remote/http` for unary JSON-RPC calls.
- Streamed sessions for remote endpoints are not implemented yet.

## Run the template server

```bash
node server.mjs
```

Then load the template directory with `ExtensionManager.loadManifestFile()` or through `host.config.json`.

# Go process extension template

This template is for Go plugins that run as child processes and communicate over JSON-RPC on stdio.

## Build suggestion

```bash
go build -o build/demo-go-process-extension ./cmd/plugin
```

## Runtime contract

- stdin: newline-delimited JSON-RPC requests
- stdout: newline-delimited JSON-RPC responses
- required methods:
  - `extension/activate`
  - `extension/deactivate`
  - `extension/invoke`

## Recommended use

Use this template when the plugin is written in Go and you want process isolation instead of in-process Node loading.

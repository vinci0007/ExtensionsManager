# C process extension template

This template is for C plugins that run as child processes and communicate over JSON-RPC on stdio.

## Build suggestion

### Linux / macOS

```bash
cc -O2 -o build/demo-c-process-extension src/main.c
```

### Windows

```bash
cl /O2 /Fe:build\\demo-c-process-extension.exe src\\main.c
```

## Runtime contract

- stdin: newline-delimited JSON-RPC requests
- stdout: newline-delimited JSON-RPC responses
- required methods:
  - `extension/activate`
  - `extension/deactivate`
  - `extension/invoke`

## Recommended use

Use this template when the plugin is written in C and you want process isolation via a standalone executable.

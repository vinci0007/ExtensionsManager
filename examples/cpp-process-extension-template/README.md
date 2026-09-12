# C++ process extension template

This template is for C++ plugins that run as child processes and communicate over JSON-RPC on stdio.

## Build suggestion

### Linux / macOS

```bash
c++ -O2 -std=c++17 -o build/demo-cpp-process-extension src/main.cpp
```

### Windows

```bash
cl /EHsc /O2 /std:c++17 /Fe:build\\demo-cpp-process-extension.exe src\\main.cpp
```

## Runtime contract

- stdin: newline-delimited JSON-RPC requests
- stdout: newline-delimited JSON-RPC responses
- required methods:
  - `extension/activate`
  - `extension/deactivate`
  - `extension/invoke`

## Recommended use

Use this template when the plugin is written in C++ and you want process isolation via a standalone executable.

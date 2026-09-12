# Process binary extension template

This template is for compiled executables that speak JSON-RPC over stdio.

## Expected runtime contract

- The process is launched as the plugin entry itself unless `artifact.launch.command` overrides it.
- Requests arrive as newline-delimited JSON-RPC messages on stdin.
- Responses must be written as newline-delimited JSON-RPC messages on stdout.
- The plugin should support:
  - `extension/activate`
  - `extension/deactivate`
  - `extension/invoke`

## Typical language choices

- Rust
- Go
- C++
- Zig
- .NET single-file executables

## Packaging note

Use `artifact.entry` for the built executable and `artifact.launch` for any flags, cwd, env, or timeout settings.

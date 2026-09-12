# Plugin Integration Matrix

This document is a dedicated compatibility and onboarding matrix for plugin authors.

## Integration matrix

| Language / artifact | Recommended runtime | Recommended artifact.kind | Directly runnable now | Signature support | Recommended onboarding config | Example / template |
| --- | --- | --- | --- | --- | --- | --- |
| JS / TS in-process module | `node` | `module` | Yes | Yes | `examples/onboarding-kit/plugin-onboarding.config.json` | `examples/node-extension` |
| JS / TS source file | `node` | `source-file` | Yes | Yes | `examples/onboarding-kit/plugin-onboarding.config.json` | `examples/node-source-file-extension` |
| JS / TS source directory | `node` | `source-dir` | Yes | Yes | `examples/onboarding-kit/plugin-onboarding.config.json` | `examples/node-source-dir-extension` |
| JS / TS package output | `node` | `package` | Yes | Yes | `examples/onboarding-kit/plugin-onboarding.config.json` | `examples/node-package-extension` |
| Node child process | `process` | `binary` | Yes | Yes | `examples/onboarding-kit/plugin-onboarding.file.config.json` | `examples/process-extension` |
| Python child process | `process` | `binary` | Yes, if Python is installed | Yes | `examples/onboarding-kit/plugin-onboarding.file.config.json` | `examples/process-python-extension` |
| Rust executable | `process` | `binary` | Template only | Yes | file / inline process config pattern | `examples/rust-process-extension-template` |
| Go executable | `process` | `binary` | Template only | Yes | `plugin-onboarding.go.file.config.json` / `plugin-onboarding.go.inline.config.json` | `examples/go-process-extension-template` |
| C executable | `process` | `binary` | Template only | Yes | `plugin-onboarding.c.file.config.json` / `plugin-onboarding.c.inline.config.json` | `examples/c-process-extension-template` |
| C++ executable | `process` | `binary` | Template only | Yes | `plugin-onboarding.cpp.file.config.json` / `plugin-onboarding.cpp.inline.config.json` | `examples/cpp-process-extension-template` |
| Shared library (`.dll` / `.so` / `.dylib`) | `native` | `shared-library` | No, runtime placeholder only | Manifest signing supported; runtime loading not implemented | none yet | `examples/native-shared-library-template` |
| WASM artifact | `wasm` | `wasm` | No, runtime placeholder only | Manifest signing supported; runtime loading not implemented | none yet | `examples/wasm-extension-template` |
| Static library (`.a` / `.lib`) | not direct | not direct | No | not a directly loadable plugin artifact | not applicable | wrap inside process or native adapter |

## Signature verification mode matrix

| Trust mode | Verification source | Recommended use | Supported now |
| --- | --- | --- | --- |
| `file` | `trusted-keys/<keyId>.pem` public key file | Production, multi-plugin hosts, key rotation | Yes |
| `inline` | PEM public key string in config | Demos, tests, embedded distributions | Yes |

Recommended default: `trustedKeyMode: "file"`.

## Selection guidance

- If the plugin is already JS / TS and can run safely in-process, use `runtime: "node"`.
- If the plugin is written in another language, prefer `runtime: "process"` and JSON-RPC over stdio.
- If the artifact is a compiled executable, use `artifact.kind: "binary"`.
- If the artifact is a dynamic library, you can model it today but cannot load it until native runtime support is implemented.
- Static libraries are not directly loadable plugin artifacts in the current architecture.

## Notes on signing

- Manifest signing works independently from runtime type.
- What is signed is `extension.json`.
- The private key stays with the plugin publisher.
- The host verifies with a trusted public key, either from file mode or inline mode.

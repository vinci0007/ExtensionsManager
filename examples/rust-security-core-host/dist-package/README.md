# Rust Security Core Host Package

This folder is a distributable host-facing bundle for the Rust `CommandSecurityCore` demo.

Included layout:

- `bin/demo-rust-security-core.exe` - external security core executable
- `host.config.example.json` - host config wired to the packaged binary
- `trust-bundle.example.json` - issuer authorization policy template
- `revocation-list.example.json` - revocation list template
- `trusted-keys/` - drop signer public keys here as `<keyId>.pem`
- `plugins/` - place signed plugins here for host auto-loading

Startup steps:

1. Copy this folder to the target host machine.
2. Replace placeholder values in `trust-bundle.example.json`.
3. Add trusted signer public keys into `trusted-keys/`.
4. Copy signed plugin directories into `plugins/`.
5. Rename `host.config.example.json` to `host.config.json` or point your host at the example file directly.
6. Call `createExtensionManagerFromHostConfig('./host.config.json')`.

The packaged binary reads `CommandSecurityCoreRequest` JSON from stdin and returns `ExtensionSecurityInfo` JSON on stdout.
It enforces signature policy, verifies `ed25519` and `rsa-sha256` manifest signatures, resolves trusted keys, and applies trust-bundle and revocation decisions.

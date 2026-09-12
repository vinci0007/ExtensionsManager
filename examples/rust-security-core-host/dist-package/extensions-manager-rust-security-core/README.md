# Rust Kernel Host Package

This folder is a distributable host-facing bundle for the Rust kernel daemon example.

Included layout:

- `bin/extensionsd.exe` - Rust kernel daemon executable
- `config/host.config.example.json` - host config wired to the packaged daemon
- `config/trust-bundle.example.json` - issuer authorization policy template
- `config/revocation-list.example.json` - revocation list template
- `package-manifest.json` - generated package metadata and layout manifest
- `trusted-keys/` - drop signer public keys here as `<keyId>.pem`
- `plugins/` - place signed plugins here for host auto-loading

Startup steps:

1. Copy this folder to the target host machine.
2. Replace placeholder values in `config/trust-bundle.example.json`.
3. Add trusted signer public keys into `trusted-keys/`.
4. Copy signed plugin directories into `plugins/`.
5. Rename `config/host.config.example.json` to `config/host.config.json` or point your host at the example file directly.
6. Call `createExtensionManagerFromHostConfig('./config/host.config.json')`.

The packaged daemon reads framed kernel envelopes from stdin and returns kernel response/event envelopes on stdout.
It performs manifest admission, applies signature and trust policy, normalizes legacy runtimes, and executes process-backed plugins through the new kernel bridge model.

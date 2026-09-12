import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')
const hostExampleRoot = path.join(root, 'examples', 'rust-security-core-host')
const rustWorkspaceRoot = path.join(root, 'rust')
const cargoManifestPath = path.join(rustWorkspaceRoot, 'Cargo.toml')
const artifactName = 'extensions-manager-rust-security-core'
const binaryName = process.platform === 'win32'
  ? 'extensionsd.exe'
  : 'extensionsd'
const builtBinaryPath = path.join(rustWorkspaceRoot, 'target', 'release', binaryName)
const packageRoot = path.join(hostExampleRoot, 'dist-package', artifactName)
const packagedBinaryPath = path.join(packageRoot, 'bin', binaryName)
const configRoot = path.join(packageRoot, 'config')
const packageVersion = '0.1.0'

async function main() {
  buildRustSecurityCore()

  await fs.rm(packageRoot, { recursive: true, force: true })
  await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true })
  await fs.mkdir(configRoot, { recursive: true })
  await fs.mkdir(path.join(packageRoot, 'plugins'), { recursive: true })
  await fs.mkdir(path.join(packageRoot, 'trusted-keys'), { recursive: true })

  await fs.copyFile(builtBinaryPath, packagedBinaryPath)
  if (process.platform !== 'win32') {
    await fs.chmod(packagedBinaryPath, 0o755)
  }

  await writeHostConfigExample()
  await writeTrustBundleExample()
  await writeRevocationListExample()
  await writePackageManifest()
  await writePackageReadme()
  await writeDirectoryReadmes()

  console.log(JSON.stringify({
    packageRoot,
    binaryPath: packagedBinaryPath,
    hostConfigPath: path.join(configRoot, 'host.config.example.json'),
  }, null, 2))
}

function buildRustSecurityCore() {
  const result = spawnSync('cargo', ['build', '--release', '--manifest-path', cargoManifestPath, '-p', 'extensionsd'], {
    cwd: root,
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

async function writeHostConfigExample() {
  const hostConfig = {
    workspacePath: '..',
    pluginsDirectory: '../plugins',
    pluginsRecursive: true,
    signaturePolicy: 'require-signature',
    trustedKeyDirectory: '../trusted-keys',
    trustBundlePath: './trust-bundle.example.json',
    revocationListPath: './revocation-list.example.json',
    kernel: {
      mode: 'daemon',
      transport: 'pipe',
      command: `../bin/${binaryName}`,
      timeoutMs: 5000,
    },
  }

  await fs.writeFile(
    path.join(configRoot, 'host.config.example.json'),
    JSON.stringify(hostConfig, null, 2),
    'utf8',
  )
}

async function writeTrustBundleExample() {
  const trustBundle = {
    version: '1',
    issuers: [
      {
        id: 'third-party-issuer',
        trustDomain: 'third-party',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\nREPLACE_WITH_ISSUER_PUBLIC_KEY\n-----END PUBLIC KEY-----',
        authorization: 'authorized',
        allowedPublisherIds: ['publisher.demo'],
      },
    ],
  }

  await fs.writeFile(
    path.join(configRoot, 'trust-bundle.example.json'),
    JSON.stringify(trustBundle, null, 2),
    'utf8',
  )
}

async function writeRevocationListExample() {
  await fs.writeFile(
    path.join(configRoot, 'revocation-list.example.json'),
    JSON.stringify({ version: '1' }, null, 2),
    'utf8',
  )
}

async function writePackageManifest() {
  const manifest = {
    packageName: artifactName,
    version: packageVersion,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    binary: {
      path: `bin/${binaryName}`,
      fileName: binaryName,
    },
    config: {
      hostConfigExample: 'config/host.config.example.json',
      trustBundleExample: 'config/trust-bundle.example.json',
      revocationListExample: 'config/revocation-list.example.json',
    },
    directories: {
      plugins: 'plugins',
      trustedKeys: 'trusted-keys',
    },
  }

  await fs.writeFile(
    path.join(packageRoot, 'package-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )
}

async function writePackageReadme() {
  const readme = `# Rust Kernel Host Package

This folder is a distributable host-facing bundle for the Rust kernel daemon example.

Included layout:

- \`bin/${binaryName}\` - Rust kernel daemon executable
- \`config/host.config.example.json\` - host config wired to the packaged daemon
- \`config/trust-bundle.example.json\` - issuer authorization policy template
- \`config/revocation-list.example.json\` - revocation list template
- \`package-manifest.json\` - generated package metadata and layout manifest
- \`trusted-keys/\` - drop signer public keys here as \`<keyId>.pem\`
- \`plugins/\` - place signed plugins here for host auto-loading

Startup steps:

1. Copy this folder to the target host machine.
2. Replace placeholder values in \`config/trust-bundle.example.json\`.
3. Add trusted signer public keys into \`trusted-keys/\`.
4. Copy signed plugin directories into \`plugins/\`.
5. Rename \`config/host.config.example.json\` to \`config/host.config.json\` or point your host at the example file directly.
6. Call \`createExtensionManagerFromHostConfig('./config/host.config.json')\`.

The packaged daemon reads framed kernel envelopes from stdin and returns kernel response/event envelopes on stdout.
It performs manifest admission, applies signature and trust policy, normalizes legacy runtimes, and executes process-backed plugins through the new kernel bridge model.
`

  await fs.writeFile(path.join(packageRoot, 'README.md'), readme, 'utf8')
}

async function writeDirectoryReadmes() {
  await fs.writeFile(
    path.join(configRoot, 'README.md'),
    '# Config\n\nEdit the example JSON files here and point your host at `host.config.json`.\n',
    'utf8',
  )
  await fs.writeFile(
    path.join(packageRoot, 'trusted-keys', 'README.md'),
    '# Trusted keys\n\nStore signer public keys here as `<keyId>.pem`.\n',
    'utf8',
  )
  await fs.writeFile(
    path.join(packageRoot, 'plugins', 'README.md'),
    '# Plugins\n\nCopy signed plugin directories here when using `pluginsDirectory` auto-loading.\n',
    'utf8',
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

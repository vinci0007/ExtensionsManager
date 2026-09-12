import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createExtensionManagerFromHostConfig,
  generateSigningKeyPair,
  signManifest,
} from '../dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')
const rustWorkspaceRoot = path.join(root, 'rust')
const cargoManifestPath = path.join(rustWorkspaceRoot, 'Cargo.toml')
const binaryName = process.platform === 'win32'
  ? 'extensionsd.exe'
  : 'extensionsd'
const binaryPath = path.join(rustWorkspaceRoot, 'target', 'release', binaryName)

async function main() {
  buildRustSecurityCore()

  const keyPair = generateSigningKeyPair('ed25519')
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-rust-security-core-host-'))
  const pluginDirectory = path.join(tempDirectory, 'plugin')
  const trustedKeyDirectory = path.join(tempDirectory, 'trusted-keys')
  const trustBundlePath = path.join(tempDirectory, 'trust-bundle.json')
  const revocationListPath = path.join(tempDirectory, 'revocation-list.json')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.mkdir(trustedKeyDirectory, { recursive: true })

    const manifest = {
      id: 'demo.rust-security-core-node-extension',
      version: '1.0.0',
      protocolVersion: '1',
      trust: {
        publisherId: 'publisher.demo',
        trustDomain: 'third-party',
        issuedBy: 'third-party-issuer',
      },
      artifact: {
        kind: 'module',
        entry: './index.js',
      },
      runtime: 'node',
      capabilities: [
        {
          name: 'demo.hello',
        },
      ],
    }
    const signature = signManifest(manifest, {
      algorithm: 'ed25519',
      keyId: 'demo-key',
      privateKeyPem: keyPair.privateKeyPem,
    })

    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      ...manifest,
      signature,
    }, null, 2), 'utf8')
    await fs.copyFile(path.join(root, 'examples', 'node-extension', 'index.js'), path.join(pluginDirectory, 'index.js'))
    await fs.writeFile(path.join(trustedKeyDirectory, 'demo-key.pem'), keyPair.publicKeyPem, 'utf8')
    await fs.writeFile(trustBundlePath, JSON.stringify({
      version: '1',
      issuers: [
        {
          id: 'third-party-issuer',
          trustDomain: 'third-party',
          publicKeyPem: keyPair.publicKeyPem,
          authorization: 'authorized',
          allowedPublisherIds: ['publisher.demo'],
        },
      ],
    }, null, 2), 'utf8')
    await fs.writeFile(revocationListPath, JSON.stringify({ version: '1' }, null, 2), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      workspacePath: root,
      pluginsDirectory: './plugin',
      pluginsRecursive: false,
      signaturePolicy: 'require-signature',
      trustedKeyDirectory: './trusted-keys',
      trustBundlePath: './trust-bundle.json',
      revocationListPath: './revocation-list.json',
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: binaryPath,
        timeoutMs: 5000,
      },
    }, null, 2), 'utf8')

    const { manager, loaded } = await createExtensionManagerFromHostConfig(hostConfigPath)
    const extension = loaded[0]
    if (!extension) {
      throw new Error('Rust security core host-config demo did not load any plugin')
    }
    const result = await manager.invoke('demo.rust-security-core-node-extension', 'demo.hello', {})

    console.log(JSON.stringify({
      binaryPath,
      security: extension.security,
      result,
    }, null, 2))

    await manager.deactivate('demo.rust-security-core-node-extension')
    await manager.dispose()
  } finally {
    await removeDirectoryWithRetry(tempDirectory)
  }
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

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

async function removeDirectoryWithRetry(directory) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code !== 'EBUSY' || attempt === 4) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

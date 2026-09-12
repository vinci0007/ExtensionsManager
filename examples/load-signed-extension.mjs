import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ExtensionManager,
  FileTrustedKeyStore,
  NodeRuntime,
  PublicKeySignatureVerifier,
  generateSigningKeyPair,
  signManifest,
} from '../dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')

async function main() {
  const keyPair = generateSigningKeyPair('ed25519')
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-signed-load-'))
  const extensionDirectory = path.join(tempDirectory, 'signed-node-extension')
  const trustedKeyDirectory = path.join(tempDirectory, 'trusted-keys')

  try {
    await fs.mkdir(extensionDirectory)
    await fs.mkdir(trustedKeyDirectory)

    const manifest = {
      id: 'demo.signed-node-extension',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.hello' }],
    }

    const signature = signManifest(manifest, {
      algorithm: 'ed25519',
      keyId: 'demo-key',
      privateKeyPem: keyPair.privateKeyPem,
    })

    await fs.writeFile(
      path.join(extensionDirectory, 'extension.json'),
      JSON.stringify({ ...manifest, signature }, null, 2),
      'utf8',
    )
    await fs.copyFile(
      path.join(root, 'examples/node-extension/index.js'),
      path.join(extensionDirectory, 'index.js'),
    )
    await fs.writeFile(
      path.join(trustedKeyDirectory, 'demo-key.pem'),
      keyPair.publicKeyPem,
      'utf8',
    )

    const manager = new ExtensionManager({
      workspacePath: root,
      signaturePolicy: 'require-signature',
      signatureVerifier: new PublicKeySignatureVerifier(
        new FileTrustedKeyStore(trustedKeyDirectory),
      ),
    })
    manager.registerRuntime(new NodeRuntime())

    await manager.loadManifestFile(extensionDirectory)
    const result = await manager.invoke('demo.signed-node-extension', 'demo.hello', {})

    console.log(JSON.stringify({
      verified: true,
      extensionDirectory,
      trustedKeyPath: path.join(trustedKeyDirectory, 'demo-key.pem'),
      result,
    }, null, 2))

    await manager.deactivate('demo.signed-node-extension')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

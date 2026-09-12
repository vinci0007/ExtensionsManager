import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createExtensionManagerFromConfig,
  generateSigningKeyPair,
  signManifest,
} from '../dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')

async function main() {
  const keyPair = generateSigningKeyPair('ed25519')
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-host-autoload-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const trustedKeyDirectory = path.join(tempDirectory, 'trusted-keys')
  const trustBundlePath = path.join(tempDirectory, 'trust-bundle.json')
  const revocationListPath = path.join(tempDirectory, 'revocation-list.json')
  const pluginDirectory = path.join(pluginsDirectory, 'authorized-node-plugin')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.mkdir(trustedKeyDirectory, { recursive: true })

    const manifest = {
      id: 'demo.authorized-node-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      trust: {
        publisherId: 'publisher.demo',
        trustDomain: 'third-party',
        issuedBy: 'third-party-issuer',
      },
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
      path.join(pluginDirectory, 'extension.json'),
      JSON.stringify({ ...manifest, signature }, null, 2),
      'utf8',
    )
    await fs.copyFile(
      path.join(root, 'examples/node-extension/index.js'),
      path.join(pluginDirectory, 'index.js'),
    )
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

    const configured = await createExtensionManagerFromConfig({
      workspacePath: root,
      signaturePolicy: 'require-signature',
      trustedKeyDirectory,
      trustBundlePath,
      revocationListPath,
      pluginsDirectory,
    })

    const result = await configured.manager.invoke('demo.authorized-node-plugin', 'demo.hello', {})

    console.log(JSON.stringify({
      loaded: configured.loaded.map((item) => ({
        id: item.id,
        security: item.security,
      })),
      result,
    }, null, 2))

    await configured.manager.deactivate('demo.authorized-node-plugin')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

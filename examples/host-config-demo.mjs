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

async function main() {
  const keyPair = generateSigningKeyPair('ed25519')
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-host-config-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')
  const trustedKeyDirectory = path.join(tempDirectory, 'trusted-keys')
  const trustBundlePath = path.join(tempDirectory, 'trust-bundle.json')
  const revocationListPath = path.join(tempDirectory, 'revocation-list.json')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.mkdir(trustedKeyDirectory, { recursive: true })

    const manifest = {
      id: 'demo.host-config-plugin',
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

    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({ ...manifest, signature }, null, 2), 'utf8')
    await fs.copyFile(path.join(root, 'examples/node-extension/index.js'), path.join(pluginDirectory, 'index.js'))
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
      signaturePolicy: 'require-signature',
      trustedKeyDirectory: './trusted-keys',
      trustBundlePath: './trust-bundle.json',
      revocationListPath: './revocation-list.json',
      pluginsDirectory: './plugins',
      isDevelopment: true,
      pluginsRecursive: true,
    }, null, 2), 'utf8')

    const { manager, loaded } = await createExtensionManagerFromHostConfig(hostConfigPath)
    const result = await manager.invoke('demo.host-config-plugin', 'demo.hello', {})

    console.log(JSON.stringify({
      loaded: loaded.map((item) => ({ id: item.id, security: item.security })),
      result,
    }, null, 2))

    await manager.deactivate('demo.host-config-plugin')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  createExtensionManagerFromConfig,
  generateSigningKeyPair,
  loadPluginsDirectory,
  signManifest,
} from '../index.js'

test('creates manager from file-based config and loads plugin directory', async () => {
  const keyPair = generateSigningKeyPair('ed25519')
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-config-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')
  const trustedKeyDirectory = path.join(tempDirectory, 'trusted-keys')
  const trustBundlePath = path.join(tempDirectory, 'trust-bundle.json')
  const revocationListPath = path.join(tempDirectory, 'revocation-list.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.mkdir(trustedKeyDirectory, { recursive: true })

    const manifest = {
      id: 'demo.config-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      trust: {
        publisherId: 'publisher.demo',
        trustDomain: 'third-party' as const,
        issuedBy: 'third-party-issuer',
      },
      artifact: { kind: 'module' as const, entry: './index.js' },
      runtime: 'node' as const,
      capabilities: [{ name: 'demo.hello' }],
    }

    const signature = signManifest(manifest, {
      algorithm: 'ed25519',
      keyId: 'demo-key',
      privateKeyPem: keyPair.privateKeyPem,
    })

    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({ ...manifest, signature }, null, 2), 'utf8')
    await fs.writeFile(
      path.join(pluginDirectory, 'index.js'),
      "export default { capabilities: { 'demo.hello': async () => ({ message: 'hello from config plugin' }) } }\n",
      'utf8',
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
      signaturePolicy: 'require-signature',
      trustedKeyDirectory,
      trustBundlePath,
      revocationListPath,
      pluginsDirectory,
    })

    assert.equal(configured.loaded.length, 1)
    assert.equal(configured.loaded[0]?.security.status, 'authorized-safe')

    const result = await configured.manager.invoke('demo.config-plugin', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from config plugin' })

    await configured.manager.deactivate('demo.config-plugin')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('loads nested plugin directories recursively', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-plugin-scan-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const nestedPluginDirectory = path.join(pluginsDirectory, 'group-a', 'plugin-b')

  try {
    await fs.mkdir(nestedPluginDirectory, { recursive: true })
    await fs.writeFile(path.join(nestedPluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.recursive-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.hello' }],
    }, null, 2), 'utf8')
    await fs.writeFile(
      path.join(nestedPluginDirectory, 'index.js'),
      "export default { capabilities: { 'demo.hello': async () => ({ message: 'hello from recursive plugin' }) } }\n",
      'utf8',
    )

    const configured = await createExtensionManagerFromConfig({
      isDevelopment: true,
      registerProcessRuntime: false,
      registerNativeRuntime: false,
      registerWasmRuntime: false,
    })

    const loaded = await loadPluginsDirectory(configured.manager, pluginsDirectory, { recursive: true })
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]?.id, 'demo.recursive-plugin')
    assert.equal(loaded[0]?.security.status, 'unsigned')

    const result = await configured.manager.invoke('demo.recursive-plugin', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from recursive plugin' })

    await configured.manager.deactivate('demo.recursive-plugin')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

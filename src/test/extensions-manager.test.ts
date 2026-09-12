import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ExtensionManager,
  FileTrustedKeyStore,
  NodeRuntime,
  ProcessRuntime,
  PublicKeySignatureVerifier,
  TypeScriptSecurityCore,
  generateSigningKeyPair,
  signManifest,
  type ExtensionSecurityCore,
  type ExtensionSignatureEvaluator,
  type ExtensionTrustEvaluator,
} from '../index.js'
import { ensureSpawnAvailable } from './spawn-test-helpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '../../')
const nodeManifest = path.join(root, 'examples/node-extension')
const processManifest = path.join(root, 'examples/process-extension')

let manager: ExtensionManager

before(() => {
  manager = new ExtensionManager({ isDevelopment: true, workspacePath: root })
  manager.registerRuntime(new NodeRuntime())
  manager.registerRuntime(new ProcessRuntime())
})

after(async () => {
  await manager.deactivate('demo.process-extension')
  await manager.deactivate('demo.node-extension')
})

test('loads node extension from directory manifest', async () => {
  const extension = await manager.loadManifestFile(nodeManifest)

  assert.equal(extension.id, 'demo.node-extension')
  assert.equal(manager.get('demo.node-extension')?.id, 'demo.node-extension')
})

test('invokes node extension capability', async () => {
  const result = await manager.invoke('demo.node-extension', 'demo.hello', {})

  assert.deepEqual(result, { message: 'hello from node extension' })
})

test('loads process extension from directory manifest', async (t) => {
  await ensureSpawnAvailable(t)
  const extension = await manager.loadManifestFile(processManifest)

  assert.equal(extension.id, 'demo.process-extension')
})

test('invokes process extension capability', async (t) => {
  await ensureSpawnAvailable(t)
  const result = await manager.invoke('demo.process-extension', 'demo.hello', {})

  assert.deepEqual(result, { message: 'hello from process extension' })
})

test('loads a signed manifest with file-backed trusted keys under strict policy', async () => {
  const keyPair = generateSigningKeyPair('ed25519')
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-signed-'))

  try {
    const manifest = {
      id: 'demo.signed-node-extension',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: {
        kind: 'module' as const,
        entry: './index.js',
      },
      runtime: 'node' as const,
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

    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      ...manifest,
      signature,
    }, null, 2))
    await fs.copyFile(path.join(root, 'examples/node-extension/index.js'), path.join(tempDirectory, 'index.js'))
    await fs.mkdir(path.join(tempDirectory, 'keys'))
    await fs.writeFile(path.join(tempDirectory, 'keys/demo-key.pem'), keyPair.publicKeyPem, 'utf8')

    const signedManager = new ExtensionManager({ isDevelopment: true,
      workspacePath: root,
      signaturePolicy: 'require-signature',
      signatureVerifier: new PublicKeySignatureVerifier(
        new FileTrustedKeyStore(path.join(tempDirectory, 'keys')),
      ),
    })
    signedManager.registerRuntime(new NodeRuntime())

    const extension = await signedManager.loadManifestFile(tempDirectory)
    assert.equal(extension.id, 'demo.signed-node-extension')

    const result = await signedManager.invoke('demo.signed-node-extension', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from node extension' })

    await signedManager.deactivate('demo.signed-node-extension')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('rejects an unsigned manifest under strict policy', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-unsigned-'))

  try {
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.unsigned-node-extension',
      version: '1.0.0',
      protocolVersion: '1',
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
    }, null, 2))
    await fs.copyFile(path.join(root, 'examples/node-extension/index.js'), path.join(tempDirectory, 'index.js'))

    const strictManager = new ExtensionManager({ isDevelopment: true,
      workspacePath: root,
      signaturePolicy: 'require-signature',
    })
    strictManager.registerRuntime(new NodeRuntime())

    await assert.rejects(
      () => strictManager.loadManifestFile(tempDirectory),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Failed to load extension: demo\.unsigned-node-extension/)

        const cause = (error as Error & { cause?: unknown }).cause
        assert.ok(cause instanceof Error)
        assert.match(cause.message, /Extension signature required by policy: demo\.unsigned-node-extension/)
        return true
      },
    )
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('loads a signed manifest as authorized-safe only with authorized issuer', async () => {
  const keyPair = generateSigningKeyPair('ed25519')
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-authorized-safe-'))

  try {
    const manifest = {
      id: 'demo.authorized-safe-extension',
      version: '1.0.0',
      protocolVersion: '1',
      trust: {
        publisherId: 'publisher.demo',
        trustDomain: 'third-party' as const,
        issuedBy: 'third-party-issuer',
      },
      artifact: {
        kind: 'module' as const,
        entry: './index.js',
      },
      runtime: 'node' as const,
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

    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      ...manifest,
      signature,
    }, null, 2))
    await fs.copyFile(path.join(root, 'examples/node-extension/index.js'), path.join(tempDirectory, 'index.js'))
    await fs.mkdir(path.join(tempDirectory, 'keys'))
    await fs.writeFile(path.join(tempDirectory, 'keys/demo-key.pem'), keyPair.publicKeyPem, 'utf8')

    const trustManager = new ExtensionManager({ isDevelopment: true,
      workspacePath: root,
      signaturePolicy: 'require-signature',
      signatureVerifier: new PublicKeySignatureVerifier(
        new FileTrustedKeyStore(path.join(tempDirectory, 'keys')),
      ),
      trustBundle: {
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
      },
    })
    trustManager.registerRuntime(new NodeRuntime())

    const extension = await trustManager.loadManifestFile(tempDirectory)
    assert.equal(extension.security.status, 'authorized-safe')
    assert.match(extension.security.reason, /authorized issuer/)

    await trustManager.deactivate('demo.authorized-safe-extension')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('loads a signed manifest as third-party-untrusted without authorized issuer', async () => {
  const keyPair = generateSigningKeyPair('ed25519')
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-third-party-untrusted-'))

  try {
    const manifest = {
      id: 'demo.third-party-untrusted-extension',
      version: '1.0.0',
      protocolVersion: '1',
      trust: {
        publisherId: 'publisher.demo',
        trustDomain: 'third-party' as const,
        issuedBy: 'third-party-issuer',
      },
      artifact: {
        kind: 'module' as const,
        entry: './index.js',
      },
      runtime: 'node' as const,
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

    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      ...manifest,
      signature,
    }, null, 2))
    await fs.copyFile(path.join(root, 'examples/node-extension/index.js'), path.join(tempDirectory, 'index.js'))
    await fs.mkdir(path.join(tempDirectory, 'keys'))
    await fs.writeFile(path.join(tempDirectory, 'keys/demo-key.pem'), keyPair.publicKeyPem, 'utf8')

    const trustManager = new ExtensionManager({ isDevelopment: true,
      workspacePath: root,
      signaturePolicy: 'require-signature',
      signatureVerifier: new PublicKeySignatureVerifier(
        new FileTrustedKeyStore(path.join(tempDirectory, 'keys')),
      ),
      trustBundle: {
        version: '1',
        issuers: [
          {
            id: 'third-party-issuer',
            trustDomain: 'third-party',
            publicKeyPem: keyPair.publicKeyPem,
            authorization: 'untrusted',
            allowedPublisherIds: ['publisher.demo'],
          },
        ],
      },
    })
    trustManager.registerRuntime(new NodeRuntime())

    const extension = await trustManager.loadManifestFile(tempDirectory)
    assert.equal(extension.security.status, 'third-party-untrusted')
    assert.match(extension.security.reason, /not officially authorized/)

    await trustManager.deactivate('demo.third-party-untrusted-extension')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('rejects a signed manifest from a revoked publisher', async () => {
  const keyPair = generateSigningKeyPair('ed25519')
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-revoked-publisher-'))

  try {
    const manifest = {
      id: 'demo.revoked-publisher-extension',
      version: '1.0.0',
      protocolVersion: '1',
      trust: {
        publisherId: 'publisher.revoked',
        trustDomain: 'third-party' as const,
        issuedBy: 'third-party-issuer',
      },
      artifact: {
        kind: 'module' as const,
        entry: './index.js',
      },
      runtime: 'node' as const,
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

    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      ...manifest,
      signature,
    }, null, 2))
    await fs.copyFile(path.join(root, 'examples/node-extension/index.js'), path.join(tempDirectory, 'index.js'))
    await fs.mkdir(path.join(tempDirectory, 'keys'))
    await fs.writeFile(path.join(tempDirectory, 'keys/demo-key.pem'), keyPair.publicKeyPem, 'utf8')

    const trustManager = new ExtensionManager({ isDevelopment: true,
      workspacePath: root,
      signaturePolicy: 'require-signature',
      signatureVerifier: new PublicKeySignatureVerifier(
        new FileTrustedKeyStore(path.join(tempDirectory, 'keys')),
      ),
      trustBundle: {
        version: '1',
        issuers: [
          {
            id: 'third-party-issuer',
            trustDomain: 'third-party',
            publicKeyPem: keyPair.publicKeyPem,
            authorization: 'authorized',
          },
        ],
      },
      revocationList: {
        version: '1',
        revokedPublishers: [{ publisherId: 'publisher.revoked' }],
      },
    })
    trustManager.registerRuntime(new NodeRuntime())

    await assert.rejects(
      () => trustManager.loadManifestFile(tempDirectory),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Failed to load extension: demo\.revoked-publisher-extension/)

        const cause = (error as Error & { cause?: unknown }).cause
        assert.ok(cause instanceof Error)
        assert.match(cause.message, /Extension publisher revoked: publisher\.revoked/)
        return true
      },
    )
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('allows replacing the security core implementation', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-custom-security-core-'))

  try {
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.custom-security-core-extension',
      version: '1.0.0',
      protocolVersion: '1',
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
    }, null, 2))
    await fs.copyFile(path.join(root, 'examples/node-extension/index.js'), path.join(tempDirectory, 'index.js'))

    const visitedManifestIds: string[] = []
    const customSecurityCore: ExtensionSecurityCore = {
      async evaluateManifest(manifest) {
        visitedManifestIds.push(manifest.id)
        return {
          status: 'authorized-safe',
          reason: 'Custom security core approved manifest.',
        }
      },
    }

    const customManager = new ExtensionManager({ isDevelopment: true,
      workspacePath: root,
      signaturePolicy: 'require-signature',
      securityCore: customSecurityCore,
    })
    customManager.registerRuntime(new NodeRuntime())

    const extension = await customManager.loadManifestFile(tempDirectory)
    assert.deepEqual(visitedManifestIds, ['demo.custom-security-core-extension'])
    assert.equal(extension.security.status, 'authorized-safe')
    assert.equal(extension.security.reason, 'Custom security core approved manifest.')

    const result = await customManager.invoke('demo.custom-security-core-extension', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from node extension' })

    await customManager.deactivate('demo.custom-security-core-extension')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('allows replacing only the signature evaluator implementation', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-custom-signature-evaluator-'))

  try {
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.custom-signature-evaluator-extension',
      version: '1.0.0',
      protocolVersion: '1',
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
    }, null, 2))
    await fs.copyFile(path.join(root, 'examples/node-extension/index.js'), path.join(tempDirectory, 'index.js'))

    const visitedManifestIds: string[] = []
    const signatureEvaluator: ExtensionSignatureEvaluator = {
      evaluateManifest(manifest) {
        visitedManifestIds.push(manifest.id)
      },
    }

    const customManager = new ExtensionManager({ isDevelopment: true,
      workspacePath: root,
      securityCore: new TypeScriptSecurityCore({
        signatureEvaluator,
        trustEvaluator: {
          evaluateManifest() {
            return {
              status: 'authorized-safe',
              reason: 'Custom trust evaluator approved manifest.',
            }
          },
        },
      }),
    })
    customManager.registerRuntime(new NodeRuntime())

    const extension = await customManager.loadManifestFile(tempDirectory)
    assert.deepEqual(visitedManifestIds, ['demo.custom-signature-evaluator-extension'])
    assert.equal(extension.security.status, 'authorized-safe')
    assert.equal(extension.security.reason, 'Custom trust evaluator approved manifest.')

    const result = await customManager.invoke('demo.custom-signature-evaluator-extension', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from node extension' })

    await customManager.deactivate('demo.custom-signature-evaluator-extension')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('allows replacing only the trust evaluator implementation', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-custom-trust-evaluator-'))

  try {
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.custom-trust-evaluator-extension',
      version: '1.0.0',
      protocolVersion: '1',
      signature: {
        algorithm: 'ed25519',
        keyId: 'demo-key',
        value: 'placeholder-signature',
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
    }, null, 2))
    await fs.copyFile(path.join(root, 'examples/node-extension/index.js'), path.join(tempDirectory, 'index.js'))

    const visitedManifestIds: string[] = []
    const trustEvaluator: ExtensionTrustEvaluator = {
      evaluateManifest(manifest) {
        visitedManifestIds.push(manifest.id)
        return {
          status: 'authorized-safe',
          reason: 'Custom trust evaluator approved manifest.',
        }
      },
    }

    const customManager = new ExtensionManager({ isDevelopment: true,
      workspacePath: root,
      securityCore: new TypeScriptSecurityCore({
        signaturePolicy: 'require-signature',
        signatureVerifier: {
          async verify() {
          },
        },
        trustEvaluator,
      }),
    })
    customManager.registerRuntime(new NodeRuntime())

    const extension = await customManager.loadManifestFile(tempDirectory)
    assert.deepEqual(visitedManifestIds, ['demo.custom-trust-evaluator-extension'])
    assert.equal(extension.security.status, 'authorized-safe')
    assert.equal(extension.security.reason, 'Custom trust evaluator approved manifest.')

    const result = await customManager.invoke('demo.custom-trust-evaluator-extension', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from node extension' })

    await customManager.deactivate('demo.custom-trust-evaluator-extension')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

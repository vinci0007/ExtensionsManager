import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  ExtensionManager,
  NativeRuntime,
  ProcessRuntime,
  WasmRuntime,
  createConfiguredExtensionManager,
  createExtensionManagerFromHostConfig,
  generateSigningKeyPair,
  signManifest,
} from '../index.js'
import { ensureSpawnAvailable } from './spawn-test-helpers.js'

const addOneWasmBytes = Buffer.from([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
  0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x0a, 0x01, 0x06, 0x61, 0x64, 0x64, 0x4f, 0x6e, 0x65, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x41, 0x01, 0x6a, 0x0b,
])

test('loads and invokes wasm plugin capability', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-wasm-'))

  try {
    await fs.writeFile(path.join(tempDirectory, 'plugin.wasm'), addOneWasmBytes)
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.wasm-extension',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'wasm', entry: './plugin.wasm' },
      runtime: 'wasm',
      capabilities: [{ name: 'demo.addOne', binding: 'addOne' }],
    }, null, 2), 'utf8')

    const manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new WasmRuntime())

    await manager.loadManifestFile(tempDirectory)
    const result = await manager.invoke('demo.wasm-extension', 'demo.addOne', { value: 41 })
    assert.equal(result, 42)
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('loads native plugin through bridge process', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-native-'))
  const bridgePath = path.join(tempDirectory, 'bridge.mjs')
  const libraryPath = path.join(tempDirectory, 'plugin.dll')

  try {
    await fs.writeFile(libraryPath, 'placeholder native library', 'utf8')
    await fs.writeFile(bridgePath, `
import fs from 'node:fs'
const libraryPath = process.argv[2]
if (!libraryPath || !fs.existsSync(libraryPath)) {
  throw new Error('native library path missing')
}
for await (const chunk of process.stdin) {
  const lines = chunk.toString('utf8').trim().split(/\\r?\\n/).filter(Boolean)
  for (const line of lines) {
    const request = JSON.parse(line)
    if (request.method === 'extension/activate') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }) + '\\n')
      continue
    }
    if (request.method === 'extension/deactivate') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }) + '\\n')
      process.exit(0)
    }
    if (request.method === 'extension/invoke') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { message: 'hello from native bridge' } }) + '\\n')
    }
  }
}
`, 'utf8')
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.native-extension',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: {
        kind: 'shared-library',
        entry: './plugin.dll',
        launch: {
          command: process.execPath,
          args: ['./bridge.mjs'],
        },
      },
      runtime: 'native',
      capabilities: [{ name: 'demo.hello' }],
    }, null, 2), 'utf8')

    const manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new NativeRuntime())
    manager.registerRuntime(new ProcessRuntime())

    await manager.loadManifestFile(tempDirectory)
    const result = await manager.invoke('demo.native-extension', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from native bridge' })

    await manager.deactivate('demo.native-extension')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('process runtime activate receives unified initialization context and supports status checks plus reinitialize', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-process-init-'))
  const pluginPath = path.join(tempDirectory, 'plugin.mjs')
  const storagePath = path.join(tempDirectory, 'storage')
  let manager: ExtensionManager | undefined
  const statusServer = http.createServer((request, response) => {
    if (request.url === '/healthz') {
      response.statusCode = 204
      response.end()
      return
    }

    response.statusCode = 404
    response.end()
  })

  await new Promise<void>((resolve) => statusServer.listen(0, '127.0.0.1', () => resolve()))
  const address = statusServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind process init status server')
  }
  const statusEndpoint = `http://127.0.0.1:${address.port}/healthz`

  try {
    await fs.mkdir(storagePath, { recursive: true })
    await fs.writeFile(pluginPath, `
import readline from 'node:readline'

let activation = undefined
let activateCount = 0
const rl = readline.createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  const request = JSON.parse(line)

  if (request.method === 'extension/activate') {
    activation = request.params
    activateCount += 1
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }) + '\\n')
    return
  }

  if (request.method === 'extension/deactivate') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }) + '\\n')
    process.exit(0)
    return
  }

  if (request.method === 'extension/invoke') {
    if (request.params?.capability === 'demo.context') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          activation,
          activateCount,
          pid: process.pid,
        },
      }) + '\\n')
      return
    }

    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: 'unknown capability' },
    }) + '\\n')
  }
})
`, 'utf8')
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.process-init-extension',
      name: 'Process Init Extension',
      description: 'process init runtime test',
      version: '1.2.3',
      protocolVersion: '1',
      trust: {
        publisherId: 'publisher.demo',
        trustDomain: 'third-party',
        issuedBy: 'issuer.demo',
      },
      metadata: {
        publisher: {
          id: 'publisher.demo',
          name: 'Publisher Demo',
          url: 'https://publisher.example/demo',
        },
        author: {
          id: 'author.demo',
          name: 'Author Demo',
          url: 'https://author.example/demo',
        },
        publishedAt: '2026-05-09T00:00:00.000Z',
        updatedAt: '2026-05-09T01:00:00.000Z',
        statusCheck: {
          kind: 'url',
          endpoint: statusEndpoint,
          method: 'GET',
          expectedStatus: 204,
          timeoutMs: 2000,
        },
        supportsManualReinitialize: true,
        authorSignature: {
          algorithm: 'ed25519',
          keyId: 'author-key',
          value: 'YXV0aG9yLXNpZ25hdHVyZQ==',
          signedAt: '2026-05-09T00:00:00.000Z',
        },
        publisherSignature: {
          algorithm: 'ed25519',
          keyId: 'publisher-key',
          value: 'cHVibGlzaGVyLXNpZ25hdHVyZQ==',
          signedAt: '2026-05-09T00:30:00.000Z',
        },
      },
      artifact: {
        kind: 'binary',
        entry: './plugin.mjs',
        launch: {
          command: process.execPath,
          args: ['./plugin.mjs'],
        },
      },
      runtime: 'process',
      capabilities: [{ name: 'demo.context' }],
      permissions: {
        filesystem: {
          access: 'read',
          allow: ['./data'],
        },
      },
    }, null, 2), 'utf8')

    manager = new ExtensionManager({
      isDevelopment: true,
      workspacePath: tempDirectory,
      storagePath,
    })
    manager.registerRuntime(new ProcessRuntime())

    await manager.loadManifestFile(tempDirectory)
    const status = await manager.checkStatus('demo.process-init-extension')
    assert.equal(status.state, 'available')

    const info = manager.getInitializationInfo('demo.process-init-extension')
    assert.equal(info.status.state, 'available')
    assert.equal(info.supportsManualReinitialize, true)
    assert.equal(info.description, 'process init runtime test')

    const first = await manager.invoke<unknown, { activation: Record<string, unknown>; activateCount: number; pid: number }>(
      'demo.process-init-extension',
      'demo.context',
      {},
    )
    assert.equal(first.activateCount, 1)
    assert.equal(typeof first.pid, 'number')
    assert.equal(first.activation.extensionId, 'demo.process-init-extension')
    assert.equal(first.activation.workspacePath, tempDirectory)
    assert.equal(first.activation.storagePath, storagePath)

    const initialization = first.activation.initialization as Record<string, unknown>
    assert.equal(initialization.extensionId, 'demo.process-init-extension')
    assert.equal(initialization.extensionType, 'process')
    assert.equal(initialization.artifactKind, 'binary')
    assert.equal(initialization.description, 'process init runtime test')
    assert.equal(initialization.version, '1.2.3')
    assert.equal(initialization.protocolVersion, '1')
    assert.equal(initialization.supportsManualReinitialize, true)
    assert.equal(initialization.isActive, false)
    assert.deepEqual(initialization.capabilities, ['demo.context'])
    assert.deepEqual(initialization.permissions, {
      filesystem: {
        access: 'read',
        allow: ['./data'],
      },
    })
    assert.deepEqual(initialization.publisher, {
      id: 'publisher.demo',
      name: 'Publisher Demo',
      url: 'https://publisher.example/demo',
    })
    assert.deepEqual(initialization.author, {
      id: 'author.demo',
      name: 'Author Demo',
      url: 'https://author.example/demo',
    })
    assert.equal(initialization.publishedAt, '2026-05-09T00:00:00.000Z')
    assert.equal(initialization.updatedAt, '2026-05-09T01:00:00.000Z')
    assert.deepEqual(initialization.statusCheck, {
      kind: 'url',
      endpoint: statusEndpoint,
      method: 'GET',
      expectedStatus: 204,
      timeoutMs: 2000,
    })
    assert.deepEqual(initialization.authorSignature, {
      algorithm: 'ed25519',
      keyId: 'author-key',
      value: 'YXV0aG9yLXNpZ25hdHVyZQ==',
      signedAt: '2026-05-09T00:00:00.000Z',
    })
    assert.deepEqual(initialization.publisherSignature, {
      algorithm: 'ed25519',
      keyId: 'publisher-key',
      value: 'cHVibGlzaGVyLXNpZ25hdHVyZQ==',
      signedAt: '2026-05-09T00:30:00.000Z',
    })
    assert.deepEqual(initialization.trust, {
      publisherId: 'publisher.demo',
      trustDomain: 'third-party',
      issuedBy: 'issuer.demo',
    })
    assert.deepEqual(initialization.security, {
      status: 'unsigned',
      reason: 'Extension has no manifest signature.',
    })
    assert.equal((initialization.status as { state: string }).state, 'available')

    await manager.reinitialize('demo.process-init-extension')
    const second = await manager.invoke<unknown, { activateCount: number; pid: number }>(
      'demo.process-init-extension',
      'demo.context',
      {},
    )
    assert.equal(second.activateCount, 1)
    assert.equal(typeof second.pid, 'number')
    assert.notEqual(second.pid, first.pid)

    await manager.deactivate('demo.process-init-extension')
    await manager.dispose()
  } finally {
    await manager?.dispose().catch(() => {})
    await new Promise<void>((resolve) => statusServer.close(() => resolve()))
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('process runtime supports real session events over stdio transport', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-process-session-'))
  const pluginPath = path.join(tempDirectory, 'plugin.mjs')

  try {
    await fs.writeFile(pluginPath, `
import readline from 'node:readline'

const sessions = new Map()
let nextSessionId = 1
const rl = readline.createInterface({ input: process.stdin, terminal: false })

function writeResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

function writeEvent(sessionId, event) {
  process.stdout.write(JSON.stringify({ kind: 'event', sessionId, event }) + '\\n')
}

rl.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'extension/activate') {
    writeResponse(request.id, true)
    return
  }
  if (request.method === 'extension/deactivate') {
    writeResponse(request.id, true)
    process.exit(0)
    return
  }
  if (request.method === 'extension/invoke') {
    writeResponse(request.id, { mode: 'compatibility' })
    return
  }
  if (request.method === 'extension/openSession') {
    const sessionId = 'process-session-' + String(nextSessionId++)
    sessions.set(sessionId, true)
    writeEvent(sessionId, { type: 'event', name: 'ready', payload: { source: 'process' } })
    writeResponse(request.id, { sessionId })
    return
  }
  if (request.method === 'extension/session.send') {
    if (request.params?.data?.fail) {
      writeEvent(request.params.sessionId, { type: 'error', message: 'boom-process' })
      writeResponse(request.id, true)
      return
    }
    writeEvent(request.params.sessionId, { type: 'data', data: { echo: request.params?.data?.text ?? null } })
    writeResponse(request.id, true)
    return
  }
  if (request.method === 'extension/session.cancel') {
    writeEvent(request.params.sessionId, { type: 'end' })
    writeResponse(request.id, true)
    return
  }
  if (request.method === 'extension/session.close') {
    sessions.delete(request.params.sessionId)
    writeResponse(request.id, true)
    return
  }
})
`, 'utf8')
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.process-session-extension',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: {
        kind: 'binary',
        entry: './plugin.mjs',
        launch: {
          command: process.execPath,
          args: ['./plugin.mjs'],
        },
      },
      runtime: 'process',
      capabilities: [{
        name: 'demo.chat',
        interactionMode: 'duplex',
        executionMode: 'session',
        realtimeClass: 'interactive',
        concurrencyPolicy: 'single',
      }],
    }, null, 2), 'utf8')

    const manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new ProcessRuntime())
    await manager.loadManifestFile(tempDirectory)

    const session = await manager.openSession('demo.process-session-extension', 'demo.chat', {})
    assert.deepEqual(await session.nextEvent(), {
      type: 'event',
      name: 'ready',
      payload: { source: 'process' },
    })
    await session.send({ text: 'ping' })
    assert.deepEqual(await session.nextEvent(), {
      type: 'data',
      data: { echo: 'ping' },
    })
    await session.send({ fail: true })
    assert.deepEqual(await session.nextEvent(), {
      type: 'error',
      message: 'boom-process',
    })
    await session.cancel()
    assert.deepEqual(await session.nextEvent(), { type: 'end' })
    await session.close()
    await manager.dispose()
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('process runtime rejects compatibility fallback for duplex capability', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-process-session-contract-'))
  const pluginPath = path.join(tempDirectory, 'plugin.mjs')
  let manager: ExtensionManager | undefined

  try {
    await fs.writeFile(pluginPath, `
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'extension/activate') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }) + '\\n')
    return
  }
  if (request.method === 'extension/deactivate') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }) + '\\n')
    process.exit(0)
    return
  }
  if (request.method === 'extension/invoke') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { mode: 'compatibility-only' } }) + '\\n')
    return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported method' } }) + '\\n')
})
`, 'utf8')
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.process-session-contract-extension',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: {
        kind: 'binary',
        entry: './plugin.mjs',
        launch: {
          command: process.execPath,
          args: ['./plugin.mjs'],
        },
      },
      runtime: 'process',
      capabilities: [{
        name: 'demo.chat',
        interactionMode: 'duplex',
        executionMode: 'session',
        realtimeClass: 'interactive',
        concurrencyPolicy: 'single',
      }],
    }, null, 2), 'utf8')

    manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new ProcessRuntime())
    await manager!.loadManifestFile(tempDirectory)

    await assert.rejects(
      () => manager!.openSession('demo.process-session-contract-extension', 'demo.chat', {}),
      /real session implementation/i,
    )
  } finally {
    await manager?.dispose().catch(() => {})
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('creates configured manager from host config and auto-loads plugins', async () => {
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
      id: 'demo.auto-loaded-host-config-plugin',
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
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.hello': async () => ({ message: 'hello from host config plugin' }) } }\n", 'utf8')
    await fs.writeFile(path.join(trustedKeyDirectory, 'demo-key.pem'), keyPair.publicKeyPem, 'utf8')
    await fs.writeFile(trustBundlePath, JSON.stringify({
      version: '1',
      issuers: [{
        id: 'third-party-issuer',
        trustDomain: 'third-party',
        publicKeyPem: keyPair.publicKeyPem,
        authorization: 'authorized',
        allowedPublisherIds: ['publisher.demo'],
      }],
    }, null, 2), 'utf8')
    await fs.writeFile(revocationListPath, JSON.stringify({ version: '1' }, null, 2), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      signaturePolicy: 'require-signature',
      trustedKeyDirectory: './trusted-keys',
      trustBundlePath: './trust-bundle.json',
      revocationListPath: './revocation-list.json',
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    assert.equal(configured.loaded.length, 1)
    assert.equal(configured.loaded[0]?.security.status, 'authorized-safe')

    const result = await configured.manager.invoke('demo.auto-loaded-host-config-plugin', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from host config plugin' })

    await configured.manager.deactivate('demo.auto-loaded-host-config-plugin')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('creates configured manager from host config with kernel daemon bridge', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-host-command-security-core-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.host-command-security-core-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.hello' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.hello': async () => ({ message: 'hello from host command security core plugin' }) } }\n", 'utf8')
    await fs.writeFile(kernelDaemonPath, `
function write(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      const request = JSON.parse(line)
      if (request.method === 'kernel.load') {
        if (request.params.security.signaturePolicy !== 'require-signature') {
          throw new Error('signaturePolicy not forwarded')
        }
        write({
          kind: 'response',
          id: request.id,
          result: {
            extensionId: request.params.manifest.id,
            security: {
              status: 'authorized-safe',
              reason: 'Approved by host-config kernel daemon.',
            },
          },
        })
      } else if (request.method === 'kernel.activate' || request.method === 'kernel.deactivate') {
        write({ kind: 'response', id: request.id, result: true })
      } else if (request.method === 'kernel.invoke') {
        write({
          kind: 'response',
          id: request.id,
          result: { message: 'hello from host command security core plugin' },
        })
      } else {
        write({
          kind: 'response',
          id: request.id,
          error: { code: 'KERNEL_ERROR', message: 'unsupported request' },
        })
      }
    }
    index = buffer.indexOf('\\n')
  }
})
`, 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      signaturePolicy: 'require-signature',
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: process.execPath,
        args: ['./kernel-daemon.mjs'],
        cwd: '.',
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    assert.equal(configured.loaded.length, 1)
    assert.equal(configured.loaded[0]?.security.status, 'authorized-safe')
    assert.equal(configured.loaded[0]?.security.reason, 'Approved by host-config kernel daemon.')

    const result = await configured.manager.invoke('demo.host-command-security-core-plugin', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from host command security core plugin' })

    await configured.manager.deactivate('demo.host-command-security-core-plugin')
    await configured.manager.dispose()
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('createConfiguredExtensionManager auto-loads pluginsDirectory directly', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-configured-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.configured-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.hello' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.hello': async () => ({ message: 'hello from configured manager' }) } }\n", 'utf8')

    const configured = await createConfiguredExtensionManager({
      isDevelopment: true,
      pluginsDirectory,
      pluginsRecursive: true,
      registerNativeRuntime: false,
      registerWasmRuntime: false,
    })

    assert.equal(configured.loaded.length, 1)
    const result = await configured.manager.invoke('demo.configured-plugin', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from configured manager' })

    await configured.manager.deactivate('demo.configured-plugin')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

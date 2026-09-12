import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ExtensionManager,
  NodeRuntime,
  createExtensionManagerFromHostConfig,
} from '../index.js'
import { ensureSpawnAvailable } from './spawn-test-helpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '../../')

test('openSession returns unary compatibility events through the local kernel bridge', async () => {
  const manager = new ExtensionManager({ isDevelopment: true })
  manager.registerRuntime(new NodeRuntime())

  await manager.loadManifestFile(path.join(root, 'examples/node-extension'))
  const session = await manager.openSession('demo.node-extension', 'demo.hello', {})

  const first = await session.nextEvent()
  const second = await session.nextEvent()

  assert.deepEqual(first, {
    type: 'data',
    data: { message: 'hello from node extension' },
  })
  assert.deepEqual(second, { type: 'end' })

  await session.close()
  await manager.deactivate('demo.node-extension')
  await manager.dispose()
})

test('local unary compatibility session rejects operations after close', async () => {
  const manager = new ExtensionManager({ isDevelopment: true })
  manager.registerRuntime(new NodeRuntime())

  try {
    await manager.loadManifestFile(path.join(root, 'examples/node-extension'))
    const session = await manager.openSession('demo.node-extension', 'demo.hello', {})
    await session.close()

    await assert.rejects(
      () => session.nextEvent(),
      /session is closed/i,
    )
    await assert.rejects(
      () => session.send({ text: 'ping' }),
      /session is closed/i,
    )
  } finally {
    await manager.dispose()
  }
})

test('local kernel bridge supports real node runtime session events', async () => {
  const manager = new ExtensionManager({ isDevelopment: true })
  manager.registerRuntime(new NodeRuntime())

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-local-session-'))
  const pluginDirectory = path.join(tempDirectory, 'plugin-a')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.local-session-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{
        name: 'demo.chat',
        interactionMode: 'duplex',
        executionMode: 'session',
        realtimeClass: 'interactive',
        concurrencyPolicy: 'single',
      }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), `
function createQueue() {
  const events = [{ type: 'event', name: 'ready', payload: { source: 'local' } }]
  let closed = false
  return {
    nextEvent() {
      return events.shift() ?? null
    },
    async send(data) {
      if (closed) {
        events.push({ type: 'error', message: 'session already closed' })
        return
      }
      if (data && data.fail) {
        events.push({ type: 'error', message: 'boom-local' })
        return
      }
      events.push({ type: 'data', data: { echo: data?.text ?? null } })
    },
    async cancel() {
      closed = true
      events.push({ type: 'end' })
    },
    async close() {
      closed = true
    },
  }
}
export default {
  capabilities: {
    'demo.chat': async () => ({ mode: 'compatibility' }),
  },
  openSession(capability) {
    if (capability !== 'demo.chat') {
      throw new Error('unknown capability')
    }
    return createQueue()
  },
}
`, 'utf8')

    await manager.loadManifestFile(pluginDirectory)
    const session = await manager.openSession('demo.local-session-plugin', 'demo.chat', {})
    assert.deepEqual(await session.nextEvent(), {
      type: 'event',
      name: 'ready',
      payload: { source: 'local' },
    })

    await session.send({ text: 'ping' })
    assert.deepEqual(await session.nextEvent(), {
      type: 'data',
      data: { echo: 'ping' },
    })

    await session.send({ fail: true })
    assert.deepEqual(await session.nextEvent(), {
      type: 'error',
      message: 'boom-local',
    })
    await session.cancel()
    assert.deepEqual(await session.nextEvent(), { type: 'end' })
    await session.close()
  } finally {
    await manager.dispose()
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('local kernel bridge rejects compatibility fallback for duplex capability', async () => {
  const manager = new ExtensionManager({ isDevelopment: true })
  manager.registerRuntime(new NodeRuntime())

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-local-session-contract-'))
  const pluginDirectory = path.join(tempDirectory, 'plugin-a')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.local-session-contract-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{
        name: 'demo.chat',
        interactionMode: 'duplex',
        executionMode: 'session',
        realtimeClass: 'interactive',
        concurrencyPolicy: 'single',
      }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), `
export default {
  capabilities: {
    'demo.chat': async () => ({ mode: 'compatibility-only' }),
  },
}
`, 'utf8')

    await manager.loadManifestFile(pluginDirectory)
    await assert.rejects(
      () => manager.openSession('demo.local-session-contract-plugin', 'demo.chat', {}),
      /real session implementation/i,
    )
  } finally {
    await manager.dispose()
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('local real session rejects operations after close', async () => {
  const manager = new ExtensionManager({ isDevelopment: true })
  manager.registerRuntime(new NodeRuntime())

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-local-session-close-'))
  const pluginDirectory = path.join(tempDirectory, 'plugin-a')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.local-session-close-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{
        name: 'demo.chat',
        interactionMode: 'duplex',
        executionMode: 'session',
        realtimeClass: 'interactive',
        concurrencyPolicy: 'single',
      }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), `
function createQueue() {
  const events = [{ type: 'event', name: 'ready', payload: { source: 'local' } }]
  return {
    nextEvent() {
      return events.shift() ?? null
    },
    async send(data) {
      events.push({ type: 'data', data: { echo: data?.text ?? null } })
    },
    async cancel() {
      events.push({ type: 'end' })
    },
    async close() {},
  }
}
export default {
  capabilities: {
    'demo.chat': async () => ({ mode: 'compatibility' }),
  },
  openSession() {
    return createQueue()
  },
}
`, 'utf8')

    await manager.loadManifestFile(pluginDirectory)
    const session = await manager.openSession('demo.local-session-close-plugin', 'demo.chat', {})
    await session.close()

    await assert.rejects(
      () => session.nextEvent(),
      /session is closed/i,
    )
    await assert.rejects(
      () => session.send({ text: 'ping' }),
      /session is closed/i,
    )
  } finally {
    await manager.dispose()
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('host config kernel block uses the command kernel bridge and normalizes legacy node runtime', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-kernel-config-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.kernel-host-config-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.hello' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.hello': async () => ({ message: 'hello from node extension' }) } }\n", 'utf8')
    await fs.writeFile(kernelDaemonPath, createKernelDaemonStubScript('demo.kernel-host-config-plugin'), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
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

    const result = await configured.manager.invoke('demo.kernel-host-config-plugin', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from kernel daemon' })

    const session = await configured.manager.openSession('demo.kernel-host-config-plugin', 'demo.hello', {})
    assert.deepEqual(await session.nextEvent(), {
      type: 'data',
      data: { message: 'hello from kernel daemon session' },
    })
    assert.deepEqual(await session.nextEvent(), { type: 'end' })

    await configured.manager.deactivate('demo.kernel-host-config-plugin')
    await configured.manager.dispose()
  } finally {
    await removeDirectoryWithRetry(tempDirectory)
  }
})

test('command kernel bridge rejects malformed daemon stdout as a transport error', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-kernel-bad-stdout-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.kernel-bad-stdout-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.hello' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.hello': async () => ({ message: 'unused' }) } }\n", 'utf8')
    await fs.writeFile(kernelDaemonPath, createMalformedKernelDaemonStubScript(), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: process.execPath,
        args: ['./kernel-daemon.mjs'],
        cwd: '.',
        timeoutMs: 1000,
      },
    }, null, 2), 'utf8')

    await assert.rejects(
      () => createExtensionManagerFromHostConfig(hostConfigPath),
      (error) => {
        assert.ok(error instanceof Error)
        const cause = (error as Error & { cause?: unknown }).cause
        assert.ok(cause instanceof Error)
        assert.match(cause.message, /invalid kernel envelope/i)
        return true
      },
    )
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await removeDirectoryWithRetry(tempDirectory)
  }
})

test('legacy commandSecurityCore config is normalized into kernel bridge configuration', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-command-kernel-compat-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.command-kernel-compat-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.hello' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.hello': async () => ({ message: 'hello from node extension' }) } }\n", 'utf8')
    await fs.writeFile(kernelDaemonPath, createKernelDaemonStubScript('demo.command-kernel-compat-plugin'), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      commandSecurityCore: {
        command: process.execPath,
        args: ['./kernel-daemon.mjs'],
        cwd: '.',
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    const result = await configured.manager.invoke('demo.command-kernel-compat-plugin', 'demo.hello', {})

    assert.deepEqual(result, { message: 'hello from kernel daemon' })
    await configured.manager.deactivate('demo.command-kernel-compat-plugin')
    await configured.manager.dispose()
  } finally {
    await removeDirectoryWithRetry(tempDirectory)
  }
})

test('host config remote runtime is normalized and forwarded to kernel bridge', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-remote-kernel-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.remote-kernel-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: {
        kind: 'binary',
        entry: './remote-bridge.mjs',
        launch: {
          command: process.execPath,
          args: ['./remote-bridge.mjs'],
          endpoint: 'http://localhost:47111/extensions/demo.remote-kernel-plugin',
          transport: 'process',
        },
      },
      runtime: 'remote',
      capabilities: [{ name: 'demo.hello' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'remote-bridge.mjs'), "export default {}\n", 'utf8')
    await fs.writeFile(kernelDaemonPath, createRemoteKernelDaemonStubScript('demo.remote-kernel-plugin'), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: process.execPath,
        args: ['./kernel-daemon.mjs'],
        cwd: '.',
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    const result = await configured.manager.invoke('demo.remote-kernel-plugin', 'demo.hello', {})

    assert.deepEqual(result, { message: 'hello from remote kernel daemon' })
    await configured.manager.dispose()
  } finally {
    await removeDirectoryWithRetry(tempDirectory)
  }
})

test('command kernel bridge forwards unified initialization context during activate', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-kernel-init-context-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.kernel-init-context-plugin',
      name: 'Kernel Init Context Plugin',
      description: 'kernel bridge init metadata test',
      version: '1.0.0',
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
        },
        author: {
          id: 'author.demo',
          name: 'Author Demo',
        },
        publishedAt: '2026-05-09T00:00:00.000Z',
        updatedAt: '2026-05-09T00:05:00.000Z',
        supportsManualReinitialize: true,
        authorSignature: {
          algorithm: 'ed25519',
          keyId: 'author-key',
          value: 'YXV0aG9yLXNpZ25hdHVyZQ==',
        },
        publisherSignature: {
          algorithm: 'ed25519',
          keyId: 'publisher-key',
          value: 'cHVibGlzaGVyLXNpZ25hdHVyZQ==',
        },
      },
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.hello' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.hello': async () => ({ message: 'unused local implementation' }) } }\n", 'utf8')
    await fs.writeFile(kernelDaemonPath, createKernelInitContextStubScript('demo.kernel-init-context-plugin'), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: process.execPath,
        args: ['./kernel-daemon.mjs'],
        cwd: '.',
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    const result = await configured.manager.invoke('demo.kernel-init-context-plugin', 'demo.hello', {})

    assert.deepEqual(result, { message: 'hello from kernel init context bridge' })
    const info = configured.manager.getInitializationInfo('demo.kernel-init-context-plugin')
    assert.equal(info.description, 'kernel bridge init metadata test')
    assert.equal(info.supportsManualReinitialize, true)

    await configured.manager.deactivate('demo.kernel-init-context-plugin')
    await configured.manager.dispose()
  } finally {
    await removeDirectoryWithRetry(tempDirectory)
  }
})

function createKernelDaemonStubScript(expectedExtensionId: string): string {
  return `
const sessions = new Map()
const buffers = []

function writeEnvelope(envelope) {
  process.stdout.write(JSON.stringify(envelope) + '\\n')
}

function writeSuccess(id, result) {
  writeEnvelope({ kind: 'response', id, result })
}

function writeError(id, message) {
  writeEnvelope({ kind: 'response', id, error: { code: 'KERNEL_ERROR', message } })
}

function writeSessionEvent(sessionId, event) {
  writeEnvelope({ kind: 'event', sessionId, event })
}

function handleRequest(request) {
  if (request.method === 'kernel.load') {
    if (request.params.manifest.id !== ${JSON.stringify(expectedExtensionId)}) {
      throw new Error('unexpected manifest id')
    }
    if (request.params.runtime.kind !== 'process') {
      throw new Error('legacy node runtime was not normalized to process')
    }
    if (request.params.runtime.command !== process.execPath) {
      throw new Error('legacy node runtime did not use the official node launcher')
    }
    if (!Array.isArray(request.params.runtime.args) || request.params.runtime.args.length < 2) {
      throw new Error('legacy node runtime args missing launcher or entry path')
    }
    writeSuccess(request.id, {
      extensionId: request.params.manifest.id,
      security: {
        status: 'authorized-safe',
        reason: 'Approved by kernel daemon stub.',
      },
    })
    return
  }

  if (request.method === 'kernel.activate' || request.method === 'kernel.deactivate' || request.method === 'kernel.session.close' || request.method === 'kernel.cancel') {
    writeSuccess(request.id, true)
    return
  }

  if (request.method === 'kernel.invoke') {
    writeSuccess(request.id, { message: 'hello from kernel daemon' })
    return
  }

  if (request.method === 'kernel.openSession') {
    const sessionId = 'session-' + String(sessions.size + 1)
    sessions.set(sessionId, true)
    writeSuccess(request.id, { sessionId })
    writeSessionEvent(sessionId, { type: 'data', data: { message: 'hello from kernel daemon session' } })
    writeSessionEvent(sessionId, { type: 'end' })
    return
  }

  if (request.method === 'kernel.session.send') {
    writeError(request.id, 'stub session send unsupported')
    return
  }

  writeError(request.id, 'unknown request')
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
      try {
        handleRequest(request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeError(request.id ?? 'unknown', message)
      }
    }
    index = buffer.indexOf('\\n')
  }
})
`
}

function createKernelInitContextStubScript(expectedExtensionId: string): string {
  return `
function writeEnvelope(envelope) {
  process.stdout.write(JSON.stringify(envelope) + '\\n')
}

function writeSuccess(id, result) {
  writeEnvelope({ kind: 'response', id, result })
}

function writeError(id, message) {
  writeEnvelope({ kind: 'response', id, error: { code: 'KERNEL_ERROR', message } })
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + ': ' + String(actual))
  }
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
      try {
        if (request.method === 'kernel.load') {
          assertEqual(request.params.manifest.id, ${JSON.stringify(expectedExtensionId)}, 'unexpected manifest id')
          writeSuccess(request.id, {
            extensionId: request.params.manifest.id,
            security: {
              status: 'authorized-safe',
              reason: 'Approved by kernel init context stub.',
            },
          })
        } else if (request.method === 'kernel.activate') {
          const context = request.params.context
          const initialization = context.initialization
          assertEqual(request.params.extensionId, ${JSON.stringify(expectedExtensionId)}, 'unexpected activate extension id')
          assertEqual(initialization.extensionId, ${JSON.stringify(expectedExtensionId)}, 'missing initialization extension id')
          assertEqual(initialization.extensionType, 'node', 'unexpected initialization extension type')
          assertEqual(initialization.description, 'kernel bridge init metadata test', 'missing description')
          assertEqual(initialization.publisher.id, 'publisher.demo', 'missing publisher id')
          assertEqual(initialization.author.id, 'author.demo', 'missing author id')
          assertEqual(initialization.authorSignature.keyId, 'author-key', 'missing author signature')
          assertEqual(initialization.publisherSignature.keyId, 'publisher-key', 'missing publisher signature')
          assertEqual(initialization.supportsManualReinitialize, true, 'missing reinitialize support')
          assertEqual(initialization.security.status, 'authorized-safe', 'security status not forwarded')
          if (!initialization.status || !initialization.status.state) {
            throw new Error('initialization status missing')
          }
          writeSuccess(request.id, true)
        } else if (request.method === 'kernel.deactivate') {
          writeSuccess(request.id, true)
        } else if (request.method === 'kernel.invoke') {
          writeSuccess(request.id, { message: 'hello from kernel init context bridge' })
        } else {
          writeError(request.id, 'unsupported request')
        }
      } catch (error) {
        writeError(request.id ?? 'unknown', error instanceof Error ? error.message : String(error))
      }
    }
    index = buffer.indexOf('\\n')
  }
})
`
}

function createRemoteKernelDaemonStubScript(expectedExtensionId: string): string {
  return `
function writeEnvelope(envelope) {
  process.stdout.write(JSON.stringify(envelope) + '\\n')
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
        if (request.params.manifest.id !== ${JSON.stringify(expectedExtensionId)}) {
          throw new Error('unexpected manifest id')
        }
        if (request.params.runtime.kind !== 'remote') {
          throw new Error('remote runtime was not normalized to remote')
        }
        if (request.params.runtime.endpoint !== 'http://localhost:47111/extensions/demo.remote-kernel-plugin') {
          throw new Error('remote runtime endpoint not forwarded')
        }
        if (request.params.runtime.transport !== 'process') {
          throw new Error('remote runtime transport not forwarded')
        }
        writeEnvelope({
          kind: 'response',
          id: request.id,
          result: {
            extensionId: request.params.manifest.id,
            security: {
              status: 'authorized-safe',
              reason: 'Approved by remote kernel daemon.',
            },
          },
        })
      } else if (request.method === 'kernel.activate' || request.method === 'kernel.deactivate') {
        writeEnvelope({ kind: 'response', id: request.id, result: true })
      } else if (request.method === 'kernel.invoke') {
        writeEnvelope({
          kind: 'response',
          id: request.id,
          result: { message: 'hello from remote kernel daemon' },
        })
      } else {
        writeEnvelope({
          kind: 'response',
          id: request.id,
          error: { code: 'KERNEL_ERROR', message: 'unsupported request' },
        })
      }
    }
    index = buffer.indexOf('\\n')
  }
})
`
}

test('command kernel bridge awaits the real result after an async accepted marker', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-kernel-async-'))
  const pluginDirectory = path.join(tempDirectory, 'plugins', 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.kernel-async-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.work' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.work': async () => ({}) } }\n", 'utf8')
    await fs.writeFile(kernelDaemonPath, createAsyncKernelDaemonStubScript('accepted-then-result'), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: process.execPath,
        args: ['./kernel-daemon.mjs'],
        cwd: '.',
        timeoutMs: 5000,
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    try {
      const result = await configured.manager.invoke('demo.kernel-async-plugin', 'demo.work', {})
      assert.deepEqual(result, { message: 'hello from async plugin' })
    } finally {
      await configured.manager.dispose()
    }
  } finally {
    await removeDirectoryWithRetry(tempDirectory)
  }
})

test('command kernel bridge rejects an async invoke when the worker reports failure', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-kernel-async-err-'))
  const pluginDirectory = path.join(tempDirectory, 'plugins', 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.kernel-async-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.work' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.work': async () => ({}) } }\n", 'utf8')
    await fs.writeFile(kernelDaemonPath, createAsyncKernelDaemonStubScript('accepted-then-error'), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: process.execPath,
        args: ['./kernel-daemon.mjs'],
        cwd: '.',
        timeoutMs: 5000,
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    try {
      await assert.rejects(
        () => configured.manager.invoke('demo.kernel-async-plugin', 'demo.work', {}),
        /plugin burned its wall clock/,
      )
    } finally {
      await configured.manager.dispose()
    }
  } finally {
    await removeDirectoryWithRetry(tempDirectory)
  }
})

test('command kernel bridge surfaces kernel busy backpressure as an invoke rejection', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-kernel-async-busy-'))
  const pluginDirectory = path.join(tempDirectory, 'plugins', 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.kernel-async-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.work' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.work': async () => ({}) } }\n", 'utf8')
    await fs.writeFile(kernelDaemonPath, createAsyncKernelDaemonStubScript('busy'), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: process.execPath,
        args: ['./kernel-daemon.mjs'],
        cwd: '.',
        timeoutMs: 5000,
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    try {
      await assert.rejects(
        () => configured.manager.invoke('demo.kernel-async-plugin', 'demo.work', {}),
        /async invoke queue full/,
      )
    } finally {
      await configured.manager.dispose()
    }
  } finally {
    await removeDirectoryWithRetry(tempDirectory)
  }
})

test('command kernel bridge rejects an async invoke whose real result never arrives', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-kernel-async-deadline-'))
  const pluginDirectory = path.join(tempDirectory, 'plugins', 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.kernel-async-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.work' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.work': async () => ({}) } }\n", 'utf8')
    // The stub answers with the accepted marker and only delivers a late
    // envelope at 500 ms — past the 150 ms async-result window.
    await fs.writeFile(kernelDaemonPath, createAsyncKernelDaemonStubScript('accepted-then-silence'), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: process.execPath,
        args: ['./kernel-daemon.mjs'],
        cwd: '.',
        timeoutMs: 5000,
        asyncInvokeTimeoutMs: 150,
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    try {
      await assert.rejects(
        () => configured.manager.invoke('demo.kernel-async-plugin', 'demo.work', {}),
        /Kernel async invoke timed out/,
      )
      // Let the late envelope arrive on a settled request: it must be dropped
      // silently instead of crashing the transport.
      await new Promise((resolve) => setTimeout(resolve, 600))
    } finally {
      await configured.manager.dispose()
    }
  } finally {
    await removeDirectoryWithRetry(tempDirectory)
  }
})

test('command kernel bridge exposes the kernel audit query to the UI surface', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-kernel-async-'))
  const pluginDirectory = path.join(tempDirectory, 'plugins', 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.kernel-async-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.work' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.work': async () => ({}) } }\n", 'utf8')
    await fs.writeFile(kernelDaemonPath, createAsyncKernelDaemonStubScript('audit'), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: process.execPath,
        args: ['./kernel-daemon.mjs'],
        cwd: '.',
        timeoutMs: 5000,
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    try {
      const audit = await configured.manager.getAudit({ sinceSeq: 0, limit: 256 })
      assert.equal(audit.lastSeq, 2)
      assert.equal(audit.entries[0].kind, 'policy.admission_rejected')
      assert.equal(audit.entries[0].extensionId, 'demo.kernel-async-plugin')
      assert.equal(audit.accounting[0].callCount, 3)
      assert.equal(audit.accounting[0].memoryHighWaterBytes, 4096)
    } finally {
      await configured.manager.dispose()
    }
  } finally {
    await removeDirectoryWithRetry(tempDirectory)
  }
})

test('kernel governance events stream to the facade without polling', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-kernel-async-'))
  const pluginDirectory = path.join(tempDirectory, 'plugins', 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.kernel-async-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.work' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.work': async () => ({}) } }\n", 'utf8')
    await fs.writeFile(kernelDaemonPath, createAsyncKernelDaemonStubScript('audit'), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: process.execPath,
        args: ['./kernel-daemon.mjs'],
        cwd: '.',
        timeoutMs: 5000,
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    try {
      // The audit event is pushed BEFORE the real result: a UI awaiting
      // nextAuditEvent gets it the moment it is recorded, while the invoke
      // promise stays pending for the actual envelope.
      const firstInvoke = configured.manager.invoke('demo.kernel-async-plugin', 'demo.work', {})
      const pushed = await configured.manager.nextAuditEvent()
      assert.equal(pushed.kind, 'contract.violation')
      assert.equal(pushed.extensionId, 'demo.kernel-async-plugin')
      assert.deepEqual(await firstInvoke, { message: 'hello from async plugin' })

      // Second invoke: its event arrives while nobody waits — the queued
      // event must drain on the next nextAuditEvent call.
      await configured.manager.invoke('demo.kernel-async-plugin', 'demo.work', {})
      const queued = await configured.manager.nextAuditEvent()
      assert.equal(queued.kind, 'contract.violation')
      assert.ok(queued.seq > pushed.seq, 'queued event is the newer one')
    } finally {
      await configured.manager.dispose()
    }
  } finally {
    await removeDirectoryWithRetry(tempDirectory)
  }
})

test('audit surface rejects with a clear error in local mode', async () => {
  const manager = new ExtensionManager({ isDevelopment: true })
  manager.registerRuntime(new NodeRuntime())

  await assert.rejects(() => manager.getAudit(), /local bridge keeps no kernel audit ring/)
  await assert.rejects(() => manager.nextAuditEvent(), /local bridge keeps no kernel audit ring/)

  await manager.dispose()
})

function createAsyncKernelDaemonStubScript(mode: 'accepted-then-result' | 'accepted-then-error' | 'accepted-then-silence' | 'busy' | 'audit'): string {
  return `
const MODE = ${JSON.stringify(mode)}
let auditSeq = 1

function writeEnvelope(envelope) {
  process.stdout.write(JSON.stringify(envelope) + '\\n')
}

function writeSuccess(id, result) {
  writeEnvelope({ kind: 'response', id, result })
}

function writeError(id, code, message) {
  writeEnvelope({ kind: 'response', id, error: { code, message } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line) {
      continue
    }
    let request
    try {
      request = JSON.parse(line)
    } catch {
      continue
    }
    handleRequest(request)
  }
})

function handleRequest(request) {
  if (request.method === 'kernel.load') {
    writeSuccess(request.id, {
      extensionId: request.params.manifest.id,
      security: { status: 'authorized-safe', reason: 'Approved by async kernel daemon stub.' },
    })
    return
  }

  if (request.method === 'kernel.activate' || request.method === 'kernel.deactivate') {
    writeSuccess(request.id, true)
    return
  }

  if (request.method === 'kernel.audit.query') {
    writeSuccess(request.id, {
      entries: [
        { seq: 1, timestampMs: 1700000000000, kind: 'policy.admission_rejected', extensionId: 'demo.kernel-async-plugin', detail: 'memory tier overflow' },
      ],
      lastSeq: 2,
      accounting: [
        { extensionId: 'demo.kernel-async-plugin', callCount: 3, totalNs: 120000, peakNs: 60000, fuelTraps: 0, memorySoftBreaches: 1, memoryGrowthDenials: 0, memoryHighWaterBytes: 4096, fuelConsumedTotal: 512, contractViolations: 0 },
      ],
    })
    return
  }

  if (request.method === 'kernel.invoke') {
    if (MODE === 'busy') {
      writeError(request.id, 'KERNEL_BUSY', 'async invoke queue full: 1 in flight')
      return
    }
    if (MODE === 'audit') {
      auditSeq += 1
      writeEnvelope({ kind: 'audit', entry: { seq: auditSeq, timestampMs: 1700000000000 + auditSeq, kind: 'contract.violation', extensionId: 'demo.kernel-async-plugin', detail: 'over-slice streak' } })
      writeSuccess(request.id, { accepted: true, async: true })
      setTimeout(() => writeSuccess(request.id, { message: 'hello from async plugin' }), 30)
      return
    }
    writeSuccess(request.id, { accepted: true, async: true })
    if (MODE === 'accepted-then-result') {
      setTimeout(() => writeSuccess(request.id, { message: 'hello from async plugin' }), 30)
    } else if (MODE === 'accepted-then-error') {
      setTimeout(() => writeError(request.id, 'KERNEL_INVOKE_FAILED', 'plugin burned its wall clock'), 30)
    } else if (MODE === 'accepted-then-silence') {
      setTimeout(() => writeSuccess(request.id, { message: 'late envelope nobody waits for' }), 500)
    }
    return
  }

  writeSuccess(request.id, true)
}
`
}

function createMalformedKernelDaemonStubScript(): string {
  return `
process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {
  process.stdout.write('this is not json\\n')
})
`
}

async function removeDirectoryWithRetry(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EBUSY' || attempt === 4) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

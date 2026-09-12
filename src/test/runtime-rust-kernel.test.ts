import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createExtensionManagerFromHostConfig,
  generateSigningKeyPair,
  signManifest,
} from '../index.js'
import { ensureSpawnAvailable } from './spawn-test-helpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '../../')
const rustKernelDaemonBinaryPath = path.join(
  root,
  'rust',
  'target',
  'debug',
  process.platform === 'win32'
    ? 'extensionsd.exe'
    : 'extensionsd',
)

test('creates configured manager from host config with rust kernel daemon', async (t) => {
  await ensureSpawnAvailable(t)
  const keyPair = generateSigningKeyPair('ed25519')
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-host-rust-kernel-'))
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
      id: 'demo.rust-kernel-daemon-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      trust: {
        publisherId: 'publisher.demo',
        trustDomain: 'third-party' as const,
        issuedBy: 'third-party-issuer',
      },
      artifact: { kind: 'module' as const, entry: './index.js' },
      runtime: 'node' as const,
      capabilities: [{
        name: 'demo.hello',
      }],
    }

    const signature = signManifest(manifest, {
      algorithm: 'ed25519',
      keyId: 'demo-key',
      privateKeyPem: keyPair.privateKeyPem,
    })

    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({ ...manifest, signature }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.hello': async () => ({ message: 'hello from rust kernel daemon' }) } }\n", 'utf8')
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
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      signaturePolicy: 'require-signature',
      trustedKeyDirectory: './trusted-keys',
      trustBundlePath: './trust-bundle.json',
      revocationListPath: './revocation-list.json',
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: rustKernelDaemonBinaryPath,
        timeoutMs: 15000,
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    assert.equal(configured.loaded.length, 1)
    assert.equal(configured.loaded[0]?.security.status, 'authorized-safe')

    const result = await configured.manager.invoke('demo.rust-kernel-daemon-plugin', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from rust kernel daemon' })

    const session = await configured.manager.openSession('demo.rust-kernel-daemon-plugin', 'demo.hello', {})
    assert.deepEqual(await session.nextEvent(), {
      type: 'data',
      data: { message: 'hello from rust kernel daemon' },
    })
    assert.deepEqual(await session.nextEvent(), { type: 'end' })

    await configured.manager.deactivate('demo.rust-kernel-daemon-plugin')
    await configured.manager.dispose()
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('rust kernel daemon process runtime supports real session send cancel and error events', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-host-rust-kernel-session-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.rust-kernel-session-plugin',
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
  const events = [{ type: 'event', name: 'ready', payload: { phase: 'opened' } }]
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
        events.push({ type: 'error', message: 'boom' })
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
    'demo.chat': async () => ({ mode: 'unary-fallback' }),
  },
  openSession(capability) {
    if (capability !== 'demo.chat') {
      throw new Error('unknown capability')
    }
    return createQueue()
  },
}
`, 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: rustKernelDaemonBinaryPath,
        timeoutMs: 15000,
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    const session = await configured.manager.openSession('demo.rust-kernel-session-plugin', 'demo.chat', {})

    assert.deepEqual(await session.nextEvent(), {
      type: 'event',
      name: 'ready',
      payload: { phase: 'opened' },
    })

    await session.send({ text: 'ping' })
    assert.deepEqual(await session.nextEvent(), {
      type: 'data',
      data: { echo: 'ping' },
    })

    await session.send({ fail: true })
    assert.deepEqual(await session.nextEvent(), {
      type: 'error',
      message: 'boom',
    })
    assert.deepEqual(await session.nextEvent(), { type: 'end' })
    await session.close()

    const session2 = await configured.manager.openSession('demo.rust-kernel-session-plugin', 'demo.chat', {})
    assert.deepEqual(await session2.nextEvent(), {
      type: 'event',
      name: 'ready',
      payload: { phase: 'opened' },
    })
    await session2.cancel()
    assert.deepEqual(await session2.nextEvent(), { type: 'end' })
    await session2.close()

    await configured.manager.dispose()
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('rust kernel daemon session rejects operations after close', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-host-rust-kernel-close-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.rust-kernel-close-plugin',
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
  const events = [{ type: 'event', name: 'ready', payload: { source: 'rust-daemon' } }]
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
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: rustKernelDaemonBinaryPath,
        timeoutMs: 15000,
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    const session = await configured.manager.openSession('demo.rust-kernel-close-plugin', 'demo.chat', {})
    await session.close()

    await assert.rejects(
      () => session.nextEvent(),
      /session is closed/i,
    )
    await assert.rejects(
      () => session.send({ text: 'ping' }),
      /session is closed/i,
    )

    await configured.manager.dispose()
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('creates configured manager from host config with rust kernel daemon and remote http runtime', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-host-rust-remote-http-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')
  let active = false
  const sessions = new Map<string, true>()
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.statusCode = 405
      response.end()
      return
    }

    let body = ''
    for await (const chunk of request) {
      body += chunk.toString()
    }

    const rpc = JSON.parse(body) as {
      id: string
      method: string
    }
    response.setHeader('content-type', 'application/json')

    if (rpc.method === 'extension/activate') {
      active = true
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
      return
    }

    if (rpc.method === 'extension/deactivate') {
      active = false
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
      return
    }

    if (rpc.method === 'extension/invoke') {
      if (!active) {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { message: 'remote http daemon plugin not active' } }))
        return
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { message: 'hello from rust remote http daemon' } }))
      return
    }

    if (rpc.method === 'extension/openSession') {
      if (!active) {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { message: 'remote http daemon plugin not active' } }))
        return
      }
      const sessionId = `remote-http-session-${sessions.size + 1}`
      sessions.set(sessionId, true)
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          sessionId,
          events: [{ type: 'event', name: 'ready', payload: { source: 'remote-http-daemon' } }],
        },
      }))
      return
    }

    if (rpc.method === 'extension/session.send') {
      const params = (rpc as { params?: { data?: { fail?: boolean; text?: string } } }).params?.data
      if (params?.fail) {
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            events: [{ type: 'error', message: 'boom-remote-http' }, { type: 'end' }],
          },
        }))
        return
      }
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          events: [{ type: 'data', data: { echo: params?.text ?? null } }],
        },
      }))
      return
    }

    if (rpc.method === 'extension/session.cancel') {
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          events: [{ type: 'end' }],
        },
      }))
      return
    }

    if (rpc.method === 'extension/session.close') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
      return
    }

    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind remote http daemon test server')
  }
  const endpoint = `http://127.0.0.1:${address.port}/extensions/demo.rust-remote-http`
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.rust-remote-http',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: {
        kind: 'binary',
        entry: './remote-placeholder',
        launch: {
          command: endpoint,
          endpoint,
          transport: 'http',
        },
      },
      runtime: 'remote',
      capabilities: [{
        name: 'demo.hello',
        interactionMode: 'duplex' as const,
        executionMode: 'session' as const,
        realtimeClass: 'interactive' as const,
        concurrencyPolicy: 'single' as const,
      }],
    }, null, 2), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins', isDevelopment: true,
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: rustKernelDaemonBinaryPath,
        timeoutMs: 15000,
      },
    }, null, 2), 'utf8')

    const configured = await createExtensionManagerFromHostConfig(hostConfigPath)
    const result = await configured.manager.invoke('demo.rust-remote-http', 'demo.hello', {})

    assert.deepEqual(result, { message: 'hello from rust remote http daemon' })
    const session = await configured.manager.openSession('demo.rust-remote-http', 'demo.hello', {})
    assert.deepEqual(await session.nextEvent(), {
      type: 'event',
      name: 'ready',
      payload: { source: 'remote-http-daemon' },
    })
    await session.send({ text: 'ping' })
    assert.deepEqual(await session.nextEvent(), {
      type: 'data',
      data: { echo: 'ping' },
    })
    await session.send({ fail: true })
    assert.deepEqual(await session.nextEvent(), {
      type: 'error',
      message: 'boom-remote-http',
    })
    assert.deepEqual(await session.nextEvent(), { type: 'end' })
    await session.close()
    await configured.manager.deactivate('demo.rust-remote-http')
    await configured.manager.dispose()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

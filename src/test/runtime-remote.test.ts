import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ExtensionManager, RemoteRuntime } from '../index.js'

test('loads remote plugin through remote http runtime', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-remote-'))
  let active = false
  const sessions = new Map<string, { events: Array<{ type: string; [key: string]: unknown }> }>()
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

    if (rpc.method === 'extension/load') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
      return
    }

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
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { message: 'remote plugin not active' } }))
        return
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { message: 'hello from remote plugin' } }))
      return
    }

    if (rpc.method === 'extension/openSession') {
      if (!active) {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { message: 'remote plugin not active' } }))
        return
      }

      const sessionId = `session-${sessions.size + 1}`
      sessions.set(sessionId, {
        events: [
          { type: 'event', name: 'ready', payload: { phase: 'opened' } },
          { type: 'data', data: { message: 'hello from remote plugin session' } },
        ],
      })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { sessionId, events: [{ type: 'event', name: 'ready', payload: { phase: 'opened' } }] } }))
      return
    }

    if (rpc.method === 'extension/session.send') {
      const session = sessions.get((rpc as { params?: { sessionId?: string } }).params?.sessionId ?? '')
      if (!session) {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { message: 'unknown session' } }))
        return
      }

      const params = (rpc as { params?: { data?: { fail?: boolean; text?: string } } }).params?.data
      if (params?.fail) {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { events: [{ type: 'error', message: 'boom' }, { type: 'end' }] } }))
        return
      }

      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { events: [{ type: 'data', data: { echo: params?.text ?? null } }] } }))
      return
    }

    if (rpc.method === 'extension/session.cancel') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { events: [{ type: 'end' }] } }))
      return
    }

    if (rpc.method === 'extension/session.close') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
      return
    }

    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { message: 'unsupported method' } }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind remote test server')
  }
  const endpoint = `http://127.0.0.1:${address.port}/extensions/demo.remote`

  try {
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.remote-extension',
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
        name: 'demo.chat',
        interactionMode: 'duplex',
        executionMode: 'session',
        realtimeClass: 'interactive',
        concurrencyPolicy: 'single',
      }],
    }, null, 2), 'utf8')

    const manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new RemoteRuntime())

    await manager.loadManifestFile(tempDirectory)
    const result = await manager.invoke('demo.remote-extension', 'demo.chat', {})
    assert.deepEqual(result, { message: 'hello from remote plugin' })

    const session = await manager.openSession('demo.remote-extension', 'demo.chat', {})
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

    await manager.deactivate('demo.remote-extension')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('remote http checkStatus uses extension/status without reloading', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-remote-status-'))
  const methods: string[] = []
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
      params?: { extensionId?: string }
    }
    methods.push(rpc.method)
    response.setHeader('content-type', 'application/json')

    if (rpc.method === 'extension/load') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
      return
    }

    if (rpc.method === 'extension/status') {
      assert.equal(rpc.params?.extensionId, 'demo.remote-status-extension')
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { state: 'available' } }))
      return
    }

    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { message: 'unsupported method' } }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind remote status test server')
  }
  const endpoint = `http://127.0.0.1:${address.port}/extensions/demo.remote-status`
  let manager: ExtensionManager | undefined

  try {
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.remote-status-extension',
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
      capabilities: [{ name: 'demo.hello' }],
    }, null, 2), 'utf8')

    manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new RemoteRuntime())
    await manager.loadManifestFile(tempDirectory)

    const status = await manager.checkStatus('demo.remote-status-extension')

    assert.equal(status.state, 'available')
    assert.deepEqual(methods, ['extension/load', 'extension/status'])
  } finally {
    await manager?.dispose().catch(() => {})
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('loads remote plugin through remote process runtime with real session events', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-remote-process-'))
  const bridgePath = path.join(tempDirectory, 'remote-bridge.mjs')
  let manager: ExtensionManager | undefined

  try {
    await fs.writeFile(bridgePath, `
import readline from 'node:readline'

let active = false
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
    active = true
    writeResponse(request.id, true)
    return
  }
  if (request.method === 'extension/deactivate') {
    active = false
    writeResponse(request.id, true)
    process.exit(0)
    return
  }
  if (request.method === 'extension/invoke') {
    if (!active) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'remote process plugin not active' } }) + '\\n')
      return
    }
    writeResponse(request.id, { message: 'hello from remote process plugin' })
    return
  }
  if (request.method === 'extension/openSession') {
    const sessionId = 'remote-process-session-' + String(nextSessionId++)
    writeEvent(sessionId, { type: 'event', name: 'ready', payload: { source: 'remote-process' } })
    writeResponse(request.id, { sessionId })
    return
  }
  if (request.method === 'extension/session.send') {
    if (request.params?.data?.fail) {
      writeEvent(request.params.sessionId, { type: 'error', message: 'boom-remote-process' })
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
    writeResponse(request.id, true)
    return
  }
})
`, 'utf8')
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.remote-process-extension',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: {
        kind: 'binary',
        entry: './remote-bridge.mjs',
        launch: {
          command: process.execPath,
          args: ['./remote-bridge.mjs'],
          endpoint: 'https://remote-process.example/extensions/demo.remote-process',
          transport: 'process',
        },
      },
      runtime: 'remote',
      capabilities: [{
        name: 'demo.chat',
        interactionMode: 'duplex',
        executionMode: 'session',
        realtimeClass: 'interactive',
        concurrencyPolicy: 'single',
      }],
    }, null, 2), 'utf8')

    manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new RemoteRuntime())

    await manager.loadManifestFile(tempDirectory)
    const result = await manager.invoke('demo.remote-process-extension', 'demo.chat', {})
    assert.deepEqual(result, { message: 'hello from remote process plugin' })

    const session = await manager.openSession('demo.remote-process-extension', 'demo.chat', {})
    assert.deepEqual(await session.nextEvent(), {
      type: 'event',
      name: 'ready',
      payload: { source: 'remote-process' },
    })
    await session.send({ text: 'ping' })
    assert.deepEqual(await session.nextEvent(), {
      type: 'data',
      data: { echo: 'ping' },
    })
    await session.send({ fail: true })
    assert.deepEqual(await session.nextEvent(), {
      type: 'error',
      message: 'boom-remote-process',
    })
    await session.cancel()
    assert.deepEqual(await session.nextEvent(), { type: 'end' })
    await session.close()
  } finally {
    await manager?.dispose().catch(() => {})
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('remote http runtime rejects compatibility fallback for duplex capability', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-remote-http-session-contract-'))
  let active = false
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

    const rpc = JSON.parse(body) as { id: string; method: string }
    response.setHeader('content-type', 'application/json')

    if (rpc.method === 'extension/load') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
      return
    }
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
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { message: 'remote plugin not active' } }))
        return
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { mode: 'compatibility-only' } }))
      return
    }

    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { message: 'unsupported method' } }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind remote contract test server')
  }
  const endpoint = `http://127.0.0.1:${address.port}/extensions/demo.remote-contract`
  let manager: ExtensionManager | undefined

  try {
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.remote-http-session-contract',
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
        name: 'demo.chat',
        interactionMode: 'duplex',
        executionMode: 'session',
        realtimeClass: 'interactive',
        concurrencyPolicy: 'single',
      }],
    }, null, 2), 'utf8')

    manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new RemoteRuntime())

    await manager!.loadManifestFile(tempDirectory)
    await assert.rejects(
      () => manager!.openSession('demo.remote-http-session-contract', 'demo.chat', {}),
      /real session implementation/i,
    )
  } finally {
    await manager?.dispose().catch(() => {})
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

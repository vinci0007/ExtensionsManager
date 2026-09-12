import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ExtensionManager, RemoteRuntime } from '../dist/index.js'

const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-remote-http-demo-'))
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

  const rpc = JSON.parse(body)
  response.setHeader('content-type', 'application/json')

  if (rpc.method === 'extension/load') {
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
    return
  }

  if (rpc.method === 'extension/status') {
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        state: 'available',
        reason: 'remote http demo endpoint is reachable',
      },
    }))
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
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        message: active ? 'hello from remote http demo' : 'demo endpoint was not active',
      },
    }))
    return
  }

  response.end(JSON.stringify({
    jsonrpc: '2.0',
    id: rpc.id,
    error: { message: `unsupported method: ${rpc.method}` },
  }))
})

const listenPort = await listenOnAvailablePort(server)
const address = server.address()
if (!address || typeof address === 'string') {
  throw new Error('failed to bind remote demo server')
}

const endpoint = `http://127.0.0.1:${listenPort}/extensions/demo.remote-http-demo`
await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
  id: 'demo.remote-http-demo',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: {
    kind: 'binary',
    entry: './remote-placeholder',
    launch: {
      command: endpoint,
      endpoint,
      transport: 'http',
      timeoutMs: 5000,
    },
  },
  runtime: 'remote',
  capabilities: [{ name: 'demo.hello' }],
}, null, 2), 'utf8')

const manager = new ExtensionManager({ isDevelopment: true })
manager.registerRuntime(new RemoteRuntime())

try {
  await manager.loadManifestFile(tempDirectory)
  const status = await manager.checkStatus('demo.remote-http-demo')
  console.log('remote-http status:', status)

  const result = await manager.invoke('demo.remote-http-demo', 'demo.hello', {})
  console.log('remote-http result:', result)

  const session = await manager.openSession('demo.remote-http-demo', 'demo.hello', {})
  console.log('remote-http session event 1:', await session.nextEvent())
  console.log('remote-http session event 2:', await session.nextEvent())
} finally {
  await manager.deactivate('demo.remote-http-demo').catch(() => {})
  await manager.dispose()
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(tempDirectory, { recursive: true, force: true })
}

async function listenOnAvailablePort(server) {
  for (const port of [47121, 47122, 47123, 47124, 47125]) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
      return port
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        throw error
      }
    }
  }

  throw new Error('failed to bind remote demo server on a fetch-safe port')
}

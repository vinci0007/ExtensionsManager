import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { ExtensionManager, NodeRuntime, PluginStore } from '../index.js'

let manager: ExtensionManager
let store: PluginStore
let tempRoot: string
let pluginsDirectory: string
let server: http.Server
let serverUrl: string

const manifest = {
  id: 'registry.aurora',
  name: 'Aurora Converter',
  description: 'Installed from a registry bundle.',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: { kind: 'module', entry: './index.js' },
  runtime: 'node',
  capabilities: [{ name: 'aurora.convert' }],
}

const moduleSource = `export default {
  capabilities: {
    'aurora.convert': async (input) => ({ converted: String(input?.text ?? '').toUpperCase() }),
  },
}
`

function sha256(content: string | Buffer): string {
  return `sha256-${crypto.createHash('sha256').update(content).digest('hex')}`
}

function bundle(manifestOverride?: Record<string, unknown>, moduleOverride?: string): Buffer {
  return Buffer.from(JSON.stringify({
    manifest: manifestOverride ?? manifest,
    files: [{ path: 'index.js', content: moduleOverride ?? moduleSource }],
  }), 'utf8')
}

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-registry-'))
  pluginsDirectory = path.join(tempRoot, 'plugins')
  await fs.mkdir(pluginsDirectory, { recursive: true })

  const goodBundle = bundle()
  const tamperedBundle = Buffer.from(JSON.stringify({
    manifest: { ...manifest, id: 'registry.tampered' },
    files: [{ path: 'index.js', content: `${moduleSource}\n// tampered` }],
  }), 'utf8')
  const traversalBundle = Buffer.from(JSON.stringify({
    manifest: { ...manifest, id: 'registry.traversal' },
    files: [{ path: '../../escaped.js', content: 'export {}' }],
  }), 'utf8')

  server = http.createServer((request, response) => {
    const url = request.url ?? ''
    const respond = (status: number, body: Buffer | string) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(body)
    }

    if (url.startsWith('/index-good')) {
      respond(200, JSON.stringify({
        plugins: [
          { id: 'registry.aurora', version: '1.0.0', bundleUrl: `${serverUrl}/bundle-good`, integrity: sha256(goodBundle) },
          { id: 'registry.tampered', version: '1.0.0', bundleUrl: `${serverUrl}/bundle-tampered`, integrity: 'sha256-deadbeef' },
          { id: 'registry.traversal', version: '1.0.0', bundleUrl: `${serverUrl}/bundle-traversal`, integrity: sha256(traversalBundle) },
        ],
      }))
      return
    }
    if (url.startsWith('/bundle-good')) return respond(200, goodBundle)
    if (url.startsWith('/bundle-tampered')) return respond(200, tamperedBundle)
    if (url.startsWith('/bundle-traversal')) return respond(200, traversalBundle)
    if (url.startsWith('/index-empty')) return respond(200, JSON.stringify({ plugins: [] }))
    respond(404, 'not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  manager = new ExtensionManager({ workspacePath: tempRoot, isDevelopment: true })
  manager.registerRuntime(new NodeRuntime())
  store = new PluginStore({ manager, pluginsDirectory })
})

after(async () => {
  await manager.dispose()
  server.close()
  await fs.rm(tempRoot, { recursive: true, force: true })
})

test('installs from a registry bundle and verifies integrity', async () => {
  const extension = await store.installFromRegistry(`${serverUrl}/index-good`, 'registry.aurora')

  assert.equal(extension.id, 'registry.aurora')
  await fs.access(path.join(pluginsDirectory, 'registry.aurora', 'index.js'))
  await fs.access(path.join(pluginsDirectory, 'registry.aurora', 'extension.json'))

  const result = await manager.invoke<{ text: string }, { converted: string }>(
    'registry.aurora',
    'aurora.convert',
    { text: 'hi' },
  )
  assert.deepEqual(result, { converted: 'HI' })
})

test('rejects a bundle whose bytes do not match the registry integrity', async () => {
  await assert.rejects(
    () => store.installFromRegistry(`${serverUrl}/index-good`, 'registry.tampered'),
    /bundle integrity mismatch/,
  )
  await assert.rejects(() => fs.access(path.join(pluginsDirectory, 'registry.tampered')))
})

test('rejects bundle file paths that escape the plugin directory', async () => {
  await assert.rejects(
    () => store.installFromRegistry(`${serverUrl}/index-good`, 'registry.traversal'),
    /escapes the plugin directory/,
  )
  await assert.rejects(() => fs.access(path.join(tempRoot, 'escaped.js')))
})

test('rejects when the registry does not list the extension', async () => {
  await assert.rejects(
    () => store.installFromRegistry(`${serverUrl}/index-empty`, 'registry.ghost'),
    /does not list extension/,
  )
})

test('rejects plain-http registries off loopback', async () => {
  await assert.rejects(
    () => store.installFromRegistry('http://example.com/registry-index', 'registry.aurora'),
    /must use https/,
  )
})

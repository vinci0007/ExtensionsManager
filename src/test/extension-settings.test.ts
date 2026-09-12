import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { ExtensionManager, NodeRuntime } from '../index.js'

let manager: ExtensionManager
let tempRoot: string
let pluginDirectory: string

// The plugin records the activation context so tests can observe the
// settings delivery contract (context.settings on every (re)activation).
const moduleSource = `let lastContext = null
export default {
  async activate(context) { lastContext = context },
  capabilities: {
    'settings.get': async () => ({ settings: lastContext?.settings ?? null }),
  },
}
`

const manifest = {
  id: 'demo.settings-plugin',
  name: 'Settings Demo',
  description: 'Exposes declarative settings and reports what it received.',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: { kind: 'module', entry: './index.js' },
  runtime: 'node',
  capabilities: [{ name: 'settings.get' }],
  settings: [
    { key: 'displayName', type: 'string', title: 'Display name', default: 'Aurora' },
    { key: 'threshold', type: 'number', min: 0, max: 100, default: 50 },
    { key: 'enabled', type: 'boolean', default: true },
    { key: 'mode', type: 'enum', enum: ['fast', 'safe'], default: 'safe' },
  ],
}

async function invokeSettings(): Promise<Record<string, unknown> | null> {
  const result = await manager.invoke<{}, { settings: Record<string, unknown> | null }>(
    'demo.settings-plugin',
    'settings.get',
    {},
  )
  return result.settings
}

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-settings-'))
  pluginDirectory = path.join(tempRoot, 'demo.settings-plugin')
  await fs.mkdir(pluginDirectory, { recursive: true })
  await fs.writeFile(path.join(pluginDirectory, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await fs.writeFile(path.join(pluginDirectory, 'index.js'), moduleSource, 'utf8')

  manager = new ExtensionManager({ workspacePath: tempRoot, isDevelopment: true })
  manager.registerRuntime(new NodeRuntime())
  await manager.loadManifestFile(pluginDirectory)
})

after(async () => {
  await manager.dispose()
  await fs.rm(tempRoot, { recursive: true, force: true })
})

test('settings definitions are exposed from the manifest', () => {
  const definitions = manager.getSettingDefinitions('demo.settings-plugin')
  assert.equal(definitions.length, 4)
  assert.deepEqual(
    definitions.map((definition) => definition.key),
    ['displayName', 'threshold', 'enabled', 'mode'],
  )
})

test('setting values start from manifest defaults', () => {
  assert.deepEqual(manager.getSettingValues('demo.settings-plugin'), {
    displayName: 'Aurora',
    threshold: 50,
    enabled: true,
    mode: 'safe',
  })
})

test('plugin receives defaults through context.settings on activation', async () => {
  await manager.activate('demo.settings-plugin')
  assert.deepEqual(await invokeSettings(), {
    displayName: 'Aurora',
    threshold: 50,
    enabled: true,
    mode: 'safe',
  })
})

test('setSetting validates against the definition', () => {
  assert.throws(() => manager.setSetting('demo.settings-plugin', 'threshold', 'not-a-number'), /expects a finite number/)
  assert.throws(() => manager.setSetting('demo.settings-plugin', 'threshold', 101), /must be <= 100/)
  assert.throws(() => manager.setSetting('demo.settings-plugin', 'mode', 'turbo'), /must be one of: fast, safe/)
  assert.throws(() => manager.setSetting('demo.settings-plugin', 'enabled', 'yes'), /expects boolean/)
  assert.throws(() => manager.setSetting('demo.settings-plugin', 'nonexistent', 1), /Unknown setting key/)
})

test('stored values apply on reinitialize and reach the plugin', async () => {
  manager.setSetting('demo.settings-plugin', 'displayName', 'Borealis')
  manager.setSetting('demo.settings-plugin', 'threshold', 80)
  manager.setSetting('demo.settings-plugin', 'mode', 'fast')

  assert.deepEqual(manager.getSettingValues('demo.settings-plugin'), {
    displayName: 'Borealis',
    threshold: 80,
    enabled: true,
    mode: 'fast',
  })

  await manager.reinitialize('demo.settings-plugin')
  assert.deepEqual(await invokeSettings(), {
    displayName: 'Borealis',
    threshold: 80,
    enabled: true,
    mode: 'fast',
  })
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { ExtensionManager, NodeRuntime, PluginStore } from '../index.js'

let manager: ExtensionManager
let store: PluginStore
let tempRoot: string
let pluginsDirectory: string
let auroraSource: string
let auroraV2Source: string
let borealisSource: string

const auroraManifest = {
  id: 'store.aurora',
  name: 'Aurora Converter',
  description: 'Converts aurora text into uppercase output.',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: {
    kind: 'module',
    entry: './index.js',
  },
  runtime: 'node',
  capabilities: [
    {
      name: 'aurora.convert',
    },
  ],
  metadata: {
    tags: ['converter', 'featured'],
  },
}

const borealisManifest = {
  id: 'store.borealis',
  name: 'Borealis Reporter',
  description: 'Reports borealis observations.',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: {
    kind: 'module',
    entry: './index.js',
  },
  runtime: 'node',
  capabilities: [
    {
      name: 'borealis.report',
    },
  ],
}

const auroraModuleSource = `export default {
  capabilities: {
    'aurora.convert': async (input) => ({ converted: String(input?.text ?? '').toUpperCase(), version: '1.0.0' }),
  },
}
`

// The v2 build keeps the same capability but ships it from a different entry
// file: Node caches ESM imports by URL, so a fresh file name is what makes the
// swapped-in module observable through invoke() after the update.
const auroraV2Manifest = {
  ...auroraManifest,
  version: '2.0.0',
  artifact: {
    kind: 'module',
    entry: './index-v2.js',
  },
}

const auroraV2ModuleSource = `export default {
  capabilities: {
    'aurora.convert': async (input) => ({ converted: String(input?.text ?? '').toUpperCase(), version: '2.0.0' }),
  },
}
`

const borealisModuleSource = `export default {
  capabilities: {
    'borealis.report': async () => ({ reported: true }),
  },
}
`

async function writePluginDirectory(
  targetDirectory: string,
  manifest: Record<string, unknown>,
  moduleSource: string,
  moduleFileName = 'index.js',
): Promise<void> {
  await fs.mkdir(targetDirectory, { recursive: true })
  await fs.writeFile(path.join(targetDirectory, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  await fs.writeFile(path.join(targetDirectory, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await fs.writeFile(path.join(targetDirectory, moduleFileName), moduleSource, 'utf8')
}

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-store-'))
  pluginsDirectory = path.join(tempRoot, 'plugins')
  await fs.mkdir(pluginsDirectory, { recursive: true })

  auroraSource = path.join(tempRoot, 'sources', 'aurora')
  await writePluginDirectory(auroraSource, auroraManifest, auroraModuleSource)

  auroraV2Source = path.join(tempRoot, 'sources', 'aurora-v2')
  await writePluginDirectory(auroraV2Source, auroraV2Manifest, auroraV2ModuleSource, 'index-v2.js')

  borealisSource = path.join(tempRoot, 'sources', 'borealis')
  await writePluginDirectory(borealisSource, borealisManifest, borealisModuleSource)

  manager = new ExtensionManager({ isDevelopment: true, workspacePath: tempRoot })
  manager.registerRuntime(new NodeRuntime())
  store = new PluginStore({ manager, pluginsDirectory })
})

after(async () => {
  await manager.dispose()
  await fs.rm(tempRoot, { recursive: true, force: true })
})

test('installs a plugin from a directory and registers it', async () => {
  const extension = await store.installFromDirectory(auroraSource)

  assert.equal(extension.id, 'store.aurora')
  assert.equal(manager.get('store.aurora')?.manifest.version, '1.0.0')

  await fs.access(path.join(pluginsDirectory, 'store.aurora', 'extension.json'))

  const result = await manager.invoke<{ text: string }, { converted: string; version: string }>(
    'store.aurora',
    'aurora.convert',
    { text: 'hi' },
  )
  assert.deepEqual(result, { converted: 'HI', version: '1.0.0' })
})

test('rejects duplicate installation of the same plugin', async () => {
  await assert.rejects(() => store.installFromDirectory(auroraSource), /already installed/)
})

test('rejects installing manifests with unsafe extension ids', async () => {
  const traversalSource = path.join(tempRoot, 'sources', 'unsafe-traversal')
  await writePluginDirectory(traversalSource, { ...auroraManifest, id: '../escaped' }, auroraModuleSource)

  await assert.rejects(() => store.installFromDirectory(traversalSource), /Invalid extension id/)
  await assert.rejects(() => fs.access(path.join(tempRoot, 'escaped')))

  const windowsSource = path.join(tempRoot, 'sources', 'unsafe-windows')
  await writePluginDirectory(windowsSource, { ...auroraManifest, id: 'store.escaped\\plugin' }, auroraModuleSource)

  await assert.rejects(() => store.installFromDirectory(windowsSource), /Invalid extension id/)

  await assert.rejects(() => store.uninstall('../../escaped'), /Invalid extension id/)
  assert.equal(manager.get('../escaped'), undefined)
})

test('searches installed plugins by name and capability', async () => {
  await store.installFromDirectory(borealisSource)

  assert.deepEqual(store.search('aurora converter').map((extension) => extension.id), ['store.aurora'])
  assert.deepEqual(store.search('BOREALIS').map((extension) => extension.id), ['store.borealis'])
  assert.deepEqual(store.search('aurora.convert').map((extension) => extension.id), ['store.aurora'])
  assert.deepEqual(store.search('no-such-plugin'), [])
})

test('finds installed plugins by manifest tag', () => {
  assert.deepEqual(store.findByTag('featured').map((extension) => extension.id), ['store.aurora'])
  assert.deepEqual(store.findByTag('converter').map((extension) => extension.id), ['store.aurora'])
  assert.deepEqual(store.findByTag('untagged'), [])
})

test('updates an installed plugin and reinitializes it', async () => {
  const extension = await store.update('store.aurora', auroraV2Source)

  assert.equal(extension.manifest.version, '2.0.0')
  assert.equal(manager.get('store.aurora')?.manifest.version, '2.0.0')

  const updatedManifest = JSON.parse(
    await fs.readFile(path.join(pluginsDirectory, 'store.aurora', 'extension.json'), 'utf8'),
  ) as { version: string }
  assert.equal(updatedManifest.version, '2.0.0')

  const result = await manager.invoke<{ text: string }, { converted: string; version: string }>(
    'store.aurora',
    'aurora.convert',
    { text: 'hi' },
  )
  assert.deepEqual(result, { converted: 'HI', version: '2.0.0' })
  assert.equal(manager.getInitializationInfo('store.aurora').isActive, true)
})

test('rejects update when the source manifest id does not match', async () => {
  const otherSource = path.join(tempRoot, 'sources', 'other')
  await writePluginDirectory(otherSource, { ...auroraManifest, id: 'store.other' }, auroraModuleSource)

  await assert.rejects(() => store.update('store.aurora', otherSource), /Extension id mismatch/)
  assert.equal(manager.get('store.aurora')?.manifest.version, '2.0.0')
})

test('rejects update when the plugin is not installed', async () => {
  const ghostSource = path.join(tempRoot, 'sources', 'ghost')
  await writePluginDirectory(ghostSource, { ...auroraManifest, id: 'store.ghost' }, auroraModuleSource)

  await assert.rejects(() => store.update('store.ghost', ghostSource), /not installed/)
})

test('uninstalls a plugin and removes its directory', async () => {
  await manager.invoke('store.borealis', 'borealis.report', {})
  assert.equal(manager.getInitializationInfo('store.borealis').isActive, true)

  await store.uninstall('store.borealis')

  assert.equal(manager.get('store.borealis'), undefined)
  assert.deepEqual(manager.findByCapability('borealis.report'), [])
  await assert.rejects(() => fs.access(path.join(pluginsDirectory, 'store.borealis')))
})

test('install pins artifact integrity and load rejects later binary tampering', async () => {
  const tamperSource = path.join(tempRoot, 'sources', 'tamper')
  await writePluginDirectory(tamperSource, { ...borealisManifest, id: 'store.tamper' }, borealisModuleSource)
  await store.installFromDirectory(tamperSource)

  const installedManifest = JSON.parse(
    await fs.readFile(path.join(pluginsDirectory, 'store.tamper', 'extension.json'), 'utf8'),
  ) as { artifact: { integrity?: string } }
  assert.ok(installedManifest.artifact.integrity, 'install should pin the entry digest')

  // Tamper with the binary after install; a fresh load must reject it.
  await fs.appendFile(path.join(pluginsDirectory, 'store.tamper', 'index.js'), '\n// tampered', 'utf8')

  const freshManager = new ExtensionManager({ isDevelopment: true, workspacePath: tempRoot })
  freshManager.registerRuntime(new NodeRuntime())
  try {
    await assert.rejects(
      () => freshManager.loadManifestFile(path.join(pluginsDirectory, 'store.tamper')),
      (error: unknown) => {
        const cause = (error as { cause?: Error }).cause
        assert.match(cause?.message ?? '', /Invalid artifact integrity/)
        return true
      },
    )
  } finally {
    await freshManager.dispose()
  }
})

test('update with an unchanged entry file name serves the new module (hot update)', async () => {
  // Install v1 content, then swap in v2 content under the SAME entry file name:
  // content-hash cache busting must make the new module observable without a
  // process restart and without renaming files.
  const hotUpdateSource = path.join(tempRoot, 'sources', 'hot-update')
  await writePluginDirectory(hotUpdateSource, {
    ...borealisManifest,
    id: 'store.hotupdate',
  }, borealisModuleSource)

  await store.installFromDirectory(hotUpdateSource)
  const before = await manager.invoke('store.hotupdate', 'borealis.report', {})
  assert.deepEqual(before, { reported: true })

  await fs.writeFile(
    path.join(hotUpdateSource, 'index.js'),
    `export default {
  capabilities: {
    'borealis.report': async () => ({ reported: true, version: 'hot-v2' }),
  },
}
`,
    'utf8',
  )
  await store.update('store.hotupdate', hotUpdateSource)

  const after = await manager.invoke<Record<string, never>, { version?: string }>(
    'store.hotupdate',
    'borealis.report',
    {},
  )
  assert.equal(after.version, 'hot-v2')
})

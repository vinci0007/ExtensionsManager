import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { ExtensionManager, NodeRuntime } from '../index.js'

let manager: ExtensionManager
let tempRoot: string

const manifest = {
  id: 'demo.prompt-plugin',
  name: 'Prompt Demo',
  description: 'One free capability and one prompt-gated capability.',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: { kind: 'module', entry: './index.js' },
  runtime: 'node',
  capabilities: [
    { name: 'open.access' },
    { name: 'sensitive.export', permission: 'prompt' },
  ],
}

const moduleSource = `export default {
  capabilities: {
    'open.access': async () => ({ open: true }),
    'sensitive.export': async () => ({ exported: true }),
  },
}
`

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'capability-permission-'))
  const pluginDirectory = path.join(tempRoot, 'demo.prompt-plugin')
  await fs.mkdir(pluginDirectory, { recursive: true })
  await fs.writeFile(path.join(pluginDirectory, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await fs.writeFile(path.join(pluginDirectory, 'index.js'), moduleSource, 'utf8')
})

after(async () => {
  await manager?.dispose()
  await fs.rm(tempRoot, { recursive: true, force: true })
})

test('prompt-marked capabilities are fail-closed without a permission handler', async () => {
  manager = new ExtensionManager({ workspacePath: tempRoot, isDevelopment: true })
  manager.registerRuntime(new NodeRuntime())
  await manager.loadManifestFile(path.join(tempRoot, 'demo.prompt-plugin'))

  // Unmarked capability works without any grant.
  const open = await manager.invoke('demo.prompt-plugin', 'open.access', {})
  assert.deepEqual(open, { open: true })

  await assert.rejects(
    () => manager.invoke('demo.prompt-plugin', 'sensitive.export', {}),
    /permission denied.*no permission handler configured/,
  )
  await manager.dispose()
})

test('the permission handler grants once and the decision is cached per session', async () => {
  const permissionRequests: { extensionId: string; capability: string }[] = []
  manager = new ExtensionManager({
    workspacePath: tempRoot,
    isDevelopment: true,
    onCapabilityPermission: async (request) => {
      permissionRequests.push(request)
      return true
    },
  })
  manager.registerRuntime(new NodeRuntime())
  await manager.loadManifestFile(path.join(tempRoot, 'demo.prompt-plugin'))

  const exported = await manager.invoke('demo.prompt-plugin', 'sensitive.export', {})
  assert.deepEqual(exported, { exported: true })
  // Second call: cached grant, no second prompt.
  await manager.invoke('demo.prompt-plugin', 'sensitive.export', {})

  assert.equal(permissionRequests.length, 1)
  assert.deepEqual(permissionRequests[0], {
    extensionId: 'demo.prompt-plugin',
    capability: 'sensitive.export',
  })
  await manager.deactivate('demo.prompt-plugin')

  // Re-activation starts a new permission cycle: the prompt fires again.
  await manager.activate('demo.prompt-plugin')
  await manager.invoke('demo.prompt-plugin', 'sensitive.export', {})
  assert.equal(permissionRequests.length, 2)
  await manager.dispose()
})

test('a denied capability is rejected and the denial is remembered', async () => {
  manager = new ExtensionManager({
    workspacePath: tempRoot,
    isDevelopment: true,
    onCapabilityPermission: async () => false,
  })
  manager.registerRuntime(new NodeRuntime())
  await manager.loadManifestFile(path.join(tempRoot, 'demo.prompt-plugin'))

  await assert.rejects(
    () => manager.invoke('demo.prompt-plugin', 'sensitive.export', {}),
    /rejected by permission handler/,
  )
  await assert.rejects(
    () => manager.invoke('demo.prompt-plugin', 'sensitive.export', {}),
    /denied for session/,
  )
  await manager.dispose()
})

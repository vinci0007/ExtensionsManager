import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ExtensionManager, NodeRuntime } from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '../../')

const runnableExamples = [
  {
    extensionId: 'demo.node-source-file-extension',
    manifestPath: path.join(root, 'examples/node-source-file-extension'),
    expected: { message: 'hello from node source-file extension' },
  },
  {
    extensionId: 'demo.node-source-dir-extension',
    manifestPath: path.join(root, 'examples/node-source-dir-extension'),
    expected: { message: 'hello from node source-dir extension' },
  },
  {
    extensionId: 'demo.node-package-extension',
    manifestPath: path.join(root, 'examples/node-package-extension'),
    expected: { message: 'hello from node package extension' },
  },
] as const

for (const example of runnableExamples) {
  test(`loads and invokes ${example.extensionId}`, async () => {
    const manager = new ExtensionManager({ isDevelopment: true, workspacePath: root })
    manager.registerRuntime(new NodeRuntime())

    await manager.loadManifestFile(example.manifestPath)
    const result = await manager.invoke(example.extensionId, 'demo.hello', {})
    assert.deepEqual(result, example.expected)

    await manager.deactivate(example.extensionId)
  })
}

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExtensionManager, NodeRuntime, ProcessRuntime } from '../dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')

async function main() {
  const manager = new ExtensionManager({ isDevelopment: true, workspacePath: root })
  manager.registerRuntime(new NodeRuntime())
  manager.registerRuntime(new ProcessRuntime())

  const nodeManifest = path.join(root, 'examples/node-extension')
  const processManifest = path.join(root, 'examples/process-extension')

  if (!existsSync(nodeManifest) || !existsSync(processManifest)) {
    throw new Error('Example manifests are missing')
  }

  await manager.loadManifestFile(nodeManifest)
  await manager.loadManifestFile(processManifest)

  const nodeResult = await manager.invoke('demo.node-extension', 'demo.hello', {})
  const processResult = await manager.invoke('demo.process-extension', 'demo.hello', {})

  console.log(JSON.stringify({ nodeResult, processResult }, null, 2))

  await manager.deactivate('demo.node-extension')
  await manager.deactivate('demo.process-extension')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

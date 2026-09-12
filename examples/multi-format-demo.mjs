import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExtensionManager, NodeRuntime, ProcessRuntime } from '../dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')

const examples = [
  {
    extensionId: 'demo.node-source-file-extension',
    manifestPath: path.join(root, 'examples/node-source-file-extension'),
    runtime: 'node',
  },
  {
    extensionId: 'demo.node-source-dir-extension',
    manifestPath: path.join(root, 'examples/node-source-dir-extension'),
    runtime: 'node',
  },
  {
    extensionId: 'demo.node-package-extension',
    manifestPath: path.join(root, 'examples/node-package-extension'),
    runtime: 'node',
  },
  {
    extensionId: 'demo.python-process-extension',
    manifestPath: path.join(root, 'examples/process-python-extension'),
    runtime: 'process',
    command: 'python',
  },
]

async function main() {
  const manager = new ExtensionManager({ isDevelopment: true, workspacePath: root })
  manager.registerRuntime(new NodeRuntime())
  manager.registerRuntime(new ProcessRuntime())

  const results = []

  for (const example of examples) {
    if (example.runtime === 'process' && example.command && !commandExists(example.command)) {
      results.push({
        extensionId: example.extensionId,
        skipped: true,
        reason: `Missing command: ${example.command}`,
      })
      continue
    }

    await manager.loadManifestFile(example.manifestPath)
    const result = await manager.invoke(example.extensionId, 'demo.hello', {})
    results.push({ extensionId: example.extensionId, result })
    await manager.deactivate(example.extensionId)
  }

  console.log(JSON.stringify({ results }, null, 2))
}

function commandExists(command) {
  const pathValue = process.env.PATH ?? ''
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT?.split(';').filter(Boolean) ?? [''])
    : ['']

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue
    }

    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`)
      if (fs.existsSync(candidate)) {
        return true
      }
    }
  }

  return false
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

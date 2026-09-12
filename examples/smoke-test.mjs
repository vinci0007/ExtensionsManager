import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')

const result = spawnSync(process.execPath, [path.join(root, 'examples/demo.mjs')], {
  cwd: root,
  encoding: 'utf8',
})

if (result.stdout) {
  process.stdout.write(result.stdout)
}

if (result.stderr) {
  process.stderr.write(result.stderr)
}

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

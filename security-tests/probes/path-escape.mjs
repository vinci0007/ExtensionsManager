/**
 * Security probe: path-traversal & command-injection resistance.
 *
 * Drives the built library (dist/) with hostile manifests and asserts every
 * escape attempt is rejected BEFORE any process is spawned or file is read
 * outside the plugin directory. All artifacts stay inside security-tests/.
 * Run: node security-tests/probes/path-escape.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ArtifactResolver } from '../../dist/core/ArtifactResolver.js'

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const baseManifest = {
  id: 'probe.hostile',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: { kind: 'module', entry: './index.js' },
  runtime: 'process',
  capabilities: [{ name: 'demo.hello' }],
}

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'security-probe-path-'))
const markerOutside = path.join(sandbox, 'OUTSIDE-MARKER.txt')
await fs.writeFile(markerOutside, 'do-not-touch', 'utf8')
const pluginDir = path.join(sandbox, 'plugin')
await fs.mkdir(pluginDir, { recursive: true })
await fs.writeFile(path.join(pluginDir, 'index.js'), 'export default {}', 'utf8')

const resolver = new ArtifactResolver()

function attempt(name, mutate, expect) {
  const manifest = structuredClone(baseManifest)
  mutate(manifest)
  try {
    const artifact = resolver.resolve(manifest, pluginDir)
    const escaped = !artifact.entryPath.startsWith(pluginDir)
      || (manifest.artifact.launch?.cwd === undefined && false)
    record(name, !expect, `unexpectedly resolved: ${artifact.entryPath}${escaped ? ' AND ESCAPED' : ''}`)
  } catch (error) {
    record(name, expect && /escapes plugin directory|NUL|shell execution/.test(error.message), error.message)
  }
}

// 1. Relative entry traversal
attempt('relative entry ../ escape', (m) => {
  m.artifact.entry = '../OUTSIDE-MARKER.txt'
}, true)

// 2. Deep traversal
attempt('deep entry ../ escape', (m) => {
  m.artifact.entry = './a/b/../../../../OUTSIDE-MARKER.txt'
}, true)

// 3. Absolute entry outside plugin dir
attempt('absolute entry outside plugin dir', (m) => {
  m.artifact.entry = markerOutside
}, true)

// 4. NUL byte in entry
attempt('NUL byte in entry', (m) => {
  m.artifact.entry = './index\0.js'
}, true)

// 5. Traversal via launch command
attempt('launch command ../ escape', (m) => {
  m.artifact.launch = { command: '../tool.exe' }
}, true)

// 6. Traversal via cwd
attempt('launch cwd escape', (m) => {
  m.artifact.launch = { cwd: '../elsewhere' }
}, true)

// 7. shell:true refused (command-injection vector)
attempt('shell:true refused', (m) => {
  m.artifact.launch = { command: 'node', shell: true }
}, true)

// 8. Legitimate relative plugin still resolves (no breakage)
try {
  const artifact = resolver.resolve(baseManifest, pluginDir)
  const inside = artifact.entryPath.startsWith(pluginDir)
  record('legitimate relative entry still resolves inside plugin dir', inside, artifact.entryPath)
} catch (error) {
  record('legitimate relative entry still resolves inside plugin dir', false, error.message)
}

// 9. Nothing was written or read outside the sandbox: the outside marker is untouched.
const markerAfter = await fs.readFile(markerOutside, 'utf8')
record('outside marker untouched throughout', markerAfter === 'do-not-touch')

// 10. Bare executable command (PATH lookup) keeps working — compatibility probe.
const withBare = structuredClone(baseManifest)
withBare.artifact.launch = { command: 'definitely-not-a-real-binary-name-xyz' }
try {
  const artifact = resolver.resolve(withBare, pluginDir)
  record('bare command name passes through for PATH lookup', artifact.command === 'definitely-not-a-real-binary-name-xyz')
} catch (error) {
  record('bare command name passes through for PATH lookup', false, error.message)
}

await fs.rm(sandbox, { recursive: true, force: true })

const failed = results.filter((item) => !item.pass)
console.log(`\n${results.length - failed.length}/${results.length} probes passed`)
process.exit(failed.length > 0 ? 1 : 0)

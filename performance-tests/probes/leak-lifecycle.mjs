/**
 * Memory leak probe: plugin lifecycle (load → activate → invoke → deactivate →
 * dispose) repeated many times, heap sampled after GC every cycle.
 *
 * Verifies: no per-cycle growth in JS heap or RSS for (a) the Node runtime and
 * (b) the in-process WASM runtime. Run with --expose-gc:
 *   node --expose-gc performance-tests/probes/leak-lifecycle.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ExtensionManager, NodeRuntime, WasmRuntime } from '../../dist/index.js'

// gc() exists only under --expose-gc; degrade to a no-op otherwise.
const gc = globalThis.gc ?? (() => {})

const CYCLES = 60
const SAMPLE_EVERY = 10

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function sample() {
  gc()
  const { heapUsed, rss } = process.memoryUsage()
  return { heapUsed, rss }
}

function growthMb(samples) {
  // Compare the median of the first quarter vs the last quarter of samples to
  // ignore startup warm-up and single-sample noise.
  const sortedIndex = (arr, frac) => arr[Math.floor((arr.length - 1) * frac)]
  const first = samples.slice(0, Math.max(2, Math.floor(samples.length / 4)))
  const last = samples.slice(-Math.max(2, Math.floor(samples.length / 4)))
  const median = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b)
    return sortedIndex(sorted, 0.5)
  }
  return (median(last) - median(first)) / (1024 * 1024)
}

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'perf-leak-lifecycle-'))

// --- Fixture A: Node runtime plugin ---
const nodePluginDir = path.join(sandbox, 'node-plugin')
await fs.mkdir(nodePluginDir, { recursive: true })
await fs.writeFile(path.join(nodePluginDir, 'extension.json'), JSON.stringify({
  id: 'perf.leak.node',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: { kind: 'module', entry: './index.js' },
  runtime: 'node',
  capabilities: [{ name: 'perf.echo' }],
}), 'utf8')
await fs.writeFile(path.join(nodePluginDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
await fs.writeFile(path.join(nodePluginDir, 'index.js'),
  "export default { capabilities: { 'perf.echo': async (input) => ({ echo: input }) } }", 'utf8')

// --- Fixture B: wasm runtime plugin (numeric contract, no memory section) ---
const wasmPluginDir = path.join(sandbox, 'wasm-plugin')
await fs.mkdir(wasmPluginDir, { recursive: true })
const templateWasm = await fs.readFile(
  path.resolve(import.meta.dirname, '../../examples/wasm-extension-template/plugin.wasm'),
)
await fs.writeFile(path.join(wasmPluginDir, 'plugin.wasm'), templateWasm)
await fs.writeFile(path.join(wasmPluginDir, 'extension.json'), JSON.stringify({
  id: 'perf.leak.wasm',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: { kind: 'wasm', entry: './plugin.wasm' },
  runtime: 'wasm',
  capabilities: [{ name: 'addOne' }],
}), 'utf8')

// --- Node runtime lifecycle leak ---
{
  const heapSamples = []
  const rssSamples = []
  const manager = new ExtensionManager({ isDevelopment: true })
  manager.registerRuntime(new NodeRuntime())

  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    const extension = await manager.loadManifestFile(nodePluginDir)
    await manager.activate(extension.id)
    const output = await manager.invoke(extension.id, 'perf.echo', { cycle })
    assert.deepEqual(output, { echo: { cycle } })
    await manager.deactivate(extension.id)
    manager.unregister(extension.id)

    // Force fresh ESM module load each cycle via cache-busting? Node caches by
    // URL, so a repeat load would return the cached module — the lifecycle
    // objects (instance/transport/maps) are still created fresh per load, which
    // is what we are leak-testing. Sample:
    if (cycle % SAMPLE_EVERY === 0) {
      const samplePoint = sample()
      heapSamples.push(samplePoint.heapUsed)
      rssSamples.push(samplePoint.rss)
    }
  }
  await manager.dispose()

  const heapGrowth = growthMb(heapSamples)
  const rssGrowth = growthMb(rssSamples)
  record(
    `Node runtime: ${CYCLES} lifecycle cycles — heap growth bounded`,
    heapGrowth < 8,
    `heap ${heapGrowth >= 0 ? '+' : ''}${heapGrowth.toFixed(2)} MB over ${CYCLES} cycles (ESM module cache counted)`,
  )
  record(
    `Node runtime: ${CYCLES} lifecycle cycles — RSS growth bounded`,
    rssGrowth < 20,
    `rss ${rssGrowth >= 0 ? '+' : ''}${rssGrowth.toFixed(2)} MB`,
  )
}

// --- Wasm runtime lifecycle leak (fresh WebAssembly.Module each cycle) ---
{
  const heapSamples = []
  const rssSamples = []
  const manager = new ExtensionManager({ isDevelopment: true })
  manager.registerRuntime(new WasmRuntime())

  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    const extension = await manager.loadManifestFile(wasmPluginDir)
    await manager.activate(extension.id)
    const output = await extension.invoke('addOne', { value: 41 })
    assert.equal(output, 42)
    await manager.deactivate(extension.id)
    manager.unregister(extension.id)

    if (cycle % SAMPLE_EVERY === 0) {
      const samplePoint = sample()
      heapSamples.push(samplePoint.heapUsed)
      rssSamples.push(samplePoint.rss)
    }
  }
  await manager.dispose()

  const heapGrowth = growthMb(heapSamples)
  const rssGrowth = growthMb(rssSamples)
  record(
    `Wasm runtime: ${CYCLES} compile/invoke/dispose cycles — heap growth bounded`,
    heapGrowth < 8,
    `heap ${heapGrowth >= 0 ? '+' : ''}${heapGrowth.toFixed(2)} MB`,
  )
  record(
    `Wasm runtime: ${CYCLES} compile/invoke/dispose cycles — RSS growth bounded`,
    rssGrowth < 20,
    `rss ${rssGrowth >= 0 ? '+' : ''}${rssGrowth.toFixed(2)} MB`,
  )
}

await fs.rm(sandbox, { recursive: true, force: true })

const failed = results.filter((item) => !item.pass)
console.log(`\n${results.length - failed.length}/${results.length} probes passed`)
process.exit(failed.length > 0 ? 1 : 0)

/**
 * Memory scale probe: 1 → 10 → 100 → 300 in-process WASM plugins.
 *
 * Measures, per tier: per-plugin RSS increment, plugin load latency, and
 * single-invoke latency (P50/P99) at that scale. Answers "几十/几百个插件的
 * 内存与延迟" for the recommended (in-process WASM) path.
 *
 * Run with --expose-gc:
 *   node --expose-gc performance-tests/probes/scale-wasm.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WasmRuntime } from '../../dist/index.js'

// gc() exists only under --expose-gc; degrade to a no-op otherwise.
const gc = globalThis.gc ?? (() => {})

const TIERS = [1, 10, 100, 300]
const WARMUP_INVOKE_SAMPLES = 200
const MEASURE_INVOKE_SAMPLES = 2000

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'perf-scale-wasm-'))

// One shared module file; N independent runtime instances (the realistic
// many-plugins shape: same engine, distinct instances/capabilities).
const templateWasm = await fs.readFile(
  path.resolve(import.meta.dirname, '../../examples/wasm-extension-template/plugin.wasm'),
)

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  return sorted[index]
}

const rows = []
let previousTier = null
const manager = new ExtensionManagerForProbe()

try {
  let previousRss = null

  for (const tier of TIERS) {
    // Grow from the previous tier to this tier.
    while (manager.count < tier) {
      const loadStart = performance.now()
      await manager.loadOne()
      manager.loadLatencies.push(performance.now() - loadStart)
    }

    gc()
    const rss = process.memoryUsage().rss
    const perPluginMb = previousRss === null
      ? null
      : (rss - previousRss) / (1024 * 1024) / (tier - (previousTier ?? 0))
    previousRss = rss

    // Warm the invoke path.
    for (let index = 0; index < WARMUP_INVOKE_SAMPLES; index += 1) {
      await manager.invokeAny(index)
    }

    const invokeSamples = []
    for (let index = 0; index < MEASURE_INVOKE_SAMPLES; index += 1) {
      const start = performance.now()
      await manager.invokeAny(index)
      invokeSamples.push(performance.now() - start)
    }

    const loadMedian = percentile(manager.loadLatencies, 0.5)
    rows.push({
      tier,
      rssMb: rss / (1024 * 1024),
      perPluginMb,
      loadMedianMs: loadMedian,
      invokeP50: percentile(invokeSamples, 0.5),
      invokeP99: percentile(invokeSamples, 0.99),
    })

    console.log(
      `plugins=${String(tier).padStart(4)}  rss=${(rss / (1024 * 1024)).toFixed(1).padStart(8)} MB`
      + `  Δ/plugin=${perPluginMb === null ? '   n/a' : perPluginMb.toFixed(2).padStart(6) + ' MB'}`
      + `  load P50=${loadMedian.toFixed(2).padStart(7)} ms`
      + `  invoke P50=${percentile(invokeSamples, 0.5).toFixed(3).padStart(7)} ms`
      + `  invoke P99=${percentile(invokeSamples, 0.99).toFixed(3).padStart(7)} ms`,
    )

    previousTier = tier
  }

  // Assertions: memory scales roughly linearly and stays modest; latency stays small.
  const worst = rows[rows.length - 1]
  assert.ok(worst.rssMb < 2048, `300-plugin RSS ${worst.rssMb.toFixed(0)} MB must stay under 2 GB`)
  const perPlugin = rows[rows.length - 1].perPluginMb
  assert.ok(perPlugin === null || perPlugin < 8, `per-plugin increment ${perPlugin?.toFixed(2)} MB must stay under 8 MB`)
  assert.ok(rows[rows.length - 1].invokeP99 < 5, `invoke P99 at ${worst.tier} plugins must stay under 5 ms`)
  console.log(`\nPASS: memory and latency scale within bounds (${TIERS.join(' → ')} plugins)`)
} finally {
  await manager.dispose()
  await fs.rm(sandbox, { recursive: true, force: true })
}

/**
 * Thin wrapper so the probe reads like a scale scenario; each "plugin" is an
 * independently instantiated module under a unique extension id.
 */
function ExtensionManagerForProbe() {
  const runtime = new WasmRuntime()
  const extensions = []
  const loadLatencies = []

  return {
    count: 0,
    loadLatencies,
    async loadOne() {
      const id = `perf.scale.plugin-${this.count + 1}`
      const pluginDir = path.join(sandbox, id)
      await fs.mkdir(pluginDir, { recursive: true })
      await fs.writeFile(path.join(pluginDir, 'plugin.wasm'), templateWasm)
      await fs.writeFile(path.join(pluginDir, 'extension.json'), JSON.stringify({
        id,
        version: '1.0.0',
        protocolVersion: '1',
        artifact: { kind: 'wasm', entry: './plugin.wasm' },
        runtime: 'wasm',
        capabilities: [{ name: 'addOne' }],
      }), 'utf8')

      const artifact = {
        entryPath: path.join(pluginDir, 'plugin.wasm'),
        command: path.join(pluginDir, 'plugin.wasm'),
        args: [],
        cwd: pluginDir,
        basePath: pluginDir,
      }
      const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, 'extension.json'), 'utf8'))
      const extension = await runtime.load(manifest, artifact)
      await extension.activate({ extensionId: id })
      extensions.push({ id, extension })
      this.count += 1
    },
    async invokeAny(value) {
      // Round-robin across all plugins: the realistic multi-plugin shape.
      const target = extensions[value % extensions.length]
      const output = await target.extension.invoke('addOne', value)
      assert.equal(output, value + 1)
    },
    async dispose() {
      for (const { extension } of extensions) {
        await extension.deactivate().catch(() => {})
      }
      extensions.length = 0
    },
  }
}

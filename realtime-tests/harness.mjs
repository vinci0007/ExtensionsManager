// ExtensionsManager Node realtime harness — measures the embedded kernel's
// frame-level data plane from a real Node host via N-API bindings.
//
// Scenarios:
//   S1  500 fps frame loop, 1 wasm plugin, 3 s        — per-call tick latency
//   S2  500 fps frame loop, 20 wasm plugins, 3 s      — per-frame aggregate cost
//   S3  async scheduler coexistence: a 100 ms boundary
//       plugin saturated on the async pool while the
//       healthy plugin keeps ticking                  — latency isolation
//
// The addon wraps the C ABI surface, so a Node host exercises the exact same
// embedded semantics as a native engine host. Run: node realtime-tests/harness.mjs
// (build first: cargo build -p extensions-kernel-napi --release)

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const harnessDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(harnessDir, '..')
const tmpRoot = path.join(projectRoot, '.tmp', 'realtime')
const addonStaged = path.join(harnessDir, 'kernel.node')
const addonBuilt = path.join(projectRoot, 'rust', 'target', 'release', 'extensions_kernel_napi.dll')

fs.mkdirSync(tmpRoot, { recursive: true })

// Stage the freshly built addon (in-project copy; rebuilt every run so the
// harness always exercises the current kernel).
fs.copyFileSync(addonBuilt, addonStaged)

const mod = { exports: {} }
process.dlopen(mod, addonStaged)
const kernel = mod.exports

// ---------------------------------------------------------------------------
// Kernel fixture helpers (JSON envelope surface, byte data plane)
// ---------------------------------------------------------------------------

const TICK_INPUT = Buffer.from(JSON.stringify({ batch: [{ t: 1 }] }))
const OUT_CAPACITY = 256

const ECHO_GUEST_WAT = `
(module
  (memory (export "memory") 1)
  (data (i32.const 4096) "{\\"ok\\":true}")
  (func (export "ext_call") (param i32) (param i32) (result i64)
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.const 4096)) (i64.const 32))
      (i64.extend_i32_u (i32.const 11))))
  (func (export "ext_tick") (param i32) (param i32) (result i64)
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.const 4096)) (i64.const 32))
      (i64.extend_i32_u (i32.const 11))))
)
`

function envelopeRequest(id, method, params) {
  const response = kernel.request(JSON.stringify({ kind: 'request', id, method, params }))
  if (response === null || response === undefined) {
    throw new Error(`transport failure on ${method}: ${kernel.lastError() ?? 'unknown'}`)
  }
  return response
}

function loadWasmPlugin(extensionId) {
  const entryPath = path.join(tmpRoot, `${extensionId.replace(/[^\w-]/g, '-')}.wat`).replace(/\\/g, '/')
  fs.writeFileSync(entryPath, ECHO_GUEST_WAT)
  const cwd = tmpRoot.replace(/\\/g, '/')
  envelopeRequest(`load-${extensionId}`, 'kernel.load', {
    manifest: {
      id: extensionId,
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'wasm', entry: `./${path.basename(entryPath)}` },
      runtime: 'wasm',
      capabilities: [{ name: 'dataplane' }],
    },
    runtime: { kind: 'wasm', entryPath, cwd },
    capabilities: [{
      name: 'dataplane',
      interactionMode: 'unary',
      executionMode: 'ephemeral',
      realtimeClass: 'batch',
      concurrencyPolicy: 'shared',
      resourceBudget: {},
    }],
    permissions: {},
    artifact: { entryPath: '.', command: '.', args: [], cwd: '.', basePath: '.', timeoutMs: 5000 },
    security: { signaturePolicy: 'allow-unsigned' },
  })
  envelopeRequest(`activate-${extensionId}`, 'kernel.activate', { extensionId, context: {} })
  const handle = kernel.handleResolve(extensionId)
  if (handle === null || handle === undefined) {
    throw new Error(`handle resolve failed for ${extensionId}`)
  }
  return handle
}

// The slow plugin is a boundary-runtime plugin launched by the KERNEL (per-plugin
// child process, already isolated and policy-gated); the harness only declares it.
function loadSlowPlugin(extensionId, delayMs) {
  const pluginDir = path.join(tmpRoot, extensionId.replace(/[^\w-]/g, '-'))
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ type: 'module' }))
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    [
      "import readline from 'node:readline'",
      'const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })',
      "rl.on('line', (line) => {",
      '  const request = JSON.parse(line)',
      "  if (request.method === 'extension/activate' || request.method === 'extension/invoke') {",
      `    const deadline = Date.now() + ${delayMs}`,
      '    while (Date.now() < deadline) { /* boundary burn */ }',
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { done: true } }) + '\\n')",
      '    return',
      '  }',
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }) + '\\n')",
      '})',
      '',
    ].join('\n'),
  )
  const cwd = pluginDir.replace(/\\/g, '/')
  envelopeRequest(`load-${extensionId}`, 'kernel.load', {
    manifest: {
      id: extensionId,
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'process',
      capabilities: [{ name: 'work' }],
    },
    runtime: { kind: 'process', command: 'node', args: ['./index.js'], cwd },
    capabilities: [{
      name: 'work',
      interactionMode: 'unary',
      executionMode: 'ephemeral',
      realtimeClass: 'batch',
      concurrencyPolicy: 'shared',
      resourceBudget: {},
    }],
    permissions: {},
    artifact: {
      entryPath: './index.js',
      command: 'node',
      args: ['./index.js'],
      cwd,
      basePath: cwd,
      timeoutMs: 60000,
    },
    security: { signaturePolicy: 'allow-unsigned' },
  })
  envelopeRequest(`activate-${extensionId}`, 'kernel.activate', { extensionId, context: {} })
}

// ---------------------------------------------------------------------------
// Frame loop + percentiles
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Frame pacing like a game loop: coarse sleep only when the deadline is far
// away, then yield-spin (setImmediate keeps the event loop alive and lets GC
// run) so the 2 ms cadence is not hostage to OS timer granularity. Expect one
// core saturated during the measurement windows — that is the point.
async function waitUntil(deadlineNs) {
  for (;;) {
    const now = process.hrtime.bigint()
    if (now >= deadlineNs) return
    const remainMs = Number(deadlineNs - now) / 1e6
    if (remainMs > 4) {
      await sleep(remainMs - 2)
    } else {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

async function runFrameLoop({ handles, hz, durationMs, onFrame }) {
  const frameNs = 1e9 / hz
  const outBuffers = handles.map(() => Buffer.alloc(OUT_CAPACITY))
  const deadlineNs = process.hrtime.bigint() + BigInt(durationMs) * 1_000_000n
  let next = process.hrtime.bigint()
  const callLatencies = []
  const frameDurations = []
  let calls = 0
  let failures = 0
  let integrityChecks = 0
  const decoder = new TextDecoder()

  while (process.hrtime.bigint() < deadlineNs) {
    const frameStart = process.hrtime.bigint()
    for (let i = 0; i < handles.length; i++) {
      const start = process.hrtime.bigint()
      const written = kernel.tickPtr(handles[i], TICK_INPUT, outBuffers[i])
      const elapsed = Number(process.hrtime.bigint() - start)
      calls += 1
      if (written < 0) {
        failures += 1
      } else {
        callLatencies.push(elapsed)
        // Data integrity spot check (every ~200 calls): the echo guest must
        // return the packed pointer/len of its static JSON payload.
        integrityChecks += 1
        if (integrityChecks % 200 === 0) {
          const text = decoder.decode(Uint8Array.prototype.slice.call(outBuffers[i], 0, written))
          if (!text.includes('"ok":true')) throw new Error(`data integrity failure: ${text}`)
        }
      }
    }
    const frameDuration = Number(process.hrtime.bigint() - frameStart)
    frameDurations.push(frameDuration)
    if (typeof onFrame === 'function') onFrame(frameDuration)

    next += BigInt(Math.round(frameNs))
    const now = process.hrtime.bigint()
    if (now > next + BigInt(Math.round(frameNs))) {
      // Fell behind by more than one frame (GC/timer stall): reschedule from
      // now instead of bursting to catch up.
      next = process.hrtime.bigint()
    } else if (next > now) {
      await waitUntil(next)
    }
  }

  return { calls, failures, callLatencies, frameDurations }
}

function percentile(sorted, fraction) {
  const index = Math.round((sorted.length - 1) * fraction)
  return sorted[Math.min(index, sorted.length - 1)]
}

function summarize(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b)
  return {
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    p999: percentile(sorted, 0.999),
    max: sorted[sorted.length - 1] ?? 0,
    n: sorted.length,
  }
}

const fmtUs = (ns) => `${(ns / 1000).toFixed(2)} µs`

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

kernel.reset()

const HZ = 500
const SCENARIO_MS = 3000

const scenarioResults = []

// S1 — single plugin baseline.
{
  const handles = [loadWasmPlugin('rt.single')]
  const run = await runFrameLoop({ handles, hz: HZ, durationMs: SCENARIO_MS })
  const summary = summarize(run.callLatencies)
  scenarioResults.push({
    name: 'S1 · 500 fps × 1 plugin',
    run,
    summary,
    frameSummary: summarize(run.frameDurations),
  })
  kernel.handleRelease(handles[0])
}

// S2 — twenty plugins, aggregate per-frame cost.
{
  const handles = []
  for (let i = 0; i < 20; i++) handles.push(loadWasmPlugin(`rt.multi.${i}`))
  const run = await runFrameLoop({ handles, hz: HZ, durationMs: SCENARIO_MS })
  const summary = summarize(run.callLatencies)
  scenarioResults.push({
    name: 'S2 · 500 fps × 20 plugins',
    run,
    summary,
    frameSummary: summarize(run.frameDurations),
  })
  for (const handle of handles) kernel.handleRelease(handle)
}

// S3 — async scheduler coexistence: healthy plugin ticks while a 100 ms
// boundary plugin is saturated on the async pool (opt-in policy).
{
  kernel.installResponseSink()
  envelopeRequest('policy-sched', 'kernel.policy.set', {
    scheduler: { asyncPoolThreads: 2, queueCap: 8 },
  })
  loadSlowPlugin('rt.slow', 100)
  const healthy = loadWasmPlugin('rt.healthy')

  const inputJson = JSON.stringify({ capability: 'dataplane', input: {} })
  const invokeInput = Buffer.from(inputJson)

  // Phase A: baseline window (no async pressure).
  const baselineRun = await runFrameLoop({ handles: [healthy], hz: HZ, durationMs: 1500 })
  const baseline = summarize(baselineRun.callLatencies)

  // Phase B: pressure window — fire one slow kernel.invoke every 250 ms; each
  // must come back as an async ACCEPTED marker (µs), with the boundary burn
  // happening on the kernel's scheduler workers, not the JS thread.
  let fired = 0
  let accepted = 0
  const maxAcceptNs = { value: 0 }
  const drainResults = { delivered: 0 }
  const fireSlowInvoke = () => {
    const start = process.hrtime.bigint()
    const response = envelopeRequest(`slow-${fired}`, 'kernel.invoke', {
      extensionId: 'rt.slow',
      capability: 'work',
      input: {},
    })
    const acceptNs = Number(process.hrtime.bigint() - start)
    fired += 1
    if (response.includes('"accepted":true')) accepted += 1
    if (acceptNs > maxAcceptNs.value) maxAcceptNs.value = acceptNs
  }

  const slowIds = []
  const pressureRun = await runFrameLoop({
    handles: [healthy],
    hz: HZ,
    durationMs: 3000,
    onFrame: (() => {
      let nextFireAt = 0
      return () => {
        if (fired < 8 && Date.now() >= nextFireAt) {
          fireSlowInvoke()
          slowIds.push(`slow-${fired - 1}`)
          nextFireAt = Date.now() + 250
        }
      }
    })(),
  })
  const pressure = summarize(pressureRun.callLatencies)

  // Drain the async envelopes (workers deliver through the response sink).
  const drainDeadline = Date.now() + 5000
  const delivered = []
  while (delivered.length < slowIds.length && Date.now() < drainDeadline) {
    delivered.push(...kernel.drainAsyncResponses())
    await sleep(5)
  }
  drainResults.delivered = delivered.length
  const missingId = slowIds.find((id) => !delivered.some((envelope) => envelope.includes(`"id":"${id}"`)))

  // Phase C: recovery window.
  const recoveryRun = await runFrameLoop({ handles: [healthy], hz: HZ, durationMs: 1000 })
  const recovery = summarize(recoveryRun.callLatencies)

  const offsetPct = ((pressure.p99 - baseline.p99) / Math.max(baseline.p99, 1)) * 100
  scenarioResults.push({
    name: 'S3 · async coexistence (100 ms boundary plugin)',
    run: pressureRun,
    summary: pressure,
    frameSummary: summarize(pressureRun.frameDurations),
    extra: {
      baselineP99: baseline.p99,
      recoveryP99: recovery.p99,
      offsetPct,
      slowInvokesFired: fired,
      slowInvokesAccepted: accepted,
      maxAcceptMs: maxAcceptNs.value / 1e6,
      envelopesDelivered: drainResults.delivered,
      missingId: missingId ?? null,
    },
  })
  kernel.handleRelease(healthy)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const frameBudgetNs = 1e9 / HZ
const lines = []
lines.push('# Node realtime harness report')
lines.push('')
lines.push(`- Node: ${process.version} · platform: ${process.platform} ${process.arch}`)
lines.push(`- Addon: extensions-kernel-napi (C ABI wrapper, release build) · abi ${kernel.abiVersion()}`)
lines.push(`- Cadence: ${HZ} fps (frame budget ${(frameBudgetNs / 1e6).toFixed(2)} ms) · tick data plane (ext_tick byte path)`)
lines.push('')

for (const result of scenarioResults) {
  lines.push(`## ${result.name}`)
  lines.push('')
  const { run, summary, frameSummary } = result
  lines.push(`- tick calls: ${run.calls} (failures: ${run.failures}) · frames: ${run.frameDurations.length} · overruns(>budget): ${run.frameDurations.filter((ns) => ns > frameBudgetNs).length}`)
  lines.push(`- tick latency: p50 ${fmtUs(summary.p50)} · p90 ${fmtUs(summary.p90)} · p99 ${fmtUs(summary.p99)} · p999 ${fmtUs(summary.p999)} · max ${fmtUs(summary.max)}`)
  lines.push(`- whole-frame JS time: p50 ${fmtUs(frameSummary.p50)} · p99 ${fmtUs(frameSummary.p99)} · max ${fmtUs(frameSummary.max)}`)
  if (result.extra) {
    const extra = result.extra
    lines.push(`- healthy P99: baseline ${fmtUs(extra.baselineP99)} → under async-slow pressure ${fmtUs(summary.p99)} (**offset ${extra.offsetPct.toFixed(2)}%**) → recovery ${fmtUs(extra.recoveryP99)}`)
    lines.push(`- slow kernel.invoke: ${extra.slowInvokesAccepted}/${extra.slowInvokesFired} accepted as async markers (worst accept ${extra.maxAcceptMs.toFixed(3)} ms)`)
    lines.push(`- async envelopes delivered via sink: ${extra.envelopesDelivered}/${extra.slowInvokesFired}${extra.missingId ? ` · MISSING ${extra.missingId}` : ''}`)
  }
  lines.push('')
}

const report = lines.join('\n')
fs.writeFileSync(path.join(harnessDir, 'REPORT.md'), report)
console.log(report)

// Acceptance (informational harness guards — generous absolute budgets because
// a dev machine is not a bench; the strict numbers live in the Rust tests):
const failures = []
for (const result of scenarioResults) {
  if (result.run.failures > 0) failures.push(`${result.name}: ${result.run.failures} failed tick calls`)
}
const s3 = scenarioResults[2]
if (s3) {
  if (s3.extra.slowInvokesAccepted !== s3.extra.slowInvokesFired) failures.push('S3: some slow invokes did not return the async accepted marker')
  if (s3.extra.envelopesDelivered !== s3.extra.slowInvokesFired) failures.push('S3: async envelopes missing on the sink')
  if (s3.summary.p99 > 1_000_000) failures.push(`S3: healthy P99 under pressure ${fmtUs(s3.summary.p99)} exceeded the 1 ms harness guard`)
}
if (failures.length > 0) {
  console.error(`REALTIME HARNESS FAILED:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('REALTIME HARNESS: all scenarios passed their guards.')
}

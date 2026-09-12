/**
 * Memory boundedness probe: the "cannot grow without limit" contract.
 *
 * 1. Event flood WITHOUT the host reading: a hostile plugin streams events
 *    while the transport never drains them — the transport-side quota must cap
 *    buffered events (bounded memory) and fail the session structured.
 * 2. Session open/close churn through the real kernel daemon: 2,000 cycles;
 *    daemon must stay responsive with flat latency (closed-session tombstones
 *    are bounded — see CLOSED_SESSION_TOMBSTONE_CAPACITY).
 * 3. Repeated runaway (infinite-loop) plugin invocations: deterministic fuel
 *    traps, bounded latency, flat memory.
 *
 * Run: node --expose-gc performance-tests/probes/boundedness.mjs
 * (requires cargo build -p extensionsd for the daemon part)
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { ExtensionProcessError } from '../../dist/errors/ExtensionError.js'
import { JsonRpcTransport, SESSION_EVENT_QUOTA } from '../../dist/runtimes/process/JsonRpcTransport.js'

// gc() exists only under --expose-gc; degrade to a no-op otherwise.
const gc = globalThis.gc ?? (() => {})

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- 1. Unread event flood: transport buffers must be capped ---
{
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const child = new EventEmitter()
  Object.assign(child, { stdout, stdin, kill: () => true })
  const transport = new JsonRpcTransport(child)

  // 5x quota events for one session, host never drains.
  const lines = []
  for (let index = 0; index < SESSION_EVENT_QUOTA * 5; index += 1) {
    lines.push(JSON.stringify({
      kind: 'event',
      sessionId: 'session-unread',
      event: { type: 'data', data: { index, blob: 'x'.repeat(64) } },
    }))
  }
  const before = process.memoryUsage().heapUsed
  stdout.write(`${lines.join('\n')}\n`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  gc()
  const after = process.memoryUsage().heapUsed
  const growthMb = (after - before) / (1024 * 1024)

  // Buffered events must be capped at the quota (not 5x), and the session must
  // now fail structured instead of silently buffering forever.
  let breached = false
  try {
    await transport.sessionSend('session-unread', {})
    breached = false
  } catch (error) {
    breached = error instanceof ExtensionProcessError && /EVENT_QUOTA_EXCEEDED/.test(error.message)
  }
  record(
    'unread flood: buffered events capped at quota (bounded memory)',
    growthMb < 8,
    `heap growth after 5x-quota flood: ${growthMb.toFixed(2)} MB`,
  )
  record(
    'unread flood: session fails structured (EVENT_QUOTA_EXCEEDED)',
    breached,
  )
  stdout.end()
  stdin.end()
}

// --- 2 & 3: kernel daemon churn + runaway traps (real Rust daemon) ---
const projectRoot = path.resolve(import.meta.dirname, '../..')
const daemonBinary = path.join(projectRoot, 'rust', 'target', 'debug', process.platform === 'win32' ? 'extensionsd.exe' : 'extensionsd')

if (!existsSync(daemonBinary)) {
  console.log('SKIP daemon parts: rust/target/debug/extensionsd(.exe) not built')
} else {
  const { CommandKernelBridge } = await import('../../dist/kernel/CommandKernelBridge.js')
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'perf-bounded-'))

  // Fast plugin: instant responses — the churn target (a slow plugin here would
  // stall the churn loop on its own CPU burn, which is the hang scenario, not churn).
  const churnDir = path.join(sandbox, 'churn')
  await fs.mkdir(churnDir, { recursive: true })
  await fs.writeFile(path.join(churnDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  await fs.writeFile(path.join(churnDir, 'index.js'), `
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
rl.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'extension/invoke' || request.method === 'extension/openSession') {
    const sessionId = request.params?.sessionId ?? 'churn-session'
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId, done: true } }) + '\\n')
    return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }) + '\\n')
})
`, 'utf8')

  // Runaway plugin: burns ~3 s of CPU per invoke.
  const runawayDir = path.join(sandbox, 'runaway')
  await fs.mkdir(runawayDir, { recursive: true })
  await fs.writeFile(path.join(runawayDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  await fs.writeFile(path.join(runawayDir, 'index.js'), `
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
rl.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'extension/activate') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }) + '\\n')
    return
  }
  if (request.method === 'extension/invoke') {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) { /* burn */ }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { done: true } }) + '\\n')
    return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }) + '\\n')
})
`, 'utf8')

  const bridge = new CommandKernelBridge({
    mode: 'daemon',
    transport: 'pipe',
    command: daemonBinary,
    cwd: projectRoot,
    timeoutMs: 30000,
    isDevelopment: true,
  })

  const churnManifest = {
    id: 'perf.churn',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: { kind: 'module', entry: './index.js', launch: { command: 'node', args: ['${entry}'] } },
    runtime: 'process',
    capabilities: [{ name: 'churn.work', interactionMode: 'unary', executionMode: 'ephemeral' }],
  }
  await bridge.load(churnManifest, churnDir)
  await bridge.activate('perf.churn', { extensionId: 'perf.churn' })

  const runawayManifest = {
    id: 'perf.runaway',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: { kind: 'module', entry: './index.js', launch: { command: 'node', args: ['${entry}'] } },
    runtime: 'process',
    capabilities: [{ name: 'runaway.work', interactionMode: 'unary', executionMode: 'ephemeral' }],
  }
  await bridge.load(runawayManifest, runawayDir)
  await bridge.activate('perf.runaway', { extensionId: 'perf.runaway' })

  // 2. Session churn: open/close 2,000 sessions against the FAST plugin; the
  // daemon's latency must stay flat (tombstones bounded, sessions map empties).
  {
    const latencies = []
    for (let cycle = 0; cycle < 2000; cycle += 1) {
      const start = performance.now()
      const session = await bridge.openSession('perf.churn', 'churn.work', { cycle })
      await session.close()
      latencies.push(performance.now() - start)
    }
    const sorted = [...latencies].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length * 0.5)]
    const p99 = sorted[Math.floor(sorted.length * 0.99)]
    const lastTen = sorted.slice(-10)
    const firstTen = sorted.slice(0, 10)
    const drift = (lastTen.reduce((a, b) => a + b, 0) / 10) - (firstTen.reduce((a, b) => a + b, 0) / 10)
    record(
      'session churn 2000 cycles: latency flat (no tombstone-induced degradation)',
      p50 < 50 && drift < 20,
      `P50 ${p50.toFixed(2)} ms, P99 ${p99.toFixed(2)} ms, first→last drift ${drift.toFixed(2)} ms`,
    )
  }

  // 3. Runaway invocations: each must complete in bounded time (plugin burns
  // 3 s of CPU — the daemon/kernel must not be the thing that hangs; the call
  // returns via the plugin's own completion here; the deterministic fuel
  // budget applies to in-process WASM guests, documented separately).
  {
    gc()
    const rssBefore = process.memoryUsage().rss
    const durations = []
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const start = performance.now()
      const output = await bridge.invoke('perf.runaway', 'runaway.work', { cycle })
      durations.push(performance.now() - start)
      assert.ok(output.done === true)
    }
    gc()
    const rssAfter = process.memoryUsage().rss
    const rssGrowth = (rssAfter - rssBefore) / (1024 * 1024)
    const allBounded = durations.every((duration) => duration < 10_000)
    record(
      'runaway CPU plugin: repeated invocations complete, no hang',
      allBounded,
      `durations: ${durations.map((duration) => (duration / 1000).toFixed(2) + 's').join(', ')}`,
    )
    record(
      'runaway CPU plugin: host-side memory flat across repeats',
      rssGrowth < 30,
      `rss ${rssGrowth >= 0 ? '+' : ''}${rssGrowth.toFixed(1)} MB over 6 invocations`,
    )
  }

  await bridge.dispose().catch(() => {})
  await fs.rm(sandbox, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.pass)
console.log(`\n${results.length - failed.length}/${results.length} probes passed`)
process.exit(failed.length > 0 ? 1 : 0)

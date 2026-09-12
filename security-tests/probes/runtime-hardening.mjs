/**
 * Security probe: in-process WASM memory-bomb resistance + SSRF status-probe
 * blocking + secure-by-default signature policy + outbound-egress accounting.
 *
 * All targets are loopback or documentation-only hosts; the SSRF probe asserts
 * the guard rejects BEFORE any network I/O would happen (no packet can leave).
 * Run: node security-tests/probes/runtime-hardening.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { ExtensionManager, NodeRuntime, WasmRuntime } from '../../dist/index.js'
import { assertWasmMemoryWithinQuota } from '../../dist/security/wasmModuleLimits.js'

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- Egress accounting: watch every fetch the library makes during this probe ---
const egressLog = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input)
  egressLog.push(url)
  return originalFetch(input, init)
}

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'security-probe-runtime-'))

try {
  // --- Probe A: wasm memory bomb (300 pages > 256-page quota) ---
  const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  const leb = (value) => {
    const bytes = []
    let current = value
    for (;;) {
      let byte = current & 0x7f
      current = Math.floor(current / 128)
      if (current !== 0) byte |= 0x80
      bytes.push(byte)
      if (current === 0) return bytes
    }
  }
  const payload = [0x01, 0x01, ...leb(300), ...leb(300)]
  const bombBytes = new Uint8Array([...WASM_HEADER, 0x05, ...leb(payload.length), ...payload])
  try {
    assertWasmMemoryWithinQuota(bombBytes)
    record('wasm memory bomb (300 pages) rejected', false, 'guard did not throw')
  } catch (error) {
    record('wasm memory bomb (300 pages) rejected', /quota/.test(error.message), error.message)
  }

  // Unbounded declaration must also be rejected.
  const unboundedPayload = [0x01, 0x00, ...leb(64)]
  const unbounded = new Uint8Array([...WASM_HEADER, 0x05, ...leb(unboundedPayload.length), ...unboundedPayload])
  try {
    assertWasmMemoryWithinQuota(unbounded)
    record('unbounded wasm memory declaration rejected', false, 'guard did not throw')
  } catch (error) {
    record('unbounded wasm memory declaration rejected', /unbounded/.test(error.message), error.message)
  }

  // --- Probe B: secure-by-default — unconfigured manager refuses unsigned plugin ---
  const unsignedPluginDir = path.join(sandbox, 'unsigned-plugin')
  await fs.mkdir(unsignedPluginDir, { recursive: true })
  await fs.writeFile(path.join(unsignedPluginDir, 'extension.json'), JSON.stringify({
    id: 'probe.unsigned',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: { kind: 'module', entry: './index.js' },
    runtime: 'node',
    capabilities: [{ name: 'demo.hello' }],
  }), 'utf8')
  await fs.writeFile(path.join(unsignedPluginDir, 'index.js'), "export default { capabilities: { 'demo.hello': async () => ({ ok: true }) } }", 'utf8')

  const strictManager = new ExtensionManager()
  strictManager.registerRuntime(new NodeRuntime())
  try {
    await strictManager.loadManifestFile(unsignedPluginDir)
    record('unconfigured manager rejects unsigned plugin (secure default)', false, 'load unexpectedly succeeded')
  } catch (error) {
    const cause = error?.cause?.message ?? error.message
    record('unconfigured manager rejects unsigned plugin (secure default)', /signature required by policy/.test(cause), cause)
  }
  await strictManager.dispose().catch(() => {})

  // Development declaration opens the door (documented opt-in path).
  const devManager = new ExtensionManager({ isDevelopment: true })
  devManager.registerRuntime(new NodeRuntime())
  try {
    await devManager.loadManifestFile(unsignedPluginDir)
    record('isDevelopment declaration allows the same plugin', true)
  } catch (error) {
    record('isDevelopment declaration allows the same plugin', false, error.message)
  }
  await devManager.dispose().catch(() => {})

  // --- Probe C: SSRF — manifest status probe at private address must be blocked ---
  const privateProbeDir = path.join(sandbox, 'private-probe')
  await fs.mkdir(privateProbeDir, { recursive: true })
  await fs.writeFile(path.join(privateProbeDir, 'extension.json'), JSON.stringify({
    id: 'probe.ssrf',
    version: '1.0.0',
    protocolVersion: '1',
    metadata: {
      statusCheck: { kind: 'url', endpoint: 'http://10.203.0.7:9/health', method: 'GET', timeoutMs: 250 },
    },
    artifact: { kind: 'module', entry: './index.js' },
    runtime: 'node',
    capabilities: [{ name: 'demo.hello' }],
  }), 'utf8')
  await fs.writeFile(path.join(privateProbeDir, 'index.js'), "export default { capabilities: { 'demo.hello': async () => ({ ok: true }) } }", 'utf8')

  const ssrfManager = new ExtensionManager({ isDevelopment: true })
  ssrfManager.registerRuntime(new NodeRuntime())
  await ssrfManager.loadManifestFile(privateProbeDir)
  const status = await ssrfManager.checkStatus('probe.ssrf')
  record(
    'status probe to private 10.x host blocked before any network I/O',
    status.state === 'unavailable' && /not allowed/.test(status.reason ?? ''),
    status.reason,
  )
  await ssrfManager.dispose().catch(() => {})

  // --- Probe D: outbound egress accounting ---
  // Every fetch issued during this probe must target loopback only. The private
  // SSRF target above must NOT appear (it was blocked pre-network).
  const nonLoopback = egressLog.filter((url) => !/https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url))
  record(
    'egress audit: all fetch targets loopback-only, private probe never reached network',
    nonLoopback.length === 0 && !egressLog.some((url) => url.includes('10.203.0.7')),
    `targets seen: ${JSON.stringify([...new Set(egressLog.map((url) => new URL(url).host))])}`,
  )
} finally {
  globalThis.fetch = originalFetch
  await fs.rm(sandbox, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.pass)
console.log(`\n${results.length - failed.length}/${results.length} probes passed`)
process.exit(failed.length > 0 ? 1 : 0)

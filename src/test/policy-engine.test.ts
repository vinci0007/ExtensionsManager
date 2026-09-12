/**
 * Phase A policy-engine tests (TypeScript side): local admission mirror and
 * daemon policy forwarding.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ExtensionManifest } from '../index.js'
import { CommandKernelBridge, ExtensionManager, NodeRuntime } from '../index.js'

const root = path.resolve(import.meta.dirname ?? '.', '../..')
const rustKernelDaemonBinaryPath = path.join(
  root,
  'rust',
  'target',
  'debug',
  process.platform === 'win32' ? 'extensionsd.exe' : 'extensionsd',
)

function buildManifest(
  id: string,
  memoryMb: number,
  realtimeClass: 'batch' | 'realtime',
  extensionClass?: 'transient' | 'standard' | 'resident',
): ExtensionManifest {
  return {
    id,
    version: '1.0.0',
    protocolVersion: '1',
    extensionClass,
    artifact: { kind: 'module', entry: './index.js' },
    runtime: 'node',
    capabilities: [{
      name: 'demo.work',
      realtimeClass,
      resourceBudget: { memoryMb },
    }],
  }
}

test('local admission rejects declarations over the tier cap', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-local-'))
  try {
    const manager = new ExtensionManager({
      isDevelopment: true,
      policy: { memory: { tiers: { realtimeMb: 32 } } },
    })
    manager.registerRuntime(new NodeRuntime())

    await assert.rejects(
      () => manager.load(buildManifest('demo.policy.over', 64, 'realtime'), sandbox),
      (error: unknown) => {
        const cause = (error as { cause?: Error }).cause
        assert.match(cause?.message ?? '', /exceeds the realtime tier cap 32 MB/)
        return true
      },
    )
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('local admission admits declarations within the tier cap', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-local-within-'))
  await fs.writeFile(path.join(sandbox, 'index.js'), "export default { capabilities: { 'demo.work': async () => ({ ok: true }) } }", 'utf8')
  try {
    const manager = new ExtensionManager({
      isDevelopment: true,
      policy: { memory: { tiers: { realtimeMb: 32 } } },
    })
    manager.registerRuntime(new NodeRuntime())

    const extension = await manager.load(buildManifest('demo.policy.within', 16, 'realtime'), sandbox)
    assert.equal(extension.id, 'demo.policy.within')
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('daemon forwards policy and survives an admission rejection', { skip: !process.env.POLICY_E2E }, async () => {
  // Skipped by default: requires the built extensionsd binary. Run with
  // POLICY_E2E=1 after `cargo build -p extensionsd`.
  if (!process.env.POLICY_E2E) {
    return
  }

  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-daemon-'))
  const bridge = new CommandKernelBridge({
    mode: 'daemon',
    transport: 'pipe',
    command: rustKernelDaemonBinaryPath,
    cwd: root,
    timeoutMs: 15000,
    isDevelopment: true,
    policy: { memory: { tiers: { realtimeMb: 32 } } },
  })

  try {
    const pluginDir = path.join(sandbox, 'plugin')
    await fs.mkdir(pluginDir, { recursive: true })
    const manifest = buildManifest('demo.policy.daemon', 64, 'realtime')
    await fs.writeFile(path.join(pluginDir, 'extension.json'), JSON.stringify(manifest), 'utf8')

    await assert.rejects(
      () => bridge.load(manifest, pluginDir),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        const cause = (error as { cause?: Error }).cause
        assert.match(cause?.message ?? message, /exceeds the realtime tier cap 32 MB/)
        return true
      },
    )

    // Daemon survives: a within-cap load succeeds afterwards.
    const within = buildManifest('demo.policy.daemon-within', 16, 'realtime')
    await fs.writeFile(path.join(pluginDir, 'within.json'), JSON.stringify(within), 'utf8')
    await bridge.load(within, pluginDir)
  } finally {
    await bridge.dispose().catch(() => {})
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('resident class: local mirror enforces declaration and host budget', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-resident-'))
  await fs.writeFile(path.join(sandbox, 'index.js'), "export default { capabilities: { 'demo.work': async () => ({ ok: true }) } }", 'utf8')
  try {
    // Resident without a host total budget → rejected.
    const noBudgetManager = new ExtensionManager({
      isDevelopment: true,
      policy: { memory: { tiers: { realtimeMb: 64 } } },
    })
    noBudgetManager.registerRuntime(new NodeRuntime())
    await assert.rejects(
      () => noBudgetManager.load(buildManifest('demo.rc.nobudget', 64, 'realtime', 'resident'), sandbox),
      (error: unknown) => {
        const cause = (error as { cause?: Error }).cause
        assert.match(cause?.message ?? '', /policy\.memory\.totalMb/)
        return true
      },
    )
    await noBudgetManager.dispose()

    // With a budget but no declared peak → rejected.
    const noDeclareManager = new ExtensionManager({
      isDevelopment: true,
      policy: { memory: { totalMb: 128 } },
    })
    noDeclareManager.registerRuntime(new NodeRuntime())
    await assert.rejects(
      () => noDeclareManager.load(buildManifest('demo.rc.nodeclare', 0, 'realtime', 'resident'), sandbox),
      (error: unknown) => {
        const cause = (error as { cause?: Error }).cause
        assert.match(cause?.message ?? '', /must declare resourceBudget\.memoryMb/)
        return true
      },
    )
    await noDeclareManager.dispose()

    // Declaration over the total budget → rejected.
    const overManager = new ExtensionManager({
      isDevelopment: true,
      policy: { memory: { totalMb: 32 } },
    })
    overManager.registerRuntime(new NodeRuntime())
    await assert.rejects(
      () => overManager.load(buildManifest('demo.rc.over', 64, 'realtime', 'resident'), sandbox),
      (error: unknown) => {
        const cause = (error as { cause?: Error }).cause
        assert.match(cause?.message ?? '', /exceeds the host memory budget \(32 MB total\)/)
        return true
      },
    )
    await overManager.dispose()

    // Within budget → admitted (schema accepts extensionClass + fuelPerTick).
    const withinManager = new ExtensionManager({
      isDevelopment: true,
      policy: { memory: { totalMb: 128 } },
    })
    withinManager.registerRuntime(new NodeRuntime())
    const manifest = buildManifest('demo.rc.within', 64, 'realtime', 'resident')
    manifest.capabilities[0].resourceBudget!.fuelPerTick = 50000
    const extension = await withinManager.load(manifest, sandbox)
    assert.equal(extension.id, 'demo.rc.within')
    await withinManager.dispose()
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

test('consent flow: no handler / deny / approve three states', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-consent-'))
  await fs.writeFile(path.join(sandbox, 'index.js'), "export default { capabilities: { 'demo.work': async () => ({ ok: true }) } }", 'utf8')
  try {
    // 1. No handler → fail-closed with an explicit reason.
    const noHandler = new ExtensionManager({
      isDevelopment: true,
      policy: { memory: { tiers: { realtimeMb: 32 } } },
    })
    noHandler.registerRuntime(new NodeRuntime())
    await assert.rejects(
      () => noHandler.load(buildManifest('demo.consent.nohandler', 64, 'realtime'), sandbox),
      (error: unknown) => {
        const cause = (error as { cause?: Error }).cause
        assert.match(cause?.message ?? '', /rejected: no consent handler configured/)
        return true
      },
    )
    await noHandler.dispose()

    // 2. Handler denies → rejected with the handler reason.
    const denying = new ExtensionManager({
      isDevelopment: true,
      policy: { memory: { tiers: { realtimeMb: 32 } } },
      onPolicyConsent: async () => false,
    })
    denying.registerRuntime(new NodeRuntime())
    await assert.rejects(
      () => denying.load(buildManifest('demo.consent.deny', 64, 'realtime'), sandbox),
      (error: unknown) => {
        const cause = (error as { cause?: Error }).cause
        assert.match(cause?.message ?? '', /rejected by consent handler/)
        return true
      },
    )
    await denying.dispose()

    // 3. Handler approves → the load proceeds.
    let consentRequest: unknown
    const approving = new ExtensionManager({
      isDevelopment: true,
      policy: { memory: { tiers: { realtimeMb: 32 } } },
      onPolicyConsent: async (request) => {
        consentRequest = request
        return true
      },
    })
    approving.registerRuntime(new NodeRuntime())
    const extension = await approving.load(buildManifest('demo.consent.approve', 64, 'realtime'), sandbox)
    assert.equal(extension.id, 'demo.consent.approve')
    const request = consentRequest as { type: string; declaredMb: number; capMb: number }
    assert.equal(request.type, 'memoryTierOverflow')
    assert.equal(request.declaredMb, 64)
    assert.equal(request.capMb, 32)
    await approving.dispose()
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
})

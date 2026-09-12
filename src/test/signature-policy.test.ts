import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { ExtensionManifest } from '../index.js'
import { enforceSignaturePolicy, ExtensionManager, NodeRuntime, shouldRequireSignature } from '../index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const unsignedManifest: ExtensionManifest = {
  id: 'demo.unsigned',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: { kind: 'module', entry: './index.js' },
  runtime: 'node',
  capabilities: [{ name: 'demo.hello' }],
}

test('requires signature when policy is strict', () => {
  assert.throws(
    () => enforceSignaturePolicy(unsignedManifest, 'require-signature', false),
    /Extension signature required by policy/,
  )
})

test('allows unsigned manifests in development exception mode', () => {
  enforceSignaturePolicy(unsignedManifest, 'require-signature-except-development', true)
  assert.equal(shouldRequireSignature('require-signature-except-development', true), false)
})

test('unconfigured policy defaults to require-signature-except-development (fail-closed in production)', () => {
  // The evaluator applies this default when the host configures nothing; the
  // helper-level contract: unknown values must fail closed.
  assert.equal(shouldRequireSignature('require-signature-except-development' as never, false), true)
  assert.equal(shouldRequireSignature('require-signature-except-development' as never, true), false)
})

test('unknown policy strings fail closed regardless of development mode', () => {
  assert.equal(shouldRequireSignature('allow-unsigend-typo' as never, false), true)
  assert.equal(shouldRequireSignature('allow-unsigend-typo' as never, true), true)
  assert.throws(
    () => enforceSignaturePolicy(unsignedManifest, 'allow-unsigend-typo' as never, true),
    /Extension signature required by policy/,
  )
})

test('unconfigured manager rejects the unsigned shipped example (secure default end-to-end)', async () => {
  const manager = new ExtensionManager()
  manager.registerRuntime(new NodeRuntime())

  await assert.rejects(
    () => manager.loadManifestFile(path.join(root, 'examples/node-extension')),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      const cause = (error as { cause?: Error }).cause
      assert.match(
        cause?.message ?? message,
        /Extension signature required by policy/,
      )
      assert.match(message, /Failed to load extension/)
      return true
    },
  )

  await manager.dispose()
})

test('unconfigured manager accepts the unsigned example once development is declared', async () => {
  const manager = new ExtensionManager({ isDevelopment: true })
  manager.registerRuntime(new NodeRuntime())

  const extension = await manager.loadManifestFile(path.join(root, 'examples/node-extension'))
  assert.equal(extension.id, 'demo.node-extension')

  await manager.dispose()
})

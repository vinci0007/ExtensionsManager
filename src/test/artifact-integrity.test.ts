import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { ExtensionManifest } from '../index.js'
import { computeFileSha256, verifyArtifactIntegrity } from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '../../')
const artifactPath = path.join(root, 'examples/node-extension/index.js')

test('verifies real artifact integrity', async () => {
  const integrity = await computeFileSha256(artifactPath)
  const manifest: ExtensionManifest = {
    id: 'demo.integrity',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: {
      kind: 'module',
      entry: './index.js',
      integrity,
    },
    runtime: 'node',
    capabilities: [{ name: 'demo.hello' }],
  }

  await verifyArtifactIntegrity(manifest, artifactPath)
  assert.ok(true)
})

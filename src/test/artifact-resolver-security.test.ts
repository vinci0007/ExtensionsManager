import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ArtifactResolver } from '../core/ArtifactResolver.js'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'

function buildManifest(overrides: Partial<ExtensionManifest['artifact']['launch']> = {}): ExtensionManifest {
  return {
    id: 'demo.fence',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: {
      kind: 'module',
      entry: './index.js',
      ...(Object.keys(overrides).length > 0 ? { launch: overrides } : {}),
    },
    runtime: 'process',
    capabilities: [{ name: 'demo.hello' }],
  }
}

test('resolves a normal relative entry exactly as before', () => {
  const basePath = path.join(os.tmpdir(), 'fence-base')
  const artifact = new ArtifactResolver().resolve(buildManifest(), basePath)

  assert.equal(artifact.entryPath, path.resolve(basePath, 'index.js'))
  assert.equal(artifact.cwd, basePath)
})

test('rejects relative entries that escape the plugin directory', () => {
  const basePath = path.join(os.tmpdir(), 'fence-base')

  assert.throws(
    () => new ArtifactResolver().resolve(
      { ...buildManifest(), artifact: { ...buildManifest().artifact, entry: '../index.js' } },
      basePath,
    ),
    /Artifact entry escapes plugin directory/,
  )
})

test('rejects relative launch commands that escape the plugin directory', () => {
  const basePath = path.join(os.tmpdir(), 'fence-base')

  assert.throws(
    () => new ArtifactResolver().resolve(buildManifest({ command: '../elsewhere/plugin' }), basePath),
    /Artifact command escapes plugin directory/,
  )
})

test('rejects absolute entries outside the plugin directory', () => {
  const basePath = path.join(os.tmpdir(), 'fence-base')
  const outside = path.resolve(basePath, '..', 'outside.js')

  assert.throws(
    () => new ArtifactResolver().resolve(
      {
        ...buildManifest(),
        artifact: { ...buildManifest().artifact, entry: outside },
      },
      basePath,
    ),
    /Artifact entry escapes plugin directory/,
  )
})

test('allows absolute entries inside the plugin directory', () => {
  const basePath = path.join(os.tmpdir(), 'fence-base')
  const inside = path.join(basePath, 'nested', 'index.js')

  const artifact = new ArtifactResolver().resolve(
    {
      ...buildManifest(),
      artifact: { ...buildManifest().artifact, entry: inside },
    },
    basePath,
  )

  assert.equal(artifact.entryPath, path.resolve(inside))
})

test('rejects launch cwd that escapes the plugin directory', () => {
  const basePath = path.join(os.tmpdir(), 'fence-base')

  assert.throws(
    () => new ArtifactResolver().resolve(buildManifest({ cwd: '../elsewhere' }), basePath),
    /Artifact cwd escapes plugin directory/,
  )
})

test('allows launch cwd inside the plugin directory', () => {
  const basePath = path.join(os.tmpdir(), 'fence-base')

  const artifact = new ArtifactResolver().resolve(buildManifest({ cwd: './work' }), basePath)
  assert.equal(artifact.cwd, path.resolve(basePath, 'work'))
})

test('rejects shell execution requested by the manifest', () => {
  const basePath = path.join(os.tmpdir(), 'fence-shell')
  const manifest = buildManifest({ shell: true, command: './plugin' })

  // The resolver is the shared choke point every bridge passes through before
  // any runtime loads, so the shell refusal is enforced once here.
  assert.throws(
    () => new ArtifactResolver().resolve(manifest, basePath),
    /does not allow shell execution/,
  )
})

test('rejects NUL bytes in artifact paths', () => {
  const basePath = path.join(os.tmpdir(), 'fence-nul')

  assert.throws(
    () => new ArtifactResolver().resolve(
      { ...buildManifest(), artifact: { ...buildManifest().artifact, entry: './index\0.js' } },
      basePath,
    ),
    /NUL bytes/,
  )
})

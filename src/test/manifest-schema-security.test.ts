import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JsonSchemaValidationError, validateExtensionManifestShape } from '../core/JsonSchemaValidator.js'

function buildBaseManifest(): Record<string, unknown> {
  return {
    id: 'demo.node-extension',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: {
      kind: 'module',
      entry: './index.js',
    },
    runtime: 'node',
    capabilities: [
      {
        name: 'demo.hello',
      },
    ],
  }
}

function expectValidationError(manifest: unknown): JsonSchemaValidationError {
  try {
    validateExtensionManifestShape(manifest)
  } catch (error) {
    if (error instanceof JsonSchemaValidationError) {
      return error
    }

    throw error
  }

  assert.fail('Expected manifest validation to fail')
}

test('rejects unsupported protocolVersion values', () => {
  const manifest = buildBaseManifest()
  manifest.protocolVersion = '2'

  const error = expectValidationError(manifest)
  assert.equal(error.message, 'Unsupported protocolVersion: expected "1"')
  assert.equal(error.path, '$.protocolVersion')

  const numericManifest = buildBaseManifest()
  numericManifest.protocolVersion = 1

  const numericError = expectValidationError(numericManifest)
  assert.equal(numericError.message, 'Expected type string')
})

test('rejects unknown top-level fields', () => {
  const manifest = buildBaseManifest()
  manifest.signingIdentity = 'unexpected-identity'

  const error = expectValidationError(manifest)
  assert.match(error.message, /Unexpected property signingIdentity/)
  assert.equal(error.path, '$.signingIdentity')
})

test('rejects unknown capability fields', () => {
  const manifest = buildBaseManifest()
  manifest.capabilities = [
    {
      name: 'demo.hello',
      interactionmode: 'unary',
    },
  ]

  const error = expectValidationError(manifest)
  assert.match(error.message, /Unexpected property interactionmode/)
  assert.equal(error.path, '$.capabilities[0].interactionmode')
})

test('rejects unknown launch fields', () => {
  const manifest = buildBaseManifest()
  const artifact = manifest.artifact as Record<string, unknown>
  artifact.launch = {
    timeOutMs: 5000,
  }

  const error = expectValidationError(manifest)
  assert.match(error.message, /Unexpected property timeOutMs/)
  assert.equal(error.path, '$.artifact.launch.timeOutMs')
})

test('accepts metadata.tags', () => {
  const manifest = buildBaseManifest()
  manifest.metadata = {
    tags: ['demo', 'node', 'secure'],
  }

  validateExtensionManifestShape(manifest)

  const emptyTagManifest = buildBaseManifest()
  emptyTagManifest.metadata = {
    tags: [''],
  }

  const error = expectValidationError(emptyTagManifest)
  assert.equal(error.message, 'String must have minimum length 1')
  assert.equal(error.path, '$.metadata.tags[0]')
})

test('accepts launch.auth', () => {
  const bearerManifest = buildBaseManifest()
  bearerManifest.artifact = {
    kind: 'module',
    entry: './index.js',
    launch: {
      auth: {
        kind: 'bearer',
        valueEnv: 'EXTENSION_AUTH_TOKEN',
      },
    },
  }

  validateExtensionManifestShape(bearerManifest)

  const headerManifest = buildBaseManifest()
  headerManifest.artifact = {
    kind: 'module',
    entry: './index.js',
    launch: {
      auth: {
        kind: 'header',
        headerName: 'X-Api-Key',
        valueEnv: 'EXTENSION_API_KEY',
      },
    },
  }

  validateExtensionManifestShape(headerManifest)

  const invalidKindManifest = buildBaseManifest()
  invalidKindManifest.artifact = {
    kind: 'module',
    entry: './index.js',
    launch: {
      auth: {
        kind: 'token',
        valueEnv: 'EXTENSION_AUTH_TOKEN',
      },
    },
  }

  const error = expectValidationError(invalidKindManifest)
  assert.match(error.message, /Value must match one of enum values/)
  assert.equal(error.path, '$.artifact.launch.auth.kind')
})

test('rejects launch.auth missing valueEnv', () => {
  const manifest = buildBaseManifest()
  manifest.artifact = {
    kind: 'module',
    entry: './index.js',
    launch: {
      auth: {
        kind: 'bearer',
      },
    },
  }

  const error = expectValidationError(manifest)
  assert.equal(error.message, 'Missing required property valueEnv')
  assert.equal(error.path, '$.artifact.launch.auth.valueEnv')
})

test('accepts a fully valid manifest with tags and launch auth', () => {
  const manifest = buildBaseManifest()
  manifest.metadata = {
    tags: ['demo', 'node'],
  }
  manifest.artifact = {
    kind: 'module',
    entry: './index.js',
    launch: {
      auth: {
        kind: 'header',
        headerName: 'Authorization',
        valueEnv: 'EXTENSION_AUTH_TOKEN',
      },
    },
  }

  validateExtensionManifestShape(manifest)
})

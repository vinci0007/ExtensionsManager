import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CommandSecurityCore,
  ExtensionManager,
  NodeRuntime,
  createCommandSecurityCoreRequest,
  parseCommandSecurityCoreRequest,
  parseCommandSecurityCoreResponse,
  stringifyCommandSecurityCoreRequest,
  stringifyCommandSecurityCoreResponse,
} from '../index.js'
import { ensureSpawnAvailable } from './spawn-test-helpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '../../')

test('command security core evaluates manifest through external command', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-command-security-core-'))
  const pluginDirectory = path.join(tempDirectory, 'plugin')
  const securityCorePath = path.join(tempDirectory, 'security-core.mjs')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.command-security-core-extension',
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
    }, null, 2), 'utf8')
    await fs.copyFile(path.join(root, 'examples/node-extension/index.js'), path.join(pluginDirectory, 'index.js'))

    await fs.writeFile(securityCorePath, `
const chunks = []
for await (const chunk of process.stdin) {
  chunks.push(chunk)
}
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
if (request.signaturePolicy !== 'require-signature') {
  throw new Error('signaturePolicy not forwarded')
}
if (request.manifest.id !== 'demo.command-security-core-extension') {
  throw new Error('manifest id not forwarded')
}
process.stdout.write(JSON.stringify({
  status: 'authorized-safe',
  reason: 'Approved by external command security core.',
}))
`, 'utf8')

    const manager = new ExtensionManager({
      workspacePath: root,
      securityCore: new CommandSecurityCore({
        command: process.execPath,
        args: [securityCorePath],
        signaturePolicy: 'require-signature',
      }),
    })
    manager.registerRuntime(new NodeRuntime())

    const extension = await manager.loadManifestFile(pluginDirectory)
    assert.equal(extension.security.status, 'authorized-safe')
    assert.equal(extension.security.reason, 'Approved by external command security core.')

    const result = await manager.invoke('demo.command-security-core-extension', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from node extension' })

    await manager.deactivate('demo.command-security-core-extension')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('command security core surfaces external command failures', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-command-security-core-failure-'))
  const pluginDirectory = path.join(tempDirectory, 'plugin')
  const securityCorePath = path.join(tempDirectory, 'security-core-failure.mjs')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.command-security-core-failure-extension',
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
    }, null, 2), 'utf8')
    await fs.copyFile(path.join(root, 'examples/node-extension/index.js'), path.join(pluginDirectory, 'index.js'))

    await fs.writeFile(securityCorePath, `
process.stderr.write('external security core rejected manifest')
process.exit(1)
`, 'utf8')

    const manager = new ExtensionManager({
      workspacePath: root,
      securityCore: new CommandSecurityCore({
        command: process.execPath,
        args: [securityCorePath],
      }),
    })
    manager.registerRuntime(new NodeRuntime())

    await assert.rejects(
      () => manager.loadManifestFile(pluginDirectory),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Failed to load extension: demo\.command-security-core-failure-extension/)

        const cause = (error as Error & { cause?: unknown }).cause
        assert.ok(cause instanceof Error)
        assert.match(cause.message, /Security core command failed: demo\.command-security-core-failure-extension/)
        return true
      },
    )
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('command security core rejects malformed JSON responses', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-command-security-core-invalid-json-'))
  const securityCorePath = path.join(tempDirectory, 'security-core-invalid-json.mjs')

  try {
    await fs.writeFile(securityCorePath, "process.stdout.write('{')\n", 'utf8')

    const securityCore = new CommandSecurityCore({
      command: process.execPath,
      args: [securityCorePath],
    })

    await assert.rejects(
      () => securityCore.evaluateManifest({
        id: 'demo.command-security-core-invalid-json',
        version: '1.0.0',
        protocolVersion: '1',
        artifact: { kind: 'module', entry: './index.js' },
        runtime: 'node',
        capabilities: [{ name: 'demo.hello' }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Security core command failed: demo\.command-security-core-invalid-json/)

        const cause = (error as Error & { cause?: unknown }).cause
        assert.ok(cause instanceof SyntaxError)
        return true
      },
    )
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('command security core rejects invalid response payloads', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-command-security-core-invalid-status-'))
  const securityCorePath = path.join(tempDirectory, 'security-core-invalid-status.mjs')

  try {
    await fs.writeFile(securityCorePath, `
process.stdout.write(JSON.stringify({
  status: 'not-a-valid-status',
  reason: 'bad response payload',
}))
`, 'utf8')

    const securityCore = new CommandSecurityCore({
      command: process.execPath,
      args: [securityCorePath],
    })

    await assert.rejects(
      () => securityCore.evaluateManifest({
        id: 'demo.command-security-core-invalid-status',
        version: '1.0.0',
        protocolVersion: '1',
        artifact: { kind: 'module', entry: './index.js' },
        runtime: 'node',
        capabilities: [{ name: 'demo.hello' }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Security core command failed: demo\.command-security-core-invalid-status/)

        const cause = (error as Error & { cause?: unknown }).cause
        assert.ok(cause instanceof Error)
        assert.match(cause.message, /Security core command returned invalid status/)
        return true
      },
    )
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('command security core protocol helpers round-trip requests and responses', () => {
  const manifest = {
    id: 'demo.command-security-core-protocol',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: { kind: 'module' as const, entry: './index.js' },
    runtime: 'node' as const,
    capabilities: [{ name: 'demo.hello' }],
  }

  const request = createCommandSecurityCoreRequest(manifest, {
    signaturePolicy: 'require-signature',
    isDevelopment: false,
    trustedKeyDirectory: './trusted-keys',
    trustedPublicKeys: {
      'demo-key': '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----',
    },
  })
  const requestJson = stringifyCommandSecurityCoreRequest(request)
  const parsedRequest = parseCommandSecurityCoreRequest(requestJson)

  assert.deepEqual(parsedRequest, JSON.parse(requestJson))

  const responseJson = stringifyCommandSecurityCoreResponse({
    status: 'authorized-safe',
    reason: 'Approved by protocol helper.',
  })
  const parsedResponse = parseCommandSecurityCoreResponse(responseJson)

  assert.deepEqual(parsedResponse, {
    status: 'authorized-safe',
    reason: 'Approved by protocol helper.',
  })
})

test('command security core protocol helpers reject invalid response payloads', () => {
  assert.throws(
    () => parseCommandSecurityCoreResponse(JSON.stringify({
      status: 'invalid-status',
      reason: 'bad payload',
    })),
    /Security core command returned invalid status/,
  )

  assert.throws(
    () => stringifyCommandSecurityCoreResponse({
      status: 'authorized-safe',
      reason: '',
    }),
    /Security core command returned invalid reason/,
  )
})

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  ExtensionManager,
  FileTrustedKeyStore,
  InMemoryTrustedKeyStore,
  NodeRuntime,
  PublicKeySignatureVerifier,
  generateSigningKeyPair,
  signManifest,
} from '../index.js'
import { ensureSpawnAvailable } from './spawn-test-helpers.js'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..', '..')

async function createSignedPluginFixture() {
  const keyPair = generateSigningKeyPair('ed25519')
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-onboarding-'))
  const pluginDirectory = path.join(tempDirectory, 'plugin')
  const trustedKeyDirectory = path.join(tempDirectory, 'trusted-keys')

  await fs.mkdir(pluginDirectory)
  await fs.mkdir(trustedKeyDirectory)

  const manifest = {
    id: 'demo.onboarding-test-plugin',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: { kind: 'module' as const, entry: './index.js' },
    runtime: 'node' as const,
    capabilities: [{ name: 'demo.hello' }],
  }

  const signature = signManifest(manifest, {
    algorithm: 'ed25519',
    keyId: 'demo-key',
    privateKeyPem: keyPair.privateKeyPem,
  })

  await fs.writeFile(
    path.join(pluginDirectory, 'extension.json'),
    JSON.stringify({ ...manifest, signature }, null, 2),
    'utf8',
  )
  await fs.writeFile(
    path.join(pluginDirectory, 'index.js'),
    "export default { capabilities: { 'demo.hello': async () => ({ message: 'hello from onboarding test plugin' }) } }\n",
    'utf8',
  )
  await fs.writeFile(path.join(trustedKeyDirectory, 'demo-key.pem'), keyPair.publicKeyPem, 'utf8')

  return {
    tempDirectory,
    pluginDirectory,
    trustedKeyDirectory,
    publicKeyPem: keyPair.publicKeyPem,
  }
}

async function createOnboardingScriptFixture() {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-onboarding-scripts-'))
  const fixtureRoot = path.join(tempDirectory, 'fixture')

  await fs.mkdir(fixtureRoot)
  await fs.cp(path.join(root, 'dist'), path.join(fixtureRoot, 'dist'), { recursive: true })
  await fs.cp(path.join(root, 'examples'), path.join(fixtureRoot, 'examples'), { recursive: true })

  return {
    tempDirectory,
    fixtureRoot,
    prepareScriptPath: path.join(fixtureRoot, 'examples', 'prepare-onboarding-kit.mjs'),
    runScriptPath: path.join(fixtureRoot, 'examples', 'run-onboarding-config.mjs'),
  }
}

function parseTrailingJson(stdout: string): any {
  const trimmed = stdout.trim()
  const objectStart = trimmed.lastIndexOf('\n{')

  if (objectStart >= 0) {
    return JSON.parse(trimmed.slice(objectStart + 1))
  }

  return JSON.parse(trimmed)
}

test('loads a signed plugin with file-based trusted keys', async () => {
  const fixture = await createSignedPluginFixture()

  try {
    const manager = new ExtensionManager({
      signaturePolicy: 'require-signature',
      signatureVerifier: new PublicKeySignatureVerifier(
        new FileTrustedKeyStore(fixture.trustedKeyDirectory),
      ),
    })
    manager.registerRuntime(new NodeRuntime())

    await manager.loadManifestFile(fixture.pluginDirectory)
    const result = await manager.invoke('demo.onboarding-test-plugin', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from onboarding test plugin' })

    await manager.deactivate('demo.onboarding-test-plugin')
  } finally {
    await fs.rm(fixture.tempDirectory, { recursive: true, force: true })
  }
})

test('loads a signed plugin with inline trusted public keys', async () => {
  const fixture = await createSignedPluginFixture()

  try {
    const manager = new ExtensionManager({
      signaturePolicy: 'require-signature',
      signatureVerifier: new PublicKeySignatureVerifier(
        new InMemoryTrustedKeyStore({
          'demo-key': fixture.publicKeyPem,
        }),
      ),
    })
    manager.registerRuntime(new NodeRuntime())

    await manager.loadManifestFile(fixture.pluginDirectory)
    const result = await manager.invoke('demo.onboarding-test-plugin', 'demo.hello', {})
    assert.deepEqual(result, { message: 'hello from onboarding test plugin' })

    await manager.deactivate('demo.onboarding-test-plugin')
  } finally {
    await fs.rm(fixture.tempDirectory, { recursive: true, force: true })
  }
})

test('prepare-onboarding-kit and run-onboarding-config support node native and wasm flows', async (t) => {
  await ensureSpawnAvailable(t)
  const fixture = await createOnboardingScriptFixture()

  try {
    const prepare = await execFileAsync(process.execPath, [fixture.prepareScriptPath], {
      cwd: fixture.fixtureRoot,
      maxBuffer: 10 * 1024 * 1024,
    })
    const prepareOutput = JSON.parse(prepare.stdout)

    assert.equal(prepareOutput.generated, true)
    assert.equal(prepareOutput.configFiles.length, 9)

    const runs = [
      {
        configName: 'plugin-onboarding.file.config.json',
        expectedTrustedKeyMode: 'file',
        assertResult(result: unknown) {
          assert.deepEqual(result, { message: 'hello from node extension' })
        },
      },
      {
        configName: 'plugin-onboarding.inline.config.json',
        expectedTrustedKeyMode: 'inline',
        assertResult(result: unknown) {
          assert.deepEqual(result, { message: 'hello from node extension' })
        },
      },
      {
        configName: 'plugin-onboarding.native.file.config.json',
        expectedTrustedKeyMode: 'file',
        assertResult(result: unknown) {
          assert.equal(typeof result, 'object')
          assert.equal((result as { message: string }).message, 'hello from native bridge template')
          assert.match((result as { libraryPath: string }).libraryPath, /onboarded-native-extension[\\/]build[\\/]/)
        },
      },
      {
        configName: 'plugin-onboarding.native.inline.config.json',
        expectedTrustedKeyMode: 'inline',
        assertResult(result: unknown) {
          assert.equal(typeof result, 'object')
          assert.equal((result as { message: string }).message, 'hello from native bridge template')
          assert.match((result as { libraryPath: string }).libraryPath, /onboarded-native-extension[\\/]build[\\/]/)
        },
      },
      {
        configName: 'plugin-onboarding.wasm.file.config.json',
        expectedTrustedKeyMode: 'file',
        assertResult(result: unknown) {
          assert.equal(result, 42)
        },
      },
      {
        configName: 'plugin-onboarding.wasm.inline.config.json',
        expectedTrustedKeyMode: 'inline',
        assertResult(result: unknown) {
          assert.equal(result, 42)
        },
      },
    ]

    for (const run of runs) {
      const execution = await execFileAsync(process.execPath, [fixture.runScriptPath, run.configName], {
        cwd: fixture.fixtureRoot,
        maxBuffer: 10 * 1024 * 1024,
      })
      const output = parseTrailingJson(execution.stdout)

      assert.equal(output.configPath.endsWith(run.configName), true)
      assert.equal(output.trustedKeyMode, run.expectedTrustedKeyMode)
      run.assertResult(output.result)
    }
  } finally {
    await fs.rm(fixture.tempDirectory, { recursive: true, force: true })
  }
})

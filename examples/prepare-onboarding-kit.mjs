import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSigningKeyPair, signManifest } from '../dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')
const kitDirectory = path.join(root, 'examples/onboarding-kit')
const trustedKeyDirectory = path.join(kitDirectory, 'trusted-keys')
const signedNodePluginDirectory = path.join(root, 'examples/onboarded-node-extension')
const signedNativePluginDirectory = path.join(root, 'examples/onboarded-native-extension')
const signedWasmPluginDirectory = path.join(root, 'examples/onboarded-wasm-extension')

async function main() {
  await fs.mkdir(trustedKeyDirectory, { recursive: true })

  const keyPair = generateSigningKeyPair('ed25519')
  await fs.writeFile(path.join(trustedKeyDirectory, 'demo-key.pem'), keyPair.publicKeyPem, 'utf8')

  const nodeConfig = await prepareNodePlugin(keyPair)
  const nativeConfig = await prepareNativePlugin(keyPair)
  const wasmConfig = await prepareWasmPlugin(keyPair)

  const configFiles = [
    await writeOnboardingConfigs('plugin-onboarding', nodeConfig, keyPair.publicKeyPem),
    await writeOnboardingConfigs('plugin-onboarding.native', nativeConfig, keyPair.publicKeyPem),
    await writeOnboardingConfigs('plugin-onboarding.wasm', wasmConfig, keyPair.publicKeyPem),
  ].flat()

  console.log(JSON.stringify({
    generated: true,
    trustedKeyModeDefault: 'file',
    signedManifestPaths: [
      path.join(signedNodePluginDirectory, 'extension.json'),
      path.join(signedNativePluginDirectory, 'extension.json'),
      path.join(signedWasmPluginDirectory, 'extension.json'),
    ],
    trustedKeyPath: path.join(trustedKeyDirectory, 'demo-key.pem'),
    configFiles,
  }, null, 2))
}

async function prepareNodePlugin(keyPair) {
  await fs.mkdir(signedNodePluginDirectory, { recursive: true })

  const manifest = {
    id: 'demo.onboarded-plugin',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: { kind: 'module', entry: './index.js' },
    runtime: 'node',
    capabilities: [{ name: 'demo.hello' }],
  }

  await writeSignedManifest(signedNodePluginDirectory, manifest, keyPair)
  await fs.copyFile(
    path.join(root, 'examples/node-extension/index.js'),
    path.join(signedNodePluginDirectory, 'index.js'),
  )

  return {
    extensionId: manifest.id,
    manifestPath: '../onboarded-node-extension/extension.json',
    runtime: manifest.runtime,
    signaturePolicy: 'require-signature',
    invoke: {
      capability: 'demo.hello',
      input: {},
    },
  }
}

async function prepareNativePlugin(keyPair) {
  await fs.mkdir(path.join(signedNativePluginDirectory, 'build'), { recursive: true })

  const manifest = {
    id: 'demo.onboarded-native-plugin',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: {
      kind: 'shared-library',
      entry: {
        'win32-x64': './build/plugin.dll',
        'linux-x64': './build/libplugin.so',
        'darwin-arm64': './build/libplugin.dylib',
        default: './build/libplugin.so',
      },
      launch: {
        command: process.execPath,
        args: ['./bridge.mjs'],
        cwd: '${basePath}',
        timeoutMs: 5000,
      },
    },
    runtime: 'native',
    capabilities: [{ name: 'demo.hello' }],
  }

  await writeSignedManifest(signedNativePluginDirectory, manifest, keyPair)
  await fs.copyFile(
    path.join(root, 'examples/native-shared-library-template/bridge.mjs'),
    path.join(signedNativePluginDirectory, 'bridge.mjs'),
  )
  await fs.writeFile(path.join(signedNativePluginDirectory, 'build/plugin.dll'), 'placeholder native library', 'utf8')
  await fs.writeFile(path.join(signedNativePluginDirectory, 'build/libplugin.so'), 'placeholder native library', 'utf8')
  await fs.writeFile(path.join(signedNativePluginDirectory, 'build/libplugin.dylib'), 'placeholder native library', 'utf8')

  return {
    extensionId: manifest.id,
    manifestPath: '../onboarded-native-extension/extension.json',
    runtime: manifest.runtime,
    signaturePolicy: 'require-signature',
    invoke: {
      capability: 'demo.hello',
      input: {},
    },
  }
}

async function prepareWasmPlugin(keyPair) {
  await fs.mkdir(signedWasmPluginDirectory, { recursive: true })

  const manifest = {
    id: 'demo.onboarded-wasm-plugin',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: { kind: 'wasm', entry: './plugin.wasm' },
    runtime: 'wasm',
    capabilities: [{ name: 'demo.addOne', binding: 'addOne' }],
  }

  await writeSignedManifest(signedWasmPluginDirectory, manifest, keyPair)
  await fs.copyFile(
    path.join(root, 'examples/wasm-extension-template/plugin.wasm'),
    path.join(signedWasmPluginDirectory, 'plugin.wasm'),
  )
  await fs.copyFile(
    path.join(root, 'examples/wasm-extension-template/plugin.wat'),
    path.join(signedWasmPluginDirectory, 'plugin.wat'),
  )

  return {
    extensionId: manifest.id,
    manifestPath: '../onboarded-wasm-extension/extension.json',
    runtime: manifest.runtime,
    signaturePolicy: 'require-signature',
    invoke: {
      capability: 'demo.addOne',
      input: { value: 41 },
    },
  }
}

async function writeSignedManifest(pluginDirectory, manifest, keyPair) {
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
}

async function writeOnboardingConfigs(prefix, baseConfig, publicKeyPem) {
  const defaultConfigPath = path.join(kitDirectory, `${prefix}.config.json`)
  const fileConfigPath = path.join(kitDirectory, `${prefix}.file.config.json`)
  const inlineConfigPath = path.join(kitDirectory, `${prefix}.inline.config.json`)

  await fs.writeFile(
    fileConfigPath,
    JSON.stringify({
      ...baseConfig,
      trustedKeyMode: 'file',
      trustedKeyDirectory: './trusted-keys',
      trustedPublicKeys: {},
    }, null, 2),
    'utf8',
  )

  await fs.writeFile(
    inlineConfigPath,
    JSON.stringify({
      ...baseConfig,
      trustedKeyMode: 'inline',
      trustedKeyDirectory: './trusted-keys',
      trustedPublicKeys: {
        'demo-key': publicKeyPem,
      },
    }, null, 2),
    'utf8',
  )

  await fs.writeFile(
    defaultConfigPath,
    JSON.stringify({
      ...baseConfig,
      trustedKeyMode: 'file',
      trustedKeyDirectory: './trusted-keys',
      trustedPublicKeys: {
        'demo-key': publicKeyPem,
      },
    }, null, 2),
    'utf8',
  )

  return [defaultConfigPath, fileConfigPath, inlineConfigPath]
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

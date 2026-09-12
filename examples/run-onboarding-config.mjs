import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ExtensionManager,
  FileTrustedKeyStore,
  InMemoryTrustedKeyStore,
  NativeRuntime,
  NodeRuntime,
  ProcessRuntime,
  PublicKeySignatureVerifier,
  WasmRuntime,
} from '../dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')
const kitDirectory = path.join(root, 'examples/onboarding-kit')
const configArgument = process.argv[2] ?? 'plugin-onboarding.config.json'
const configPath = path.isAbsolute(configArgument)
  ? configArgument
  : path.resolve(kitDirectory, configArgument)

async function main() {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  const verifier = createSignatureVerifier(config)

  const manager = new ExtensionManager({
    workspacePath: root,
    signaturePolicy: config.signaturePolicy,
    signatureVerifier: verifier,
  })

  if (config.runtime === 'node') {
    manager.registerRuntime(new NodeRuntime())
  }

  if (config.runtime === 'process') {
    manager.registerRuntime(new ProcessRuntime())
  }

  if (config.runtime === 'native') {
    manager.registerRuntime(new NativeRuntime())
  }

  if (config.runtime === 'wasm') {
    manager.registerRuntime(new WasmRuntime())
  }

  const manifestPath = path.resolve(path.dirname(configPath), config.manifestPath)
  await manager.loadManifestFile(manifestPath)

  const result = await manager.invoke(
    config.extensionId,
    config.invoke.capability,
    config.invoke.input,
  )

  console.log(JSON.stringify({
    configPath,
    trustedKeyMode: config.trustedKeyMode,
    manifestPath,
    result,
  }, null, 2))

  await manager.deactivate(config.extensionId)
}

function createSignatureVerifier(config) {
  if (config.trustedKeyMode === 'file') {
    const trustedKeyDirectory = path.resolve(path.dirname(configPath), config.trustedKeyDirectory)
    return new PublicKeySignatureVerifier(new FileTrustedKeyStore(trustedKeyDirectory))
  }

  if (config.trustedKeyMode === 'inline') {
    return new PublicKeySignatureVerifier(new InMemoryTrustedKeyStore(config.trustedPublicKeys ?? {}))
  }

  throw new Error(`Unsupported trustedKeyMode: ${config.trustedKeyMode}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

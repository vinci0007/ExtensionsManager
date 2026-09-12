import fs from 'node:fs/promises'
import path from 'node:path'
import { ExtensionManager, type ExtensionManagerOptions } from '../core/ExtensionManager.js'
import type { ExtensionInstance } from '../contracts/ExtensionInstance.js'
import { CommandKernelBridge, type KernelBridgeDaemonOptions } from '../kernel/CommandKernelBridge.js'
import type { KernelBridge } from '../kernel/KernelBridge.js'
import type { KernelPolicyConfig, PolicyConsentRequest } from '../contracts/KernelPolicy.js'
import type { ExtensionSecurityCore } from '../security/ExtensionSecurityCore.js'
import type { SignaturePolicy } from '../security/SignaturePolicy.js'
import { FileTrustedKeyStore } from '../security/TrustedKeyStores.js'
import { PublicKeySignatureVerifier } from '../security/PublicKeySignatureVerifier.js'
import { loadRevocationListFile, loadTrustBundleFile } from '../security/loadTrustConfig.js'
import { NativeRuntime } from '../runtimes/native/NativeRuntime.js'
import { RemoteRuntime } from '../runtimes/remote/RemoteRuntime.js'
import { NodeRuntime } from '../runtimes/node/NodeRuntime.js'
import { ProcessRuntime } from '../runtimes/process/ProcessRuntime.js'
import { WasmRuntime } from '../runtimes/wasm/WasmRuntime.js'

export interface ExtensionManagerConfig {
  workspacePath?: string
  storagePath?: string
  signaturePolicy?: SignaturePolicy
  trustedKeyDirectory?: string
  trustBundlePath?: string
  revocationListPath?: string
  pluginsDirectory?: string
  pluginsRecursive?: boolean
  isDevelopment?: boolean
  securityCore?: ExtensionSecurityCore
  policy?: KernelPolicyConfig
  onPolicyConsent?: (request: PolicyConsentRequest) => Promise<boolean>
  commandSecurityCore?: CommandSecurityCoreConfig
  kernel?: KernelConfig
  registerNodeRuntime?: boolean
  registerProcessRuntime?: boolean
  registerNativeRuntime?: boolean
  registerWasmRuntime?: boolean
  registerRemoteRuntime?: boolean
}

export interface CommandSecurityCoreConfig {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  signaturePolicy?: SignaturePolicy
  isDevelopment?: boolean
  trustedKeyDirectory?: string
  trustedPublicKeys?: Record<string, string>
  trustBundlePath?: string
  revocationListPath?: string
}

export interface KernelSecurityConfig {
  signaturePolicy?: SignaturePolicy
  isDevelopment?: boolean
  trustedKeyDirectory?: string
  trustedPublicKeys?: Record<string, string>
  trustBundlePath?: string
  revocationListPath?: string
}

export interface KernelConfig extends KernelSecurityConfig {
  mode?: 'daemon' | 'embedded'
  transport?: 'pipe' | 'socket'
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  endpoint?: string
  timeoutMs?: number
  /** Window for the real result of an async-dispatched invoke (accepted marker → late envelope). */
  asyncInvokeTimeoutMs?: number
  policy?: KernelPolicyConfig
  onPolicyConsent?: (request: PolicyConsentRequest) => Promise<boolean>
  runtimeDefaults?: Record<string, unknown>
}

export interface LoadPluginsDirectoryOptions {
  recursive?: boolean
}

export interface ConfiguredExtensionManager {
  manager: ExtensionManager
  loaded: ExtensionInstance[]
}

export async function createExtensionManagerFromConfig(config: ExtensionManagerConfig): Promise<ConfiguredExtensionManager> {
  return createConfiguredExtensionManager(config)
}

export async function createConfiguredExtensionManager(config: ExtensionManagerConfig): Promise<ConfiguredExtensionManager> {
  const options: ExtensionManagerOptions = {
    workspacePath: config.workspacePath,
    storagePath: config.storagePath,
  }
  const externalKernelBridge = await createKernelBridgeFromConfig(config)

  if (externalKernelBridge) {
    options.kernelBridge = externalKernelBridge
  } else if (config.securityCore) {
    options.securityCore = config.securityCore
  } else {
    options.signaturePolicy = config.signaturePolicy
    options.isDevelopment = config.isDevelopment
    options.policy = config.policy
    options.onPolicyConsent = config.onPolicyConsent

    if (config.trustedKeyDirectory) {
      options.signatureVerifier = new PublicKeySignatureVerifier(
        new FileTrustedKeyStore(config.trustedKeyDirectory),
      )
    }

    if (config.trustBundlePath) {
      options.trustBundle = await loadTrustBundleFile(config.trustBundlePath)
    }

    if (config.revocationListPath) {
      options.revocationList = await loadRevocationListFile(config.revocationListPath)
    }
  }

  const manager = new ExtensionManager(options)
  const shouldRegisterCompatibilityRuntimes = !externalKernelBridge

  if (shouldRegisterCompatibilityRuntimes && (config.registerNodeRuntime ?? true)) {
    manager.registerRuntime(new NodeRuntime())
  }

  if (shouldRegisterCompatibilityRuntimes && (config.registerProcessRuntime ?? true)) {
    manager.registerRuntime(new ProcessRuntime())
  }

  if (shouldRegisterCompatibilityRuntimes && (config.registerNativeRuntime ?? true)) {
    manager.registerRuntime(new NativeRuntime())
  }

  if (shouldRegisterCompatibilityRuntimes && (config.registerWasmRuntime ?? true)) {
    manager.registerRuntime(new WasmRuntime())
  }

  if (shouldRegisterCompatibilityRuntimes && (config.registerRemoteRuntime ?? true)) {
    manager.registerRuntime(new RemoteRuntime())
  }

  const loaded = config.pluginsDirectory
    ? await loadPluginsDirectory(manager, config.pluginsDirectory, { recursive: config.pluginsRecursive })
    : []

  return {
    manager,
    loaded,
  }
}

export async function createExtensionManagerFromHostConfig(configPath: string): Promise<ConfiguredExtensionManager> {
  const absoluteConfigPath = path.resolve(configPath)
  const configDirectory = path.dirname(absoluteConfigPath)
  const content = await fs.readFile(absoluteConfigPath, 'utf8')
  const rawConfig = JSON.parse(content) as ExtensionManagerConfig

  const normalizedConfig: ExtensionManagerConfig = {
    ...rawConfig,
    workspacePath: resolveOptionalPath(configDirectory, rawConfig.workspacePath),
    storagePath: resolveOptionalPath(configDirectory, rawConfig.storagePath),
    trustedKeyDirectory: resolveOptionalPath(configDirectory, rawConfig.trustedKeyDirectory),
    trustBundlePath: resolveOptionalPath(configDirectory, rawConfig.trustBundlePath),
    revocationListPath: resolveOptionalPath(configDirectory, rawConfig.revocationListPath),
    pluginsDirectory: resolveOptionalPath(configDirectory, rawConfig.pluginsDirectory),
    kernel: rawConfig.kernel
      ? {
        ...rawConfig.kernel,
        command: rawConfig.kernel.command ? resolveCommandLike(configDirectory, rawConfig.kernel.command) : undefined,
        cwd: resolveOptionalPath(configDirectory, rawConfig.kernel.cwd),
        trustedKeyDirectory: resolveOptionalPath(configDirectory, rawConfig.kernel.trustedKeyDirectory),
        trustBundlePath: resolveOptionalPath(configDirectory, rawConfig.kernel.trustBundlePath),
        revocationListPath: resolveOptionalPath(configDirectory, rawConfig.kernel.revocationListPath),
      }
      : undefined,
    commandSecurityCore: rawConfig.commandSecurityCore
      ? {
        ...rawConfig.commandSecurityCore,
        command: resolveCommandLike(configDirectory, rawConfig.commandSecurityCore.command),
        cwd: resolveOptionalPath(configDirectory, rawConfig.commandSecurityCore.cwd),
        trustedKeyDirectory: resolveOptionalPath(configDirectory, rawConfig.commandSecurityCore.trustedKeyDirectory),
        trustBundlePath: resolveOptionalPath(configDirectory, rawConfig.commandSecurityCore.trustBundlePath),
        revocationListPath: resolveOptionalPath(configDirectory, rawConfig.commandSecurityCore.revocationListPath),
      }
      : undefined,
  }

  return createConfiguredExtensionManager(normalizedConfig)
}

export async function loadPluginsDirectory(
  manager: ExtensionManager,
  pluginsDirectory: string,
  options: LoadPluginsDirectoryOptions = {},
): Promise<ExtensionInstance[]> {
  const manifestDirectories = await findPluginManifestDirectories(pluginsDirectory, options.recursive ?? false)
  const loaded: ExtensionInstance[] = []

  for (const directory of manifestDirectories) {
    loaded.push(await manager.loadManifestFile(directory))
  }

  return loaded
}

async function findPluginManifestDirectories(pluginsDirectory: string, recursive: boolean): Promise<string[]> {
  const entries = await fs.readdir(pluginsDirectory, { withFileTypes: true })
  const directories: string[] = []

  for (const entry of entries) {
    const entryPath = path.join(pluginsDirectory, entry.name)

    if (entry.isFile() && entry.name === 'extension.json') {
      directories.push(pluginsDirectory)
      continue
    }

    if (!entry.isDirectory()) {
      continue
    }

    const manifestPath = path.join(entryPath, 'extension.json')
    if (await fileExists(manifestPath)) {
      directories.push(entryPath)
      continue
    }

    if (recursive) {
      directories.push(...await findPluginManifestDirectories(entryPath, true))
    }
  }

  return [...new Set(directories)].sort()
}

function resolveOptionalPath(baseDirectory: string, targetPath: string | undefined): string | undefined {
  if (!targetPath) {
    return undefined
  }

  return path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(baseDirectory, targetPath)
}

function resolveCommandLike(baseDirectory: string, command: string): string {
  if (path.isAbsolute(command)) {
    return command
  }

  if (command.startsWith('.') || command.includes('/') || command.includes('\\')) {
    return path.resolve(baseDirectory, command)
  }

  return command
}

async function createKernelBridgeFromConfig(config: ExtensionManagerConfig): Promise<KernelBridge | undefined> {
  const kernelConfig = normalizeKernelConfig(config)
  if (!kernelConfig) {
    return undefined
  }

  const options: KernelBridgeDaemonOptions = {
    mode: kernelConfig.mode ?? 'daemon',
    transport: kernelConfig.transport ?? 'pipe',
    command: kernelConfig.command ?? '',
    args: kernelConfig.args,
    cwd: kernelConfig.cwd,
    env: kernelConfig.env,
    endpoint: kernelConfig.endpoint,
    timeoutMs: kernelConfig.timeoutMs,
    asyncInvokeTimeoutMs: kernelConfig.asyncInvokeTimeoutMs,
    policy: kernelConfig.policy ?? config.policy,
    onPolicyConsent: kernelConfig.onPolicyConsent ?? config.onPolicyConsent,
    signaturePolicy: kernelConfig.signaturePolicy ?? config.signaturePolicy,
    isDevelopment: kernelConfig.isDevelopment ?? config.isDevelopment,
    trustedKeyDirectory: kernelConfig.trustedKeyDirectory ?? config.trustedKeyDirectory,
    trustedPublicKeys: kernelConfig.trustedPublicKeys,
  }

  const trustBundlePath = kernelConfig.trustBundlePath ?? config.trustBundlePath
  if (trustBundlePath) {
    options.trustBundle = await loadTrustBundleFile(trustBundlePath)
  }

  const revocationListPath = kernelConfig.revocationListPath ?? config.revocationListPath
  if (revocationListPath) {
    options.revocationList = await loadRevocationListFile(revocationListPath)
  }

  if (!options.command && options.mode !== 'embedded') {
    throw new Error('kernel.command is required when kernel.mode is "daemon"')
  }

  return new CommandKernelBridge(options)
}

function normalizeKernelConfig(config: ExtensionManagerConfig): KernelConfig | undefined {
  if (config.kernel) {
    return config.kernel
  }

  if (!config.commandSecurityCore) {
    return undefined
  }

  return {
    mode: 'daemon',
    transport: 'pipe',
    command: config.commandSecurityCore.command,
    args: config.commandSecurityCore.args,
    cwd: config.commandSecurityCore.cwd,
    env: config.commandSecurityCore.env,
    timeoutMs: config.commandSecurityCore.timeoutMs,
    signaturePolicy: config.commandSecurityCore.signaturePolicy,
    isDevelopment: config.commandSecurityCore.isDevelopment,
    trustedKeyDirectory: config.commandSecurityCore.trustedKeyDirectory,
    trustedPublicKeys: config.commandSecurityCore.trustedPublicKeys,
    trustBundlePath: config.commandSecurityCore.trustBundlePath,
    revocationListPath: config.commandSecurityCore.revocationListPath,
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

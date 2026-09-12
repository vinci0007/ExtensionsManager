import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExtensionContext } from '../contracts/ExtensionContext.js'
import type {
  ExtensionInitializationInfo,
  ExtensionInitializationStatus,
} from '../contracts/ExtensionInitialization.js'
import type { ExtensionInstance } from '../contracts/ExtensionInstance.js'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionSession } from '../contracts/ExtensionSession.js'
import type { RevocationList, TrustBundle } from '../contracts/TrustBundle.js'
import { ExtensionLoadError } from '../errors/ExtensionError.js'
import { type KernelBridge } from '../kernel/KernelBridge.js'
import { LocalKernelBridge } from '../kernel/LocalKernelBridge.js'
import type { ExtensionSecurityCore } from '../security/ExtensionSecurityCore.js'
import type { ExtensionSignatureVerifier } from '../security/PublicKeySignatureVerifier.js'
import type { SignaturePolicy } from '../security/SignaturePolicy.js'
import type { KernelPolicyConfig, PolicyConsentRequest } from '../contracts/KernelPolicy.js'
import { assertStatusProbeAllowed } from '../security/statusProbeGuard.js'
import { isPlainObject } from './guards.js'
import { ExtensionRegistry } from './ExtensionRegistry.js'
import type { ExtensionRuntimeAdapter } from './RuntimeRouter.js'
import { validateExtensionManifestShape } from './JsonSchemaValidator.js'

export interface ExtensionManagerOptions {
  workspacePath?: string
  storagePath?: string
  adapters?: ExtensionRuntimeAdapter[]
  signatureVerifier?: ExtensionSignatureVerifier
  signaturePolicy?: SignaturePolicy
  trustBundle?: TrustBundle
  revocationList?: RevocationList
  isDevelopment?: boolean
  securityCore?: ExtensionSecurityCore
  kernelBridge?: KernelBridge
  /**
   * Extra hosts that manifest-declared status probes (metadata.statusCheck) are
   * allowed to target beyond the extension's own endpoint host and loopback.
   */
  statusProbeAllowedHosts?: string[]
  /** Performance policy: frame budget / memory tiers / fuel override. */
  policy?: KernelPolicyConfig
  /**
   * Consent handler for policy exceptions (tier overflow, resident over
   * budget). Async so the host can ask its user. Absent handler = fail-closed
   * (exceptions are rejected).
   */
  onPolicyConsent?: (request: PolicyConsentRequest) => Promise<boolean>
}

export class ExtensionManager {
  private readonly registry = new ExtensionRegistry()
  private readonly activeExtensions = new Set<string>()
  private readonly initializationStatuses = new Map<string, ExtensionInitializationStatus>()
  private readonly kernelBridge: KernelBridge

  constructor(private readonly options: ExtensionManagerOptions = {}) {
    this.kernelBridge = options.kernelBridge ?? new LocalKernelBridge({
      adapters: options.adapters,
      securityCore: options.securityCore,
      signatureVerifier: options.signatureVerifier,
      signaturePolicy: options.signaturePolicy,
      trustBundle: options.trustBundle,
      revocationList: options.revocationList,
      isDevelopment: options.isDevelopment,
      policy: options.policy,
      onPolicyConsent: options.onPolicyConsent,
    })
  }

  /**
   * @deprecated Runtime registration is now a compatibility path for the local kernel bridge only.
   */
  registerRuntime(adapter: ExtensionRuntimeAdapter): void {
    if ('registerRuntime' in this.kernelBridge && typeof this.kernelBridge.registerRuntime === 'function') {
      this.kernelBridge.registerRuntime(adapter)
      return
    }

    throw new Error('registerRuntime is only supported by the local kernel bridge compatibility layer')
  }

  async loadManifestFile(manifestPath: string): Promise<ExtensionInstance> {
    const absoluteManifestPath = path.resolve(manifestPath)
    const manifestStat = await fs.stat(absoluteManifestPath)
    const manifestFilePath = manifestStat.isDirectory()
      ? path.join(absoluteManifestPath, 'extension.json')
      : absoluteManifestPath

    const manifestContent = await fs.readFile(manifestFilePath, 'utf8')
    const manifest = JSON.parse(manifestContent) as ExtensionManifest
    const basePath = path.dirname(manifestFilePath)

    return this.load(manifest, basePath)
  }

  async load(manifest: ExtensionManifest, basePath: string): Promise<ExtensionInstance> {
    try {
      this.validateManifest(manifest)
      const { security } = await this.kernelBridge.load(manifest, basePath)
      const extension = this.createKernelFacadeInstance(manifest, security)
      this.registry.register(extension)
      this.initializationStatuses.set(manifest.id, this.createDefaultStatus(extension))
      return extension
    } catch (error) {
      throw new ExtensionLoadError(`Failed to load extension: ${manifest.id}`, error)
    }
  }

  async activate(extensionId: string): Promise<void> {
    if (this.activeExtensions.has(extensionId)) {
      return
    }

    const extension = this.registry.require(extensionId)
    await this.kernelBridge.activate(extensionId, this.createContext(extension))
    this.activeExtensions.add(extensionId)
    this.initializationStatuses.set(extensionId, this.createDefaultStatus(extension, 'Extension activated.'))
  }

  async deactivate(extensionId: string): Promise<void> {
    if (!this.activeExtensions.has(extensionId)) {
      return
    }

    const extension = this.registry.require(extensionId)
    await this.kernelBridge.deactivate(extensionId)
    this.activeExtensions.delete(extensionId)
    this.initializationStatuses.set(extensionId, this.createDefaultStatus(extension, 'Extension deactivated.'))
  }

  async invoke<TInput = unknown, TOutput = unknown>(
    extensionId: string,
    capability: string,
    input: TInput,
  ): Promise<TOutput> {
    if (!this.activeExtensions.has(extensionId)) {
      await this.activate(extensionId)
    }

    return this.kernelBridge.invoke<TInput, TOutput>(extensionId, capability, input)
  }

  async openSession(extensionId: string, capability: string, input: unknown): Promise<ExtensionSession> {
    if (!this.activeExtensions.has(extensionId)) {
      await this.activate(extensionId)
    }

    return this.kernelBridge.openSession(extensionId, capability, input)
  }

  async dispose(): Promise<void> {
    for (const extensionId of [...this.activeExtensions]) {
      await this.deactivate(extensionId)
    }

    this.activeExtensions.clear()
    this.initializationStatuses.clear()

    if (typeof this.kernelBridge.dispose === 'function') {
      await this.kernelBridge.dispose()
    }
  }

  getInitializationInfo(extensionId: string): ExtensionInitializationInfo {
    return this.createInitializationInfo(this.registry.require(extensionId))
  }

  async checkStatus(extensionId: string): Promise<ExtensionInitializationStatus> {
    const extension = this.registry.require(extensionId)
    const status = await this.resolveInitializationStatus(extension)
    this.initializationStatuses.set(extensionId, status)
    return status
  }

  async reinitialize(extensionId: string): Promise<void> {
    this.registry.require(extensionId)

    if (this.activeExtensions.has(extensionId)) {
      await this.deactivate(extensionId)
    }

    await this.activate(extensionId)
  }

  get(extensionId: string): ExtensionInstance | undefined {
    return this.registry.get(extensionId)
  }

  list(): ExtensionInstance[] {
    return this.registry.list()
  }

  findByCapability(capability: string): ExtensionInstance[] {
    return this.registry.findByCapability(capability)
  }

  unregister(extensionId: string): void {
    this.registry.unregister(extensionId)
  }

  private createContext(extension: ExtensionInstance): ExtensionContext {
    return {
      extensionId: extension.id,
      workspacePath: this.options.workspacePath,
      storagePath: this.options.storagePath,
      initialization: this.createInitializationInfo(extension),
      logger: console,
    }
  }

  private validateManifest(manifest: ExtensionManifest): void {
    if (!isPlainObject(manifest)) {
      throw new Error('Extension manifest must be an object')
    }

    validateExtensionManifestShape(manifest)
  }

  private createKernelFacadeInstance(
    manifest: ExtensionManifest,
    security: ExtensionInstance['security'],
  ): ExtensionInstance {
    const kernelBridge = this.kernelBridge

    return {
      id: manifest.id,
      manifest,
      security,
      activate: async (context) => {
        await kernelBridge.activate(manifest.id, context)
      },
      deactivate: async () => {
        await kernelBridge.deactivate(manifest.id)
      },
      async invoke<TInput = unknown, TOutput = unknown>(capability: string, input: TInput): Promise<TOutput> {
        return kernelBridge.invoke<TInput, TOutput>(manifest.id, capability, input)
      },
      async openSession<TInput = unknown>(capability: string, input: TInput): Promise<ExtensionSession> {
        return kernelBridge.openSession(manifest.id, capability, input)
      },
    }
  }

  private createInitializationInfo(extension: ExtensionInstance): ExtensionInitializationInfo {
    const { manifest, security } = extension
    const metadata = manifest.metadata

    return {
      extensionId: manifest.id,
      extensionType: manifest.runtime,
      artifactKind: manifest.artifact.kind,
      distributionKind: manifest.distribution?.kind,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      protocolVersion: manifest.protocolVersion,
      capabilities: manifest.capabilities.map((capability) => capability.name),
      permissions: manifest.permissions ?? {},
      signature: manifest.signature,
      trust: manifest.trust,
      publisher: metadata?.publisher,
      author: metadata?.author,
      publishedAt: metadata?.publishedAt,
      updatedAt: metadata?.updatedAt,
      authorSignature: metadata?.authorSignature,
      publisherSignature: metadata?.publisherSignature,
      statusCheck: metadata?.statusCheck,
      status: this.initializationStatuses.get(manifest.id) ?? this.createDefaultStatus(extension),
      security,
      supportsManualReinitialize: metadata?.supportsManualReinitialize ?? true,
      isActive: this.activeExtensions.has(manifest.id),
    }
  }

  private createDefaultStatus(
    extension: ExtensionInstance,
    reason = extension.manifest.runtime === 'remote'
      ? 'Remote extension load contract accepted.'
      : 'Extension manifest loaded into manager.',
  ): ExtensionInitializationStatus {
    return {
      state: 'available',
      reason,
      checkedAt: new Date().toISOString(),
    }
  }

  private async resolveInitializationStatus(extension: ExtensionInstance): Promise<ExtensionInitializationStatus> {
    const statusCheck = extension.manifest.metadata?.statusCheck
    if (statusCheck?.kind === 'custom') {
      return {
        state: 'unknown',
        reason: 'Custom status checks must be implemented by the host application.',
        checkedAt: new Date().toISOString(),
      }
    }

    if (statusCheck?.kind === 'url' && statusCheck.endpoint) {
      const blocked = this.getStatusProbeBlock(statusCheck.endpoint, extension)
      if (blocked) {
        return blocked
      }

      return this.probeUrlStatus(statusCheck.endpoint, {
        timeoutMs: statusCheck.timeoutMs,
        method: statusCheck.method,
        expectedStatus: statusCheck.expectedStatus,
      })
    }

    if (statusCheck?.kind === 'jsonrpc' && statusCheck.endpoint) {
      const blocked = this.getStatusProbeBlock(statusCheck.endpoint, extension)
      if (blocked) {
        return blocked
      }

      return this.probeJsonRpcStatus(statusCheck.endpoint, extension.manifest, statusCheck.timeoutMs)
    }

    if (extension.manifest.runtime === 'remote') {
      const endpoint = extension.manifest.artifact.launch?.endpoint ?? extension.manifest.artifact.launch?.command
      const transport = extension.manifest.artifact.launch?.transport ?? 'process'
      if (
        endpoint
        && (transport === 'http' || transport === 'https')
        && (endpoint.startsWith('http://') || endpoint.startsWith('https://'))
      ) {
        const blocked = this.getStatusProbeBlock(endpoint, extension)
        if (blocked) {
          return blocked
        }

        return this.probeJsonRpcStatus(endpoint, extension.manifest, extension.manifest.artifact.launch?.timeoutMs)
      }

      return {
        state: 'unknown',
        reason: 'Remote extension has no built-in status probe for this transport. Configure manifest.metadata.statusCheck.',
        checkedAt: new Date().toISOString(),
      }
    }

    return {
      state: 'available',
      reason: this.activeExtensions.has(extension.id) ? 'Extension is active.' : 'Extension is loaded locally.',
      checkedAt: new Date().toISOString(),
    }
  }

  /**
   * Applies the SSRF guard to a status probe target. Returns a status object
   * describing the rejection, or undefined when the probe may proceed.
   */
  private getStatusProbeBlock(endpoint: string, extension: ExtensionInstance): ExtensionInitializationStatus | undefined {
    const ownEndpoint = extension.manifest.artifact.launch?.endpoint
      ?? extension.manifest.artifact.launch?.command

    try {
      assertStatusProbeAllowed(endpoint, ownEndpoint, this.options.statusProbeAllowedHosts ?? [])
      return undefined
    } catch (error) {
      return {
        state: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      }
    }
  }

  private async probeUrlStatus(
    endpoint: string,
    options: {
      timeoutMs?: number
      method?: 'GET' | 'HEAD' | 'POST'
      expectedStatus?: number
    },
  ): Promise<ExtensionInitializationStatus> {
    const controller = options.timeoutMs ? new AbortController() : undefined
    const timer = options.timeoutMs
      ? setTimeout(() => controller?.abort(), options.timeoutMs)
      : undefined

    try {
      const response = await fetch(endpoint, {
        method: options.method ?? 'GET',
        signal: controller?.signal,
      })
      const expectedStatus = options.expectedStatus ?? 200
      if (response.status !== expectedStatus) {
        return {
          state: 'unavailable',
          reason: `Status probe returned HTTP ${response.status}; expected ${expectedStatus}.`,
          checkedAt: new Date().toISOString(),
        }
      }

      return {
        state: 'available',
        reason: `Status probe returned HTTP ${response.status}.`,
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      return {
        state: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      }
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  private async probeJsonRpcStatus(
    endpoint: string,
    manifest: ExtensionManifest,
    timeoutMs?: number,
  ): Promise<ExtensionInitializationStatus> {
    const controller = timeoutMs ? new AbortController() : undefined
    const timer = timeoutMs
      ? setTimeout(() => controller?.abort(), timeoutMs)
      : undefined

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `${manifest.id}:status`,
          method: 'extension/status',
          params: {
            extensionId: manifest.id,
            manifest,
          },
        }),
        signal: controller?.signal,
      })

      if (!response.ok) {
        return {
          state: 'unavailable',
          reason: `JSON-RPC probe failed with HTTP ${response.status}.`,
          checkedAt: new Date().toISOString(),
        }
      }

      const payload = await response.json() as {
        result?: {
          state?: ExtensionInitializationStatus['state']
          reason?: string
        }
        error?: { message?: string }
      }
      if (payload.error) {
        return {
          state: 'unavailable',
          reason: payload.error.message ?? 'JSON-RPC status probe returned an error.',
          checkedAt: new Date().toISOString(),
        }
      }

      if (payload.result?.state) {
        return {
          state: payload.result.state,
          reason: payload.result.reason ?? 'Remote endpoint returned JSON-RPC status.',
          checkedAt: new Date().toISOString(),
        }
      }

      return {
        state: 'available',
        reason: 'Remote endpoint accepted the JSON-RPC status probe.',
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      return {
        state: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      }
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}

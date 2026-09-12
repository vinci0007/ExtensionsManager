import type { ExtensionContext } from '../contracts/ExtensionContext.js'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionSession } from '../contracts/ExtensionSession.js'
import type { KernelPolicyConfig, PolicyConsentRequest } from '../contracts/KernelPolicy.js'
import { requiresRealSession, resolveSessionContract } from '../core/sessionContracts.js'
import { ExtensionProcessError } from '../errors/ExtensionError.js'
import { ArtifactResolver, type ResolvedArtifact } from '../core/ArtifactResolver.js'
import { RuntimeRouter, type ExtensionRuntimeAdapter } from '../core/RuntimeRouter.js'
import type { ExtensionSecurityCore } from '../security/ExtensionSecurityCore.js'
import { TypeScriptSecurityCore, type TypeScriptSecurityCoreOptions } from '../security/ExtensionSecurityCore.js'
import { verifyArtifactIntegrity } from '../security/artifactIntegrity.js'
import { createCompatibilitySession } from '../runtimes/sessionRuntimeUtils.js'
import type { KernelBridge, KernelBridgeLoadResult } from './KernelBridge.js'

interface LocalKernelBridgeOptions extends TypeScriptSecurityCoreOptions {
  adapters?: ExtensionRuntimeAdapter[]
  securityCore?: ExtensionSecurityCore
  /** Performance policy: load-time admission mirror of the kernel tiers. */
  policy?: KernelPolicyConfig
  /** Consent handler for policy exceptions; absent = fail-closed. */
  onPolicyConsent?: (request: PolicyConsentRequest) => Promise<boolean>
}

export class LocalKernelBridge implements KernelBridge {
  private readonly artifactResolver = new ArtifactResolver()
  private readonly runtimeRouter = new RuntimeRouter()
  private readonly loaded = new Map<string, LoadedRuntimeRecord>()
  private readonly activeExtensions = new Set<string>()
  private readonly securityCore: ExtensionSecurityCore
  private readonly options: LocalKernelBridgeOptions

  constructor(options: LocalKernelBridgeOptions = {}) {
    this.options = options
    options.adapters?.forEach((adapter) => this.runtimeRouter.register(adapter))
    this.securityCore = options.securityCore ?? new TypeScriptSecurityCore(options)
  }

  registerRuntime(adapter: ExtensionRuntimeAdapter): void {
    this.runtimeRouter.register(adapter)
  }

  async load(manifest: ExtensionManifest, basePath: string): Promise<KernelBridgeLoadResult> {
    await this.assertPolicyAdmission(manifest)
    const security = await this.securityCore.evaluateManifest(manifest)
    const artifact = this.artifactResolver.resolve(manifest, basePath)
    await verifyArtifactIntegrity(manifest, artifact.entryPath)
    const extension = await this.runtimeRouter.load(manifest, artifact)
    extension.security = security
    this.loaded.set(manifest.id, {
      extension,
      manifest,
      artifact,
      security,
      needsRecreate: false,
    })
    return { security }
  }

  /**
   * Local-bridge mirror of the kernel's admission: manifest-declared resource
   * budgets must fit the tiers configured by the host policy, and resident
   * extensions must declare their peak against the host total budget.
   * The daemon path enforces the same checks inside the Rust kernel.
   */
  private async assertPolicyAdmission(manifest: ExtensionManifest): Promise<void> {
    const policy = this.options.policy
    if (!policy?.memory) {
      return
    }

    // Resident-class check first: it applies even when tiers are not
    // configured (the reservation needs the total budget + declared peak).
    if (manifest.extensionClass === 'resident') {
      const totalMb = policy.memory.totalMb
      if (totalMb === undefined) {
        throw new Error(
          'resident extension requires the host to configure policy.memory.totalMb (reserved budget); '
          + 'no total budget is configured',
        )
      }
      const residentDeclaredMb = Math.max(
        0,
        ...manifest.capabilities.map((capability) => capability.resourceBudget?.memoryMb ?? 0),
      )
      if (residentDeclaredMb === 0) {
        throw new Error('resident extension must declare resourceBudget.memoryMb (its reserved peak)')
      }
      if (residentDeclaredMb > totalMb) {
        const reason = `resident reservation of ${residentDeclaredMb} MB exceeds the host memory budget (${totalMb} MB total)`
        await this.requireConsentOrFail({
          type: 'residentOverBudget',
          extensionId: manifest.id,
          declaredMb: residentDeclaredMb,
          capMb: totalMb,
          reason,
        })
      }
    }

    const tiers = policy.memory.tiers
    if (!tiers) {
      return
    }

    let tier: 'batch' | 'interactive' | 'realtime' = 'batch'
    let declaredMb = 0
    for (const capability of manifest.capabilities) {
      const capabilityTier = capability.realtimeClass ?? 'batch'
      if (capabilityTier === 'realtime') {
        tier = 'realtime'
      } else if (capabilityTier === 'interactive' && tier === 'batch') {
        tier = 'interactive'
      }
      declaredMb = Math.max(declaredMb, capability.resourceBudget?.memoryMb ?? 0)
    }

    const tierCapMb: number | undefined = tier === 'realtime'
      ? tiers.realtimeMb
      : tier === 'interactive'
        ? tiers.interactiveMb
        : tiers.batchMb
    if (tierCapMb === undefined || declaredMb === 0) {
      return
    }

    if (declaredMb > tierCapMb) {
      const reason = `declared resourceBudget.memoryMb ${declaredMb} MB exceeds the ${tier} tier cap ${tierCapMb} MB configured by the host policy; `
        + 'reduce the declaration, or ask the host to raise the tier cap'
      await this.requireConsentOrFail({
        type: 'memoryTierOverflow',
        extensionId: manifest.id,
        declaredMb,
        capMb: tierCapMb,
        reason,
      })
    }
  }

  /**
   * Consent gate for policy exceptions: ask the host handler when present,
   * fail closed when absent. Approved exceptions proceed (the daemon path
   * additionally records the override in its audit log).
   */
  private async requireConsentOrFail(request: PolicyConsentRequest): Promise<void> {
    const handler = this.options.onPolicyConsent
    if (!handler) {
      throw new Error(`${request.reason} (rejected: no consent handler configured)`)
    }
    const approved = await handler(request)
    if (!approved) {
      throw new Error(`${request.reason} (rejected by consent handler)`)
    }
  }

  async activate(extensionId: string, context: ExtensionContext): Promise<void> {
    if (this.activeExtensions.has(extensionId)) {
      return
    }

    const loaded = this.requireLoaded(extensionId)
    await this.ensureRuntimeReady(loaded)
    const extension = loaded.extension
    await extension.activate(context)
    this.activeExtensions.add(extensionId)
  }

  async deactivate(extensionId: string): Promise<void> {
    if (!this.activeExtensions.has(extensionId)) {
      return
    }

    const loaded = this.requireLoaded(extensionId)
    await loaded.extension.deactivate()
    this.activeExtensions.delete(extensionId)
    if (shouldReloadRuntime(loaded.manifest.runtime)) {
      loaded.needsRecreate = true
    }
  }

  async invoke<TInput = unknown, TOutput = unknown>(
    extensionId: string,
    capability: string,
    input: TInput,
  ): Promise<TOutput> {
    return this.requireLoaded(extensionId).extension.invoke<TInput, TOutput>(capability, input)
  }

  async openSession(extensionId: string, capability: string, input: unknown): Promise<ExtensionSession> {
    const loaded = this.requireLoaded(extensionId)
    await this.ensureRuntimeReady(loaded)
    const contract = resolveSessionContract(loaded.manifest, capability)

    if (typeof loaded.extension.openSession === 'function') {
      return loaded.extension.openSession(capability, input)
    }

    if (requiresRealSession(contract)) {
      throw new ExtensionProcessError(`Capability requires a real session implementation: ${capability}`)
    }

    const output = await this.invoke(extensionId, capability, input)
    return createCompatibilitySession(
      `${extensionId}:${capability}:local`,
      output,
      contract,
      'Local kernel session has no more events',
    )
  }

  async dispose(): Promise<void> {
    const activeExtensionIds = [...this.activeExtensions]
    for (const extensionId of activeExtensionIds) {
      await this.deactivate(extensionId)
    }
    this.activeExtensions.clear()
    this.loaded.clear()
  }

  private requireLoaded(extensionId: string) {
    const loaded = this.loaded.get(extensionId)
    if (!loaded) {
      throw new ExtensionProcessError(`Extension not loaded in local kernel bridge: ${extensionId}`)
    }

    return loaded
  }

  private async ensureRuntimeReady(loaded: LoadedRuntimeRecord): Promise<void> {
    if (!loaded.needsRecreate) {
      return
    }

    const reloaded = await this.runtimeRouter.load(loaded.manifest, loaded.artifact)
    reloaded.security = loaded.security
    loaded.extension = reloaded
    loaded.needsRecreate = false
  }
}

interface LoadedRuntimeRecord {
  extension: Awaited<ReturnType<RuntimeRouter['load']>>
  manifest: ExtensionManifest
  artifact: ResolvedArtifact
  security: KernelBridgeLoadResult['security']
  needsRecreate: boolean
}

function shouldReloadRuntime(runtime: ExtensionManifest['runtime']): boolean {
  return runtime === 'process' || runtime === 'native' || runtime === 'remote'
}

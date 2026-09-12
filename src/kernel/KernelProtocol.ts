import type {
  ExtensionCapability,
  ExtensionConcurrencyPolicy,
  ExtensionExecutionMode,
  ExtensionInteractionMode,
  ExtensionRealtimeClass,
  ExtensionResourceBudget,
} from '../contracts/ExtensionCapability.js'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionPermissionSet } from '../contracts/ExtensionPermissions.js'
import type { ExtensionSecurityInfo } from '../contracts/ExtensionInstance.js'
import type { ExtensionSessionEvent } from '../contracts/ExtensionSession.js'
import type { CanonicalRuntimeSpec } from '../contracts/KernelRuntime.js'
import type { RevocationList, TrustBundle } from '../contracts/TrustBundle.js'
import type { ResolvedArtifact } from '../core/ArtifactResolver.js'
import type { SignaturePolicy } from '../security/SignaturePolicy.js'

export interface KernelSecurityContext {
  signaturePolicy?: SignaturePolicy
  isDevelopment?: boolean
  trustBundle?: TrustBundle
  revocationList?: RevocationList
  trustedKeyDirectory?: string
  trustedPublicKeys?: Record<string, string>
}

export interface CanonicalKernelCapability extends ExtensionCapability {
  interactionMode: ExtensionInteractionMode
  executionMode: ExtensionExecutionMode
  realtimeClass: ExtensionRealtimeClass
  concurrencyPolicy: ExtensionConcurrencyPolicy
  resourceBudget: ExtensionResourceBudget
}

export interface KernelLoadRequest {
  manifest: ExtensionManifest
  runtime: CanonicalRuntimeSpec
  capabilities: CanonicalKernelCapability[]
  permissions: ExtensionPermissionSet
  artifact: ResolvedArtifact
  security: KernelSecurityContext
}

export interface KernelLoadResult {
  extensionId: string
  security: ExtensionSecurityInfo
}

export interface KernelSessionOpenResult {
  sessionId: string
}

export type KernelRequestMethod =
  | 'kernel.policy.set'
  | 'kernel.load'
  | 'kernel.activate'
  | 'kernel.deactivate'
  | 'kernel.invoke'
  | 'kernel.openSession'
  | 'kernel.session.send'
  | 'kernel.session.close'
  | 'kernel.cancel'

export interface KernelRequestEnvelope {
  kind: 'request'
  id: string
  method: KernelRequestMethod
  params?: unknown
}

export interface KernelResponseEnvelope {
  kind: 'response'
  id: string
  result?: unknown
  error?: {
    code: string
    message: string
  }
}

export interface KernelEventEnvelope {
  kind: 'event'
  sessionId: string
  event: ExtensionSessionEvent
}

export type KernelEnvelope = KernelRequestEnvelope | KernelResponseEnvelope | KernelEventEnvelope

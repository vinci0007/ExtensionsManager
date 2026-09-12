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
  | 'kernel.audit.query'

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

export type KernelEnvelope =
  | KernelRequestEnvelope
  | KernelResponseEnvelope
  | KernelEventEnvelope
  | KernelAuditEventEnvelope

/** Cursor query over the kernel's bounded audit ring (see kernel.audit.query). */
export interface KernelAuditQuery {
  /** Only entries with seq greater than this cursor (0 = from the start). */
  sinceSeq?: number
  /** Maximum entries to return (kernel clamps to the ring capacity). */
  limit?: number
}

export interface KernelAuditEntry {
  seq: number
  timestampMs: number
  kind: string
  extensionId: string
  detail: string
}

export interface KernelAuditAccounting {
  extensionId: string
  callCount: number
  totalNs: number
  peakNs: number
  fuelTraps: number
  memorySoftBreaches: number
  memoryGrowthDenials: number
  memoryHighWaterBytes: number
  fuelConsumedTotal: number
  contractViolations: number
}

export interface KernelAuditResult {
  entries: KernelAuditEntry[]
  /** GLOBAL newest sequence (even beyond the returned batch) — the next cursor. */
  lastSeq: number
  accounting: KernelAuditAccounting[]
}

/**
 * Governance event pushed by the kernel through the response sink the moment
 * an audit entry is recorded (scheduler deliveries share the same channel).
 */
export interface KernelAuditEventEnvelope {
  kind: 'audit'
  entry: KernelAuditEntry
}

import type { ExtensionArtifact } from './ExtensionArtifact.js'
import type { ExtensionCapability } from './ExtensionCapability.js'
import type { ExtensionPermissionSet } from './ExtensionPermissions.js'
import type { ExtensionRuntime } from './ExtensionRuntime.js'
import type { ExtensionSettingDefinition } from './ExtensionSettings.js'
import type { ExtensionSignature } from './ExtensionSignature.js'

export type ExtensionTrustDomain = 'official' | 'third-party' | 'private'

export interface ExtensionTrustMetadata {
  publisherId: string
  trustDomain: ExtensionTrustDomain
  issuedBy: string
  signingIdentityId?: string
  issuedAt?: string
  expiresAt?: string
}

export interface ExtensionDistribution {
  kind: 'directory' | 'archive' | 'package'
  source?: string
}

export interface ExtensionPartyInfo {
  id?: string
  name?: string
  email?: string
  url?: string
}

export type ExtensionStatusCheckKind = 'url' | 'jsonrpc' | 'custom'

export interface ExtensionStatusCheck {
  kind: ExtensionStatusCheckKind
  endpoint?: string
  method?: 'GET' | 'HEAD' | 'POST'
  expectedStatus?: number
  timeoutMs?: number
}

export interface ExtensionManifestMetadata {
  publisher?: ExtensionPartyInfo
  author?: ExtensionPartyInfo
  publishedAt?: string
  updatedAt?: string
  statusCheck?: ExtensionStatusCheck
  supportsManualReinitialize?: boolean
  tags?: string[]
  authorSignature?: ExtensionSignature
  publisherSignature?: ExtensionSignature
}

export type ExtensionClass = 'transient' | 'standard' | 'resident'

export interface ExtensionManifest {
  id: string
  name?: string
  description?: string
  version: string
  protocolVersion: string
  /**
   * Citizen class for the policy engine: transient (batch/async, best-effort),
   * standard (interactive, default), resident (frame-critical with reserved
   * resources — requires resourceBudget.memoryMb and host memory budget).
   */
  extensionClass?: ExtensionClass
  distribution?: ExtensionDistribution
  trust?: ExtensionTrustMetadata
  metadata?: ExtensionManifestMetadata
  artifact: ExtensionArtifact
  runtime: ExtensionRuntime
  activationEvents?: string[]
  capabilities: ExtensionCapability[]
  /**
   * Declarative user settings: the host UI renders them generically, the
   * manager validates and stores values, and the plugin receives the current
   * values as `context.settings` on every (re)activation.
   */
  settings?: ExtensionSettingDefinition[]
  permissions?: ExtensionPermissionSet
  signature?: ExtensionSignature
}

import type { ExtensionArtifactKind } from './ExtensionArtifact.js'
import type { ExtensionDistribution, ExtensionManifestMetadata, ExtensionTrustMetadata } from './ExtensionManifest.js'
import type { ExtensionPermissionSet } from './ExtensionPermissions.js'
import type { ExtensionRuntime } from './ExtensionRuntime.js'
import type { ExtensionSignature } from './ExtensionSignature.js'
import type { ExtensionSecurityInfo } from './ExtensionInstance.js'

export type ExtensionInitializationStatusState = 'unknown' | 'available' | 'unavailable'

export interface ExtensionInitializationStatus {
  state: ExtensionInitializationStatusState
  reason: string
  checkedAt: string
}

export interface ExtensionInitializationInfo {
  extensionId: string
  extensionType: ExtensionRuntime
  artifactKind: ExtensionArtifactKind
  distributionKind?: ExtensionDistribution['kind']
  name?: string
  description?: string
  version: string
  protocolVersion: string
  capabilities: string[]
  permissions: ExtensionPermissionSet
  signature?: ExtensionSignature
  trust?: ExtensionTrustMetadata
  publisher?: ExtensionManifestMetadata['publisher']
  author?: ExtensionManifestMetadata['author']
  publishedAt?: string
  updatedAt?: string
  authorSignature?: ExtensionManifestMetadata['authorSignature']
  publisherSignature?: ExtensionManifestMetadata['publisherSignature']
  statusCheck?: ExtensionManifestMetadata['statusCheck']
  status: ExtensionInitializationStatus
  security: ExtensionSecurityInfo
  supportsManualReinitialize: boolean
  isActive: boolean
}

import type { ExtensionTrustDomain } from './ExtensionManifest.js'

export type TrustAuthorization = 'authorized' | 'untrusted'

export interface TrustBundleIssuer {
  id: string
  trustDomain: ExtensionTrustDomain
  publicKeyPem: string
  authorization?: TrustAuthorization
  allowedPublisherIds?: string[]
}

export interface TrustBundle {
  version: string
  issuers: TrustBundleIssuer[]
}

export interface RevokedSignatureKey {
  keyId: string
  reason?: string
  revokedAt?: string
}

export interface RevokedIssuer {
  issuerId: string
  reason?: string
  revokedAt?: string
}

export interface RevokedPublisher {
  publisherId: string
  reason?: string
  revokedAt?: string
}

export interface RevocationList {
  version: string
  revokedSignatureKeys?: RevokedSignatureKey[]
  revokedIssuers?: RevokedIssuer[]
  revokedPublishers?: RevokedPublisher[]
}

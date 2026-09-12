import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionSecurityInfo } from '../contracts/ExtensionInstance.js'
import type { RevocationList, TrustBundle } from '../contracts/TrustBundle.js'

export interface TrustPolicyOptions {
  trustBundle?: TrustBundle
  revocationList?: RevocationList
}

export function enforceTrustPolicy(manifest: ExtensionManifest, options: TrustPolicyOptions): ExtensionSecurityInfo {
  enforceRevocations(manifest, options.revocationList)

  if (!manifest.signature) {
    return {
      status: 'unsigned',
      reason: 'Extension has no manifest signature.',
    }
  }

  if (!options.trustBundle) {
    return {
      status: 'third-party-untrusted',
      reason: 'Signed extension has no official authorization trust bundle.',
    }
  }

  return enforceTrustBundle(manifest, options.trustBundle)
}

function enforceRevocations(manifest: ExtensionManifest, revocationList: RevocationList | undefined): void {
  if (!revocationList) {
    return
  }

  const signatureKeyId = manifest.signature?.keyId
  if (signatureKeyId && revocationList.revokedSignatureKeys?.some((item) => item.keyId === signatureKeyId)) {
    throw new Error(`Extension signature key revoked: ${signatureKeyId}`)
  }

  const trust = manifest.trust
  if (!trust) {
    return
  }

  if (revocationList.revokedIssuers?.some((item) => item.issuerId === trust.issuedBy)) {
    throw new Error(`Extension issuer revoked: ${trust.issuedBy}`)
  }

  if (revocationList.revokedPublishers?.some((item) => item.publisherId === trust.publisherId)) {
    throw new Error(`Extension publisher revoked: ${trust.publisherId}`)
  }
}

function enforceTrustBundle(manifest: ExtensionManifest, trustBundle: TrustBundle): ExtensionSecurityInfo {
  const trust = manifest.trust
  if (!trust) {
    return {
      status: 'third-party-untrusted',
      reason: 'Signed extension has no official trust metadata.',
    }
  }

  const issuer = trustBundle.issuers.find((item) => item.id === trust.issuedBy)
  if (!issuer) {
    return {
      status: 'third-party-untrusted',
      reason: `Extension issuer is not authorized: ${trust.issuedBy}`,
    }
  }

  if (issuer.trustDomain !== trust.trustDomain) {
    throw new Error(`Extension trust domain mismatch for issuer: ${trust.issuedBy}`)
  }

  if (issuer.allowedPublisherIds && !issuer.allowedPublisherIds.includes(trust.publisherId)) {
    throw new Error(`Extension publisher is not allowed by issuer: ${trust.publisherId}`)
  }

  if (trust.expiresAt && Date.parse(trust.expiresAt) <= Date.now()) {
    throw new Error(`Extension trust metadata expired: ${manifest.id}`)
  }

  if (issuer.authorization !== 'authorized') {
    return {
      status: 'third-party-untrusted',
      reason: `Extension issuer is not officially authorized: ${trust.issuedBy}`,
    }
  }

  return {
    status: 'authorized-safe',
    reason: `Extension manifest is signed by authorized issuer: ${trust.issuedBy}`,
  }
}

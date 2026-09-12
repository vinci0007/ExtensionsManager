import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { SignaturePolicy } from './SignaturePolicy.js'

export function shouldRequireSignature(policy: SignaturePolicy, isDevelopment: boolean): boolean {
  if (policy === 'allow-unsigned') {
    return false
  }

  if (policy === 'require-signature') {
    return true
  }

  if (policy === 'require-signature-except-development') {
    return !isDevelopment
  }

  // Unknown policy values (including JS callers passing garbage that bypassed
  // the type system) fail closed: require the signature.
  return true
}

export function enforceSignaturePolicy(
  manifest: ExtensionManifest,
  policy: SignaturePolicy,
  isDevelopment: boolean,
): void {
  if (!shouldRequireSignature(policy, isDevelopment)) {
    return
  }

  if (!manifest.signature) {
    throw new Error(
      `Extension signature required by policy: ${manifest.id}. `
      + 'Declare isDevelopment: true while developing, or set signaturePolicy: "allow-unsigned" to accept unsigned plugins, or sign the manifest.',
    )
  }
}

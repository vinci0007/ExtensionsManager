import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionSignatureVerifier } from './PublicKeySignatureVerifier.js'
import type { SignaturePolicy } from './SignaturePolicy.js'
import { enforceSignaturePolicy } from './enforceSignaturePolicy.js'

export interface ExtensionSignatureEvaluator {
  evaluateManifest(manifest: ExtensionManifest): void | Promise<void>
}

export interface TypeScriptSignatureEvaluatorOptions {
  signatureVerifier?: ExtensionSignatureVerifier
  signaturePolicy?: SignaturePolicy
  isDevelopment?: boolean
}

export class TypeScriptSignatureEvaluator implements ExtensionSignatureEvaluator {
  constructor(private readonly options: TypeScriptSignatureEvaluatorOptions = {}) {}

  async evaluateManifest(manifest: ExtensionManifest): Promise<void> {
    // Secure-by-default: an unconfigured policy behaves as
    // 'require-signature-except-development' — unsigned plugins load only when
    // the host explicitly declares isDevelopment: true. Hosts that want the
    // open behavior must opt in with signaturePolicy: 'allow-unsigned'.
    enforceSignaturePolicy(
      manifest,
      this.options.signaturePolicy ?? 'require-signature-except-development',
      this.options.isDevelopment ?? false,
    )

    if (!manifest.signature) {
      return
    }

    if (!this.options.signatureVerifier) {
      throw new Error(`Extension signature present but no verifier configured: ${manifest.id}`)
    }

    await this.options.signatureVerifier.verify(manifest)
  }
}

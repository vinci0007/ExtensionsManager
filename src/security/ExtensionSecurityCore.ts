import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionSecurityInfo } from '../contracts/ExtensionInstance.js'
import {
  TypeScriptSignatureEvaluator,
  type ExtensionSignatureEvaluator,
  type TypeScriptSignatureEvaluatorOptions,
} from './ExtensionSignatureEvaluator.js'
import {
  TypeScriptTrustEvaluator,
  type ExtensionTrustEvaluator,
  type TypeScriptTrustEvaluatorOptions,
} from './ExtensionTrustEvaluator.js'

export interface ExtensionSecurityCore {
  evaluateManifest(manifest: ExtensionManifest): ExtensionSecurityInfo | Promise<ExtensionSecurityInfo>
}

export interface TypeScriptSecurityCoreOptions extends TypeScriptSignatureEvaluatorOptions, TypeScriptTrustEvaluatorOptions {
  signatureEvaluator?: ExtensionSignatureEvaluator
  trustEvaluator?: ExtensionTrustEvaluator
}

export class TypeScriptSecurityCore implements ExtensionSecurityCore {
  private readonly signatureEvaluator: ExtensionSignatureEvaluator
  private readonly trustEvaluator: ExtensionTrustEvaluator

  constructor(private readonly options: TypeScriptSecurityCoreOptions = {}) {
    this.signatureEvaluator = options.signatureEvaluator ?? new TypeScriptSignatureEvaluator({
      signatureVerifier: options.signatureVerifier,
      signaturePolicy: options.signaturePolicy,
      isDevelopment: options.isDevelopment,
    })
    this.trustEvaluator = options.trustEvaluator ?? new TypeScriptTrustEvaluator({
      trustBundle: options.trustBundle,
      revocationList: options.revocationList,
    })
  }

  async evaluateManifest(manifest: ExtensionManifest): Promise<ExtensionSecurityInfo> {
    await this.signatureEvaluator.evaluateManifest(manifest)
    return this.trustEvaluator.evaluateManifest(manifest)
  }
}

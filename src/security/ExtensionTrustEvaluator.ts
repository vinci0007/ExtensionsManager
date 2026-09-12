import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionSecurityInfo } from '../contracts/ExtensionInstance.js'
import type { RevocationList, TrustBundle } from '../contracts/TrustBundle.js'
import { enforceTrustPolicy } from './enforceTrustPolicy.js'

export interface ExtensionTrustEvaluator {
  evaluateManifest(manifest: ExtensionManifest): ExtensionSecurityInfo | Promise<ExtensionSecurityInfo>
}

export interface TypeScriptTrustEvaluatorOptions {
  trustBundle?: TrustBundle
  revocationList?: RevocationList
}

export class TypeScriptTrustEvaluator implements ExtensionTrustEvaluator {
  constructor(private readonly options: TypeScriptTrustEvaluatorOptions = {}) {}

  evaluateManifest(manifest: ExtensionManifest): ExtensionSecurityInfo {
    return enforceTrustPolicy(manifest, this.options)
  }
}

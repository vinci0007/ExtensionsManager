import { createPrivateKey, sign as cryptoSign } from 'node:crypto'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionSignature } from '../contracts/ExtensionSignature.js'
import { canonicalizeManifest } from './canonicalizeManifest.js'

export interface SignManifestOptions {
  keyId: string
  algorithm: ExtensionSignature['algorithm']
  privateKeyPem: string
  signedAt?: string
}

export function signManifest(manifest: ExtensionManifest, options: SignManifestOptions): ExtensionSignature {
  const key = createPrivateKey(options.privateKeyPem)
  const payload = Buffer.from(canonicalizeManifest(manifest), 'utf8')
  const signature = options.algorithm === 'ed25519'
    ? cryptoSign(null, payload, key)
    : cryptoSign('sha256', payload, key)

  return {
    algorithm: options.algorithm,
    keyId: options.keyId,
    value: signature.toString('base64'),
    signedAt: options.signedAt,
  }
}

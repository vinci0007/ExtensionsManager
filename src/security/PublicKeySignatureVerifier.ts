import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import { canonicalizeManifest } from './canonicalizeManifest.js'

export interface ExtensionSignatureVerifier {
  verify(manifest: ExtensionManifest): void | Promise<void>
}

export interface TrustedKeyStore {
  getPublicKey(keyId: string): string | undefined
}

export class PublicKeySignatureVerifier implements ExtensionSignatureVerifier {
  constructor(private readonly keyStore: TrustedKeyStore) {}

  verify(manifest: ExtensionManifest): void {
    const signature = manifest.signature

    if (!signature) {
      return
    }

    const publicKey = this.keyStore.getPublicKey(signature.keyId)
    if (!publicKey) {
      throw new Error(`Untrusted signature key: ${signature.keyId}`)
    }

    const signedPayload = Buffer.from(canonicalizeManifest(manifest), 'utf8')
    const key = createPublicKey(publicKey)
    const signatureBytes = Buffer.from(signature.value, 'base64')

    const verified = signature.algorithm === 'ed25519'
      ? cryptoVerify(null, signedPayload, key, signatureBytes)
      : cryptoVerify('sha256', signedPayload, key, signatureBytes)

    if (!verified) {
      throw new Error(`Invalid manifest signature: ${manifest.id}`)
    }
  }
}

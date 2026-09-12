export interface ExtensionSignature {
  algorithm: 'ed25519' | 'rsa-sha256'
  keyId: string
  value: string
  signedAt?: string
}

import { generateKeyPairSync } from 'node:crypto'
import type { ExtensionSignature } from '../contracts/ExtensionSignature.js'

export interface GeneratedKeyPair {
  publicKeyPem: string
  privateKeyPem: string
  algorithm: ExtensionSignature['algorithm']
}

export function generateSigningKeyPair(algorithm: ExtensionSignature['algorithm']): GeneratedKeyPair {
  if (algorithm === 'ed25519') {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    return {
      algorithm,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  return {
    algorithm,
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
  }
}

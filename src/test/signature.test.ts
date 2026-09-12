import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ExtensionManifest } from '../index.js'
import {
  FileTrustedKeyStore,
  PublicKeySignatureVerifier,
  generateSigningKeyPair,
  signManifest,
} from '../index.js'

test('signs and verifies a manifest', () => {
  const keyPair = generateSigningKeyPair('ed25519')
  const manifest: ExtensionManifest = {
    id: 'demo.signed-extension',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: { kind: 'module', entry: './index.js' },
    runtime: 'node',
    capabilities: [{ name: 'demo.hello' }],
  }

  const signature = signManifest(manifest, {
    algorithm: 'ed25519',
    keyId: 'demo-key',
    privateKeyPem: keyPair.privateKeyPem,
  })

  const signedManifest: ExtensionManifest = {
    ...manifest,
    signature,
  }

  const verifier = new PublicKeySignatureVerifier({
    getPublicKey(keyId: string) {
      return keyId === 'demo-key' ? keyPair.publicKeyPem : undefined
    },
  })

  verifier.verify(signedManifest)
  assert.ok(true)
})

test('signs and verifies a manifest with rsa-sha256', () => {
  const keyPair = generateSigningKeyPair('rsa-sha256')
  const manifest: ExtensionManifest = {
    id: 'demo.rsa-signed-extension',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: { kind: 'module', entry: './index.js' },
    runtime: 'node',
    capabilities: [{ name: 'demo.hello' }],
  }

  const signature = signManifest(manifest, {
    algorithm: 'rsa-sha256',
    keyId: 'demo-rsa-key',
    privateKeyPem: keyPair.privateKeyPem,
  })

  const signedManifest: ExtensionManifest = {
    ...manifest,
    signature,
  }

  const verifier = new PublicKeySignatureVerifier({
    getPublicKey(keyId: string) {
      return keyId === 'demo-rsa-key' ? keyPair.publicKeyPem : undefined
    },
  })

  verifier.verify(signedManifest)
  assert.ok(true)
})

test('verifies a manifest with file-backed trusted keys', async () => {
  const keyPair = generateSigningKeyPair('ed25519')
  const keyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-keys-'))

  try {
    await fs.writeFile(path.join(keyDirectory, 'demo-key.pem'), keyPair.publicKeyPem, 'utf8')

    const manifest: ExtensionManifest = {
      id: 'demo.file-backed-signed-extension',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.hello' }],
    }

    const signature = signManifest(manifest, {
      algorithm: 'ed25519',
      keyId: 'demo-key',
      privateKeyPem: keyPair.privateKeyPem,
    })

    const signedManifest: ExtensionManifest = {
      ...manifest,
      signature,
    }

    const verifier = new PublicKeySignatureVerifier(new FileTrustedKeyStore(keyDirectory))
    verifier.verify(signedManifest)
    assert.ok(true)
  } finally {
    await fs.rm(keyDirectory, { recursive: true, force: true })
  }
})

test('rejects unknown public keys', () => {
  const verifier = new PublicKeySignatureVerifier({
    getPublicKey() {
      return undefined
    },
  })

  const manifest: ExtensionManifest = {
    id: 'demo.signed-extension',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: { kind: 'module', entry: './index.js' },
    runtime: 'node',
    capabilities: [{ name: 'demo.hello' }],
    signature: {
      algorithm: 'ed25519',
      keyId: 'missing',
      value: 'AAAA',
    },
  }

  assert.throws(() => verifier.verify(manifest), /Untrusted signature key/)
})

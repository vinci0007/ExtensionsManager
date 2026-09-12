import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionManifest, RevocationList, TrustBundle } from '../index.js'
import { enforceTrustPolicy, generateSigningKeyPair, signManifest } from '../index.js'

function createTrustedManifest(): ExtensionManifest {
  const keyPair = generateSigningKeyPair('ed25519')
  const manifest: ExtensionManifest = {
    id: 'demo.trusted-extension',
    version: '1.0.0',
    protocolVersion: '1',
    trust: {
      publisherId: 'publisher.demo',
      trustDomain: 'third-party',
      issuedBy: 'third-party-issuer',
      signingIdentityId: 'signing-identity.demo',
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
    artifact: { kind: 'module', entry: './index.js' },
    runtime: 'node',
    capabilities: [{ name: 'demo.hello' }],
  }

  return {
    ...manifest,
    signature: signManifest(manifest, {
      algorithm: 'ed25519',
      keyId: 'demo-key',
      privateKeyPem: keyPair.privateKeyPem,
    }),
  }
}

const authorizedTrustBundle: TrustBundle = {
  version: '1',
  issuers: [
    {
      id: 'third-party-issuer',
      trustDomain: 'third-party',
      publicKeyPem: 'unused in local policy checks',
      authorization: 'authorized',
      allowedPublisherIds: ['publisher.demo'],
    },
  ],
}

test('marks manifest safe only when issuer is officially authorized', () => {
  const security = enforceTrustPolicy(createTrustedManifest(), { trustBundle: authorizedTrustBundle })
  assert.deepEqual(security, {
    status: 'authorized-safe',
    reason: 'Extension manifest is signed by authorized issuer: third-party-issuer',
  })
})

test('marks signed manifest untrusted when no official trust bundle is configured', () => {
  const security = enforceTrustPolicy(createTrustedManifest(), {})
  assert.deepEqual(security, {
    status: 'third-party-untrusted',
    reason: 'Signed extension has no official authorization trust bundle.',
  })
})

test('marks signed manifest untrusted when issuer is not in trust bundle', () => {
  const manifest = createTrustedManifest()
  manifest.trust = {
    ...manifest.trust!,
    issuedBy: 'unknown-issuer',
  }

  const security = enforceTrustPolicy(manifest, { trustBundle: authorizedTrustBundle })
  assert.deepEqual(security, {
    status: 'third-party-untrusted',
    reason: 'Extension issuer is not authorized: unknown-issuer',
  })
})

test('marks signed manifest untrusted when issuer exists but lacks official authorization', () => {
  const trustBundle: TrustBundle = {
    version: '1',
    issuers: [
      {
        id: 'third-party-issuer',
        trustDomain: 'third-party',
        publicKeyPem: 'unused in local policy checks',
        authorization: 'untrusted',
        allowedPublisherIds: ['publisher.demo'],
      },
    ],
  }

  const security = enforceTrustPolicy(createTrustedManifest(), { trustBundle })
  assert.deepEqual(security, {
    status: 'third-party-untrusted',
    reason: 'Extension issuer is not officially authorized: third-party-issuer',
  })
})

test('rejects manifest when issuer trust domain does not match trust metadata', () => {
  const trustBundle: TrustBundle = {
    version: '1',
    issuers: [
      {
        id: 'third-party-issuer',
        trustDomain: 'official',
        publicKeyPem: 'unused in local policy checks',
        authorization: 'authorized',
        allowedPublisherIds: ['publisher.demo'],
      },
    ],
  }

  assert.throws(
    () => enforceTrustPolicy(createTrustedManifest(), { trustBundle }),
    /Extension trust domain mismatch for issuer/,
  )
})

test('rejects manifest when publisher is not allowed by issuer policy', () => {
  const trustBundle: TrustBundle = {
    version: '1',
    issuers: [
      {
        id: 'third-party-issuer',
        trustDomain: 'third-party',
        publicKeyPem: 'unused in local policy checks',
        authorization: 'authorized',
        allowedPublisherIds: ['publisher.other'],
      },
    ],
  }

  assert.throws(
    () => enforceTrustPolicy(createTrustedManifest(), { trustBundle }),
    /Extension publisher is not allowed by issuer/,
  )
})

test('marks unsigned manifest as unsigned', () => {
  const manifest = createTrustedManifest()
  delete manifest.signature

  const security = enforceTrustPolicy(manifest, { trustBundle: authorizedTrustBundle })
  assert.deepEqual(security, {
    status: 'unsigned',
    reason: 'Extension has no manifest signature.',
  })
})

test('rejects manifest when publisher is revoked', () => {
  const revocationList: RevocationList = {
    version: '1',
    revokedPublishers: [{ publisherId: 'publisher.demo' }],
  }

  assert.throws(
    () => enforceTrustPolicy(createTrustedManifest(), { trustBundle: authorizedTrustBundle, revocationList }),
    /Extension publisher revoked/,
  )
})

test('rejects manifest when issuer is revoked', () => {
  const revocationList: RevocationList = {
    version: '1',
    revokedIssuers: [{ issuerId: 'third-party-issuer' }],
  }

  assert.throws(
    () => enforceTrustPolicy(createTrustedManifest(), { trustBundle: authorizedTrustBundle, revocationList }),
    /Extension issuer revoked/,
  )
})

test('rejects manifest when signature key is revoked', () => {
  const revocationList: RevocationList = {
    version: '1',
    revokedSignatureKeys: [{ keyId: 'demo-key' }],
  }

  assert.throws(
    () => enforceTrustPolicy(createTrustedManifest(), { trustBundle: authorizedTrustBundle, revocationList }),
    /Extension signature key revoked/,
  )
})

test('rejects manifest when trust metadata is expired', () => {
  const manifest = createTrustedManifest()
  manifest.trust = {
    ...manifest.trust!,
    expiresAt: '2000-01-01T00:00:00.000Z',
  }

  assert.throws(
    () => enforceTrustPolicy(manifest, { trustBundle: authorizedTrustBundle }),
    /Extension trust metadata expired/,
  )
})

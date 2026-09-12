import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadRevocationListFile, loadTrustBundleFile } from '../index.js'

test('loads trust bundle from JSON file', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-trust-bundle-'))
  const trustBundlePath = path.join(tempDirectory, 'trust-bundle.json')

  try {
    await fs.writeFile(trustBundlePath, JSON.stringify({
      version: '1',
      issuers: [
        {
          id: 'official-issuer',
          trustDomain: 'official',
          publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----',
          authorization: 'authorized',
          allowedPublisherIds: ['publisher.official'],
        },
      ],
    }, null, 2))

    const trustBundle = await loadTrustBundleFile(trustBundlePath)
    assert.equal(trustBundle.version, '1')
    assert.equal(trustBundle.issuers[0]?.id, 'official-issuer')
    assert.equal(trustBundle.issuers[0]?.authorization, 'authorized')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('loads revocation list from JSON file', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-revocation-list-'))
  const revocationListPath = path.join(tempDirectory, 'revocation-list.json')

  try {
    await fs.writeFile(revocationListPath, JSON.stringify({
      version: '1',
      revokedSignatureKeys: [{ keyId: 'demo-key' }],
      revokedIssuers: [{ issuerId: 'third-party-issuer' }],
      revokedPublishers: [{ publisherId: 'publisher.revoked' }],
    }, null, 2))

    const revocationList = await loadRevocationListFile(revocationListPath)
    assert.equal(revocationList.version, '1')
    assert.equal(revocationList.revokedSignatureKeys?.[0]?.keyId, 'demo-key')
    assert.equal(revocationList.revokedIssuers?.[0]?.issuerId, 'third-party-issuer')
    assert.equal(revocationList.revokedPublishers?.[0]?.publisherId, 'publisher.revoked')
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('rejects invalid trust bundle JSON structure', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-invalid-trust-bundle-'))
  const trustBundlePath = path.join(tempDirectory, 'trust-bundle.json')

  try {
    await fs.writeFile(trustBundlePath, JSON.stringify({
      version: '1',
      issuers: [
        {
          id: 'broken-issuer',
          trustDomain: 'invalid-domain',
          publicKeyPem: 'pem',
        },
      ],
    }, null, 2))

    await assert.rejects(
      () => loadTrustBundleFile(trustBundlePath),
      /Trust bundle issuer trustDomain is invalid/,
    )
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

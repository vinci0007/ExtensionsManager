import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  generateSigningKeyPair,
  signManifest,
  type ExtensionManifest,
  type RevocationList,
  type TrustBundle,
} from '../index.js'
import { ensureSpawnAvailable } from './spawn-test-helpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '../../')
const rustSecurityCoreBinaryPath = path.join(
  root,
  'rust',
  'target',
  'debug',
  process.platform === 'win32'
    ? 'extensions-manager-rust-security-core.exe'
    : 'extensions-manager-rust-security-core',
)

test('rust security core demo evaluates signed manifest request', async (t) => {
  await ensureSpawnAvailable(t)
  await withRustSecurityCoreFixture('ed25519', 'demo.rust-security-core-request', async ({ createSignedRequest }) => {
    const stdout = await runCommandWithInput(rustSecurityCoreBinaryPath, createSignedRequest())
    const response = JSON.parse(stdout)

    assert.equal(response.status, 'authorized-safe')
    assert.match(response.reason, /authorized issuer/)
  })
})

test('rust security core demo evaluates rsa-sha256 signed manifest request', async (t) => {
  await ensureSpawnAvailable(t)
  await withRustSecurityCoreFixture('rsa-sha256', 'demo.rust-security-core-rsa-request', async ({ createSignedRequest }) => {
    const stdout = await runCommandWithInput(rustSecurityCoreBinaryPath, createSignedRequest())
    const response = JSON.parse(stdout)

    assert.equal(response.status, 'authorized-safe')
    assert.match(response.reason, /authorized issuer/)
  })
})

test('rust security core demo marks signed manifest untrusted without trust bundle', async (t) => {
  await ensureSpawnAvailable(t)
  await withRustSecurityCoreFixture('ed25519', 'demo.rust-security-core-no-trust-bundle', async ({ createSignedRequest }) => {
    const stdout = await runCommandWithInput(
      rustSecurityCoreBinaryPath,
      createSignedRequest({ trustBundle: undefined }),
    )
    const response = JSON.parse(stdout)

    assert.equal(response.status, 'third-party-untrusted')
    assert.equal(response.reason, 'Signed extension has no official authorization trust bundle.')
  })
})

test('rust security core demo rejects revoked signature keys', async (t) => {
  await ensureSpawnAvailable(t)
  await withRustSecurityCoreFixture('ed25519', 'demo.rust-security-core-revoked-key', async ({ createSignedRequest }) => {
    await assert.rejects(
      () => runCommandWithInput(
        rustSecurityCoreBinaryPath,
        createSignedRequest({
          revocationList: {
            version: '1',
            revokedSignatureKeys: [{ keyId: 'demo-key' }],
          },
        }),
      ),
      /Extension signature key revoked: demo-key/,
    )
  })
})

test('rust security core demo rejects trust domain mismatches', async (t) => {
  await ensureSpawnAvailable(t)
  await withRustSecurityCoreFixture('ed25519', 'demo.rust-security-core-domain-mismatch', async ({ createSignedRequest, keyPair }) => {
    const trustBundle: TrustBundle = {
      version: '1',
      issuers: [{
        id: 'third-party-issuer',
        trustDomain: 'official',
        publicKeyPem: keyPair.publicKeyPem,
        authorization: 'authorized',
        allowedPublisherIds: ['publisher.demo'],
      }],
    }

    await assert.rejects(
      () => runCommandWithInput(
        rustSecurityCoreBinaryPath,
        createSignedRequest({ trustBundle }),
      ),
      /Extension trust domain mismatch for issuer: third-party-issuer/,
    )
  })
})

test('rust security core demo rejects expired trust metadata', async (t) => {
  await ensureSpawnAvailable(t)
  await withRustSecurityCoreFixture('ed25519', 'demo.rust-security-core-expired-trust', async ({ createSignedRequest, manifest }) => {
    const expiredManifest: ExtensionManifest = {
      ...manifest,
      trust: {
        ...manifest.trust!,
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
    }

    await assert.rejects(
      () => runCommandWithInput(
        rustSecurityCoreBinaryPath,
        createSignedRequest({ manifest: expiredManifest }),
      ),
      /Extension trust metadata expired: demo\.rust-security-core-expired-trust/,
    )
  })
})

async function runCommandWithInput(command: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `exit code ${code}`))
        return
      }
      resolve(stdout)
    })

    child.stdin.end(input)
  })
}

type SigningAlgorithm = 'ed25519' | 'rsa-sha256'

interface RustSecurityCoreFixture {
  keyPair: ReturnType<typeof generateSigningKeyPair>
  manifest: ExtensionManifest
  trustBundle: TrustBundle
  createSignedRequest(options?: {
    manifest?: ExtensionManifest
    trustBundle?: TrustBundle
    revocationList?: RevocationList
    signaturePolicy?: string
  }): string
}

async function withRustSecurityCoreFixture(
  algorithm: SigningAlgorithm,
  manifestId: string,
  callback: (fixture: RustSecurityCoreFixture) => Promise<void>,
): Promise<void> {
  const keyPair = generateSigningKeyPair(algorithm)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-rust-security-core-request-'))
  const trustedKeyDirectory = path.join(tempDirectory, 'trusted-keys')

  try {
    await fs.mkdir(trustedKeyDirectory, { recursive: true })
    await fs.writeFile(path.join(trustedKeyDirectory, 'demo-key.pem'), keyPair.publicKeyPem, 'utf8')

    const manifest: ExtensionManifest = {
      id: manifestId,
      version: '1.0.0',
      protocolVersion: '1',
      trust: {
        publisherId: 'publisher.demo',
        trustDomain: 'third-party',
        issuedBy: 'third-party-issuer',
      },
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.hello' }],
    }
    const trustBundle = createAuthorizedTrustBundle(keyPair.publicKeyPem)

    await callback({
      keyPair,
      manifest,
      trustBundle,
      createSignedRequest(options = {}) {
        const requestManifest = options.manifest ?? manifest
        const requestTrustBundle = Object.prototype.hasOwnProperty.call(options, 'trustBundle')
          ? options.trustBundle
          : trustBundle
        const requestRevocationList = Object.prototype.hasOwnProperty.call(options, 'revocationList')
          ? options.revocationList
          : { version: '1' }
        const signature = signManifest(requestManifest, {
          algorithm,
          keyId: 'demo-key',
          privateKeyPem: keyPair.privateKeyPem,
        })

        return JSON.stringify({
          manifest: { ...requestManifest, signature },
          signaturePolicy: options.signaturePolicy ?? 'require-signature',
          trustedKeyDirectory,
          trustBundle: requestTrustBundle,
          revocationList: requestRevocationList,
        })
      },
    })
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
}

function createAuthorizedTrustBundle(publicKeyPem: string): TrustBundle {
  return {
    version: '1',
    issuers: [{
      id: 'third-party-issuer',
      trustDomain: 'third-party',
      publicKeyPem,
      authorization: 'authorized',
      allowedPublisherIds: ['publisher.demo'],
    }],
  }
}

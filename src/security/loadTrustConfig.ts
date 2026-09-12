import fs from 'node:fs/promises'
import path from 'node:path'
import type { RevocationList, TrustBundle } from '../contracts/TrustBundle.js'

/**
 * Trust config paths are operator-controlled (host.config.json / explicit API
 * arguments) and intentionally resolvable anywhere on disk; they are not
 * manifest-driven and are not fenced like artifact paths. Only structural
 * garbage (NUL bytes, blank strings) is rejected here.
 */
function assertUsableConfigPath(filePath: string): string {
  if (filePath.includes('\0')) {
    throw new Error('Trust config path contains NUL bytes')
  }

  if (filePath.trim().length === 0) {
    throw new Error('Trust config path is empty')
  }

  return filePath
}

export async function loadTrustBundleFile(filePath: string): Promise<TrustBundle> {
  const absolutePath = path.resolve(assertUsableConfigPath(filePath))
  const content = await fs.readFile(absolutePath, 'utf8')
  const trustBundle = JSON.parse(content) as TrustBundle

  validateTrustBundle(trustBundle, absolutePath)
  return trustBundle
}

export async function loadRevocationListFile(filePath: string): Promise<RevocationList> {
  const absolutePath = path.resolve(assertUsableConfigPath(filePath))
  const content = await fs.readFile(absolutePath, 'utf8')
  const revocationList = JSON.parse(content) as RevocationList

  validateRevocationList(revocationList, absolutePath)
  return revocationList
}

function validateTrustBundle(trustBundle: TrustBundle, filePath: string): void {
  if (!trustBundle || typeof trustBundle !== 'object') {
    throw new Error(`Trust bundle must be an object: ${filePath}`)
  }

  if (typeof trustBundle.version !== 'string' || trustBundle.version.length === 0) {
    throw new Error(`Trust bundle version is required: ${filePath}`)
  }

  if (!Array.isArray(trustBundle.issuers)) {
    throw new Error(`Trust bundle issuers must be an array: ${filePath}`)
  }

  for (const issuer of trustBundle.issuers) {
    if (!issuer || typeof issuer !== 'object') {
      throw new Error(`Trust bundle issuer must be an object: ${filePath}`)
    }

    if (typeof issuer.id !== 'string' || issuer.id.length === 0) {
      throw new Error(`Trust bundle issuer id is required: ${filePath}`)
    }

    if (!['official', 'third-party', 'private'].includes(issuer.trustDomain)) {
      throw new Error(`Trust bundle issuer trustDomain is invalid: ${filePath}`)
    }

    if (typeof issuer.publicKeyPem !== 'string' || issuer.publicKeyPem.length === 0) {
      throw new Error(`Trust bundle issuer publicKeyPem is required: ${filePath}`)
    }

    if (issuer.authorization && !['authorized', 'untrusted'].includes(issuer.authorization)) {
      throw new Error(`Trust bundle issuer authorization is invalid: ${filePath}`)
    }

    if (issuer.allowedPublisherIds && !Array.isArray(issuer.allowedPublisherIds)) {
      throw new Error(`Trust bundle issuer allowedPublisherIds must be an array: ${filePath}`)
    }
  }
}

function validateRevocationList(revocationList: RevocationList, filePath: string): void {
  if (!revocationList || typeof revocationList !== 'object') {
    throw new Error(`Revocation list must be an object: ${filePath}`)
  }

  if (typeof revocationList.version !== 'string' || revocationList.version.length === 0) {
    throw new Error(`Revocation list version is required: ${filePath}`)
  }

  if (revocationList.revokedSignatureKeys && !Array.isArray(revocationList.revokedSignatureKeys)) {
    throw new Error(`Revocation list revokedSignatureKeys must be an array: ${filePath}`)
  }

  if (revocationList.revokedIssuers && !Array.isArray(revocationList.revokedIssuers)) {
    throw new Error(`Revocation list revokedIssuers must be an array: ${filePath}`)
  }

  if (revocationList.revokedPublishers && !Array.isArray(revocationList.revokedPublishers)) {
    throw new Error(`Revocation list revokedPublishers must be an array: ${filePath}`)
  }
}

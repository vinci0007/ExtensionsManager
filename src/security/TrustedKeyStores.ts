import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { TrustedKeyStore } from './PublicKeySignatureVerifier.js'

export class InMemoryTrustedKeyStore implements TrustedKeyStore {
  constructor(private readonly keys: Record<string, string>) {}

  getPublicKey(keyId: string): string | undefined {
    return this.keys[keyId]
  }
}

export class FileTrustedKeyStore implements TrustedKeyStore {
  private readonly cache = new Map<string, string>()

  constructor(private readonly keyDirectory: string) {}

  async load(keyId: string): Promise<string | undefined> {
    if (this.cache.has(keyId)) {
      return this.cache.get(keyId)
    }

    try {
      const content = await fsp.readFile(this.getKeyPath(keyId), 'utf8')
      this.cache.set(keyId, content)
      return content
    } catch {
      return undefined
    }
  }

  getPublicKey(keyId: string): string | undefined {
    if (this.cache.has(keyId)) {
      return this.cache.get(keyId)
    }

    try {
      const content = fs.readFileSync(this.getKeyPath(keyId), 'utf8')
      this.cache.set(keyId, content)
      return content
    } catch {
      return undefined
    }
  }

  private getKeyPath(keyId: string): string {
    return path.join(this.keyDirectory, `${keyId}.pem`)
  }
}

import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'

export function computeSha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath)
  return computeSha256(content)
}

export async function verifyArtifactIntegrity(manifest: ExtensionManifest, artifactPath: string): Promise<void> {
  const expected = manifest.artifact.integrity
  if (!expected) {
    return
  }

  const actual = await computeFileSha256(artifactPath)
  if (actual !== expected) {
    throw new Error(`Invalid artifact integrity: ${manifest.id}`)
  }
}

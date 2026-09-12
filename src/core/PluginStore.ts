import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExtensionInstance } from '../contracts/ExtensionInstance.js'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import { ExtensionManager } from './ExtensionManager.js'
import { ArtifactResolver } from './ArtifactResolver.js'
import { computeFileSha256 } from '../security/artifactIntegrity.js'
import { validateExtensionManifestShape } from './JsonSchemaValidator.js'

export interface PluginStoreOptions {
  manager: ExtensionManager
  pluginsDirectory: string
}

const MANIFEST_FILE_NAME = 'extension.json'

/**
 * Store-layer MVP on top of ExtensionManager: install a plugin from a source
 * directory into the plugins directory, update it in place, uninstall it, and
 * search the installed plugins.
 *
 * Install and update pin the artifact integrity digest (sha256 of the resolved
 * entry file) into the installed manifest, so any later tampering with the
 * plugin binary is rejected at load time by verifyArtifactIntegrity — closing
 * the "swap the binary without touching the (signed) manifest" gap for
 * store-managed plugins. Directory-style entries (source-dir) cannot be hashed
 * and are installed without a pin.
 */
export class PluginStore {
  constructor(private readonly options: PluginStoreOptions) {}

  async installFromDirectory(sourceDirectory: string): Promise<ExtensionInstance> {
    const manifest = await this.readManifest(sourceDirectory)
    const extensionId = this.sanitizeExtensionId(manifest.id)
    const target = this.resolvePluginDirectory(extensionId)

    if (await this.pathExists(target)) {
      throw new Error(`Extension already installed: ${extensionId}`)
    }

    await fs.cp(sourceDirectory, target, { recursive: true })
    await this.pinArtifactIntegrity(target)
    return this.options.manager.loadManifestFile(target)
  }

  async uninstall(extensionId: string): Promise<void> {
    const sanitizedId = this.sanitizeExtensionId(extensionId)
    const target = this.resolvePluginDirectory(sanitizedId)

    try {
      await this.options.manager.deactivate(sanitizedId)
    } catch {
      // Deactivation is best-effort: the extension may not be active.
    }

    this.options.manager.unregister(sanitizedId)
    await fs.rm(target, { recursive: true, force: true })
  }

  async update(extensionId: string, sourceDirectory: string): Promise<ExtensionInstance> {
    const sanitizedId = this.sanitizeExtensionId(extensionId)
    const manifest = await this.readManifest(sourceDirectory)

    if (manifest.id !== sanitizedId) {
      throw new Error(`Extension id mismatch: expected ${sanitizedId}, got ${manifest.id}`)
    }

    const target = this.resolvePluginDirectory(sanitizedId)

    if (!(await this.pathExists(target))) {
      throw new Error(`Extension is not installed: ${sanitizedId}`)
    }

    try {
      await this.options.manager.deactivate(sanitizedId)
    } catch {
      // Deactivation is best-effort: the extension may not be active.
    }

    this.options.manager.unregister(sanitizedId)
    await fs.rm(target, { recursive: true, force: true })
    await fs.cp(sourceDirectory, target, { recursive: true })
    await this.pinArtifactIntegrity(target)

    const extension = await this.options.manager.loadManifestFile(target)
    await this.options.manager.reinitialize(sanitizedId)
    return extension
  }

  search(query: string): ExtensionInstance[] {
    const normalizedQuery = query.toLowerCase()

    return this.options.manager.list().filter((extension) => {
      const { manifest } = extension
      const haystacks = [
        manifest.id,
        manifest.name,
        manifest.description,
        ...manifest.capabilities.map((capability) => capability.name),
      ]

      return haystacks.some((value) => typeof value === 'string' && value.toLowerCase().includes(normalizedQuery))
    })
  }

  findByTag(tag: string): ExtensionInstance[] {
    return this.options.manager.list().filter((extension) =>
      extension.manifest.metadata?.tags?.includes(tag) === true,
    )
  }

  private async readManifest(sourceDirectory: string): Promise<ExtensionManifest> {
    const manifestPath = path.join(sourceDirectory, MANIFEST_FILE_NAME)
    const manifestContent = await fs.readFile(manifestPath, 'utf8')
    const manifest: unknown = JSON.parse(manifestContent)

    validateExtensionManifestShape(manifest)
    return manifest
  }

  /**
   * Pins the sha256 of the resolved entry file into the installed manifest so
   * verifyArtifactIntegrity rejects later binary tampering at load time.
   * Directory entries (source-dir kind) are skipped — nothing to hash.
   */
  private async pinArtifactIntegrity(targetDirectory: string): Promise<void> {
    const manifestPath = path.join(targetDirectory, MANIFEST_FILE_NAME)
    const manifest = await this.readManifest(targetDirectory)

    try {
      const artifact = new ArtifactResolver().resolve(manifest, targetDirectory)
      const entryStat = await fs.stat(artifact.entryPath)
      if (!entryStat.isFile()) {
        return
      }

      manifest.artifact.integrity = await computeFileSha256(artifact.entryPath)
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    } catch {
      // Resolution failures (e.g. platform without a matching entry) are left
      // to the normal load path to report; pinning is best-effort.
    }
  }

  private sanitizeExtensionId(extensionId: unknown): string {
    if (typeof extensionId !== 'string' || extensionId.trim().length === 0) {
      throw new Error('Invalid extension id')
    }

    if (extensionId.includes('/') || extensionId.includes('\\') || extensionId.includes('..')) {
      throw new Error('Invalid extension id')
    }

    return extensionId
  }

  private resolvePluginDirectory(extensionId: string): string {
    const pluginsDirectory = path.resolve(this.options.pluginsDirectory)
    const target = path.resolve(pluginsDirectory, extensionId)
    const relative = path.relative(pluginsDirectory, target)

    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Invalid extension id')
    }

    return target
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await fs.stat(target)
      return true
    } catch {
      return false
    }
  }
}

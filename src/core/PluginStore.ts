import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExtensionInstance } from '../contracts/ExtensionInstance.js'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import { ExtensionManager } from './ExtensionManager.js'
import { ArtifactResolver } from './ArtifactResolver.js'
import { computeFileSha256, computeSha256 } from '../security/artifactIntegrity.js'
import { isLoopbackHost } from '../security/statusProbeGuard.js'
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

  /**
   * Install a plugin from a remote registry — the store-side surface for a UI
   * "plugin market".
   *
   * Registry index (JSON): `{ plugins: [{ id, version, bundleUrl, integrity }] }`
   * where `integrity` is `sha256-<hex>` over the exact bundle bytes.
   *
   * Bundle (JSON): `{ manifest, files: [{ path, content? , contentBase64?,
   * integrity? }] }` — text files via `content`, binary files (e.g. wasm) via
   * base64 `contentBase64`. Per-file `integrity` (`sha256-<hex>`) is verified
   * when present. The manifest id must equal the requested extension id, file
   * paths must stay inside the plugin directory, and https is required unless
   * the registry/bundle host is loopback (development registries).
   */
  async installFromRegistry(
    registryUrl: string,
    extensionId: string,
    options?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<ExtensionInstance> {
    // URL policy first: a bad channel is rejected before any state is touched.
    assertRegistryUrlAllowed(registryUrl)

    const sanitizedId = this.sanitizeExtensionId(extensionId)
    const target = this.resolvePluginDirectory(sanitizedId)

    if (await this.pathExists(target)) {
      throw new Error(`Extension already installed: ${sanitizedId}`)
    }

    const index = await fetchJson<RegistryIndex>(registryUrl, options)
    const entry = (index.plugins ?? []).find((plugin) => plugin.id === sanitizedId)
    if (!entry) {
      throw new Error(`Registry does not list extension: ${sanitizedId}`)
    }

    const bundleBytes = await fetchBytes(entry.bundleUrl, options)
    if (entry.integrity && entry.integrity !== `sha256-${computeSha256(bundleBytes)}`) {
      throw new Error(`Registry bundle integrity mismatch for ${sanitizedId}`)
    }

    const bundle = parseJson<PluginBundle>(bundleBytes)
    const manifest: unknown = bundle.manifest
    validateExtensionManifestShape(manifest)
    if (manifest.id !== sanitizedId) {
      throw new Error(`Bundle manifest id mismatch: expected ${sanitizedId}, got ${manifest.id}`)
    }

    try {
      for (const file of bundle.files ?? []) {
        const content = decodeBundleFile(file)
        const relative = this.safeBundleRelativePath(file.path)
        if (file.integrity && file.integrity !== `sha256-${computeSha256(content)}`) {
          throw new Error(`Bundle file integrity mismatch: ${file.path}`)
        }

        const absolute = path.join(target, relative)
        await fs.mkdir(path.dirname(absolute), { recursive: true })
        await fs.writeFile(absolute, content)
      }

      await fs.writeFile(path.join(target, MANIFEST_FILE_NAME), JSON.stringify(manifest, null, 2), 'utf8')
      await this.pinArtifactIntegrity(target)
      return await this.options.manager.loadManifestFile(target)
    } catch (error) {
      // Never leave a partially verified install behind.
      await fs.rm(target, { recursive: true, force: true })
      throw error
    }
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

  /**
   * Bundle file paths must stay INSIDE the plugin directory. Segment-based
   * check: `..` anywhere escapes, drive letters and absolute paths are
   * rejected outright (a resolve-then-relative dance would silently clamp
   * `../..` at the filesystem root and hide the attack).
   */
  private safeBundleRelativePath(rawPath: string): string {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      throw new Error('Invalid bundle file path')
    }
    if (path.isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath)) {
      throw new Error(`Bundle file path escapes the plugin directory: ${rawPath}`)
    }

    const segments = rawPath.split(/[\\/]/)
    if (segments.some((segment) => segment === '..')) {
      throw new Error(`Bundle file path escapes the plugin directory: ${rawPath}`)
    }

    const cleaned = segments.filter((segment) => segment.length > 0 && segment !== '.').join(path.sep)
    if (cleaned.length === 0) {
      throw new Error('Invalid bundle file path')
    }

    return cleaned
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

interface RegistryIndex {
  plugins?: { id: string; version?: string; bundleUrl: string; integrity?: string }[]
}

interface PluginBundle {
  manifest: ExtensionManifest
  files?: { path: string; content?: string; contentBase64?: string; integrity?: string }[]
}

/**
 * https is always allowed; plain http only for loopback hosts (development
 * registries) — a plugin market must never download code over an insecure
 * remote channel.
 */
export function assertRegistryUrlAllowed(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid registry URL: ${rawUrl}`)
  }

  if (parsed.protocol === 'https:') {
    return parsed
  }
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) {
    return parsed
  }

  throw new Error(`Registry URL must use https (http is only allowed for loopback): ${rawUrl}`)
}

async function fetchBytes(rawUrl: string, options?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<Buffer> {
  const parsed = assertRegistryUrlAllowed(rawUrl)
  const response = await fetch(parsed, {
    headers: options?.headers,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 15_000),
  })
  if (!response.ok) {
    throw new Error(`Registry request failed with status ${response.status}: ${rawUrl}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function fetchJson<T>(rawUrl: string, options?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<T> {
  return parseJson<T>(await fetchBytes(rawUrl, options))
}

function parseJson<T>(bytes: Buffer): T {
  return JSON.parse(bytes.toString('utf8')) as T
}

function decodeBundleFile(file: { path: string; content?: string; contentBase64?: string }): Buffer {
  if (typeof file.content === 'string') {
    return Buffer.from(file.content, 'utf8')
  }
  if (typeof file.contentBase64 === 'string') {
    return Buffer.from(file.contentBase64, 'base64')
  }
  throw new Error(`Bundle file "${file.path}" has neither content nor contentBase64`)
}

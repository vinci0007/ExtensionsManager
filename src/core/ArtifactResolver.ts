import path from 'node:path'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'

export interface ResolvedArtifact {
  entryPath: string
  command: string
  args: string[]
  cwd: string
  basePath: string
  timeoutMs?: number
}

export class ArtifactResolver {
  resolve(manifest: ExtensionManifest, basePath: string): ResolvedArtifact {
    const launch = manifest.artifact.launch
    if (launch?.shell) {
      // shell execution plus manifest-driven args is a command-injection vector.
      throw new Error(`Artifact launch does not allow shell execution: ${manifest.id}`)
    }

    const entry = this.resolvePlatformEntry(manifest.artifact.entry)
    const entryPath = this.resolveContainedPath(basePath, entry, 'entry')

    return {
      basePath,
      entryPath,
      command: this.resolveCommand(launch, entryPath, basePath),
      args: this.resolveArgs(launch, entryPath, basePath),
      cwd: this.resolveCwd(launch, basePath),
      timeoutMs: launch?.timeoutMs,
    }
  }

  private resolvePlatformEntry(entry: ExtensionManifest['artifact']['entry']): string {
    if (typeof entry === 'string') {
      return entry
    }

    const platformKey = `${process.platform}-${process.arch}`
    const matched = entry[platformKey as keyof typeof entry] ?? entry.default

    if (!matched) {
      throw new Error(`No artifact entry for platform: ${platformKey}`)
    }

    return matched
  }

  private resolveCommand(launch: ExtensionManifest['artifact']['launch'] | undefined, entryPath: string, basePath: string): string {
    if (!launch?.command) {
      return entryPath
    }

    const expanded = this.resolveTemplate(launch.command, entryPath, basePath)

    // Bare names (no separator) resolve through the OS PATH lookup; absolute
    // paths are explicit launcher binaries (e.g. process.execPath-based host
    // configs) and keep working unchanged. Only a relative path that escapes
    // the plugin directory is rejected — that is the traversal the original
    // behavior silently allowed.
    const looksLikePath = expanded.includes('/') || expanded.includes('\\')
    if (!looksLikePath || path.isAbsolute(expanded)) {
      return expanded
    }

    return this.resolveContainedPath(basePath, expanded, 'command')
  }

  private resolveArgs(launch: ExtensionManifest['artifact']['launch'] | undefined, entryPath: string, basePath: string): string[] {
    return (launch?.args ?? []).map((value: string) => this.resolveTemplate(value, entryPath, basePath))
  }

  private resolveCwd(launch: ExtensionManifest['artifact']['launch'] | undefined, basePath: string): string {
    if (!launch?.cwd) {
      return basePath
    }

    return this.resolveContainedPath(basePath, this.resolveTemplate(launch.cwd, basePath, basePath), 'cwd')
  }

  private resolveTemplate(value: string, entryPath: string, basePath: string): string {
    return value
      .replaceAll('${entry}', entryPath)
      .replaceAll('${basePath}', basePath)
  }

  /**
   * Manifest-driven paths must stay inside the plugin directory: a signed
   * manifest still cannot make the host execute or read files outside its own
   * base path. Operator-controlled paths (host config) are handled elsewhere
   * and are intentionally not fenced here.
   */
  private resolveContainedPath(basePath: string, candidate: string, label: string): string {
    if (candidate.includes('\0')) {
      throw new Error(`Artifact ${label} contains NUL bytes`)
    }

    const resolvedBase = path.resolve(basePath)
    const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(resolvedBase, candidate)
    const relative = path.relative(resolvedBase, resolved)

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Artifact ${label} escapes plugin directory: ${candidate}`)
    }

    return resolved
  }
}

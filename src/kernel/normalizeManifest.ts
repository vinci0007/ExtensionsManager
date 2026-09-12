import { fileURLToPath } from 'node:url'
import type { ExtensionCapability } from '../contracts/ExtensionCapability.js'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionPermissionSet } from '../contracts/ExtensionPermissions.js'
import type { CanonicalRuntimeSpec, NormalizedResolvedRuntime } from '../contracts/KernelRuntime.js'
import type { ResolvedArtifact } from '../core/ArtifactResolver.js'
import type { CanonicalKernelCapability } from './KernelProtocol.js'

const nodePluginLauncherPath = fileURLToPath(new URL('./nodePluginLauncher.js', import.meta.url))

export function normalizeExtensionManifestForKernel(
  manifest: ExtensionManifest,
  artifact: ResolvedArtifact,
): {
  capabilities: CanonicalKernelCapability[]
  permissions: ExtensionPermissionSet
  resolvedRuntime: NormalizedResolvedRuntime
} {
  return {
    capabilities: manifest.capabilities.map((capability) => normalizeCapability(capability, manifest)),
    permissions: normalizePermissions(manifest.permissions),
    resolvedRuntime: {
      originalRuntime: manifest.runtime,
      artifact,
      runtime: normalizeRuntime(manifest, artifact),
    },
  }
}

function normalizeCapability(
  capability: ExtensionCapability,
  manifest: ExtensionManifest,
): CanonicalKernelCapability {
  const timeoutMs = capability.resourceBudget?.timeoutMs ?? manifest.artifact.launch?.timeoutMs

  return {
    ...capability,
    interactionMode: capability.interactionMode ?? 'unary',
    executionMode: capability.executionMode ?? 'ephemeral',
    realtimeClass: capability.realtimeClass ?? 'batch',
    concurrencyPolicy: capability.concurrencyPolicy ?? 'shared',
    resourceBudget: {
      ...capability.resourceBudget,
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  }
}

function normalizePermissions(permissions: ExtensionManifest['permissions']): ExtensionPermissionSet {
  if (!permissions) {
    return {}
  }

  return permissions
}

function normalizeRuntime(manifest: ExtensionManifest, artifact: ResolvedArtifact): CanonicalRuntimeSpec {
  switch (manifest.runtime) {
    case 'node':
      return {
        kind: 'process',
        command: process.execPath,
        args: [nodePluginLauncherPath, artifact.entryPath],
        cwd: artifact.cwd,
        env: manifest.artifact.launch?.env,
      }
    case 'process':
      return {
        kind: 'process',
        command: artifact.command,
        args: artifact.args,
        cwd: artifact.cwd,
        env: manifest.artifact.launch?.env,
      }
    case 'native':
      return {
        kind: 'native-bridge',
        command: artifact.command,
        args: [...artifact.args, artifact.entryPath],
        cwd: artifact.cwd,
        env: manifest.artifact.launch?.env,
      }
    case 'wasm':
      return {
        kind: 'wasm',
        entryPath: artifact.entryPath,
        cwd: artifact.cwd,
      }
    case 'remote':
      return {
        kind: 'remote',
        endpoint: manifest.artifact.launch?.endpoint ?? manifest.artifact.launch?.command ?? artifact.command,
        transport: manifest.artifact.launch?.transport ?? 'process',
      }
    default:
      throw new Error(`Unsupported runtime normalization target: ${(manifest as { runtime: string }).runtime}`)
  }
}

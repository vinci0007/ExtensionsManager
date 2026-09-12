import type { ExtensionInstance } from '../contracts/ExtensionInstance.js'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionRuntime } from '../contracts/ExtensionRuntime.js'
import type { ResolvedArtifact } from './ArtifactResolver.js'

export interface ExtensionRuntimeAdapter {
  runtime: ExtensionRuntime
  load(manifest: ExtensionManifest, artifact: ResolvedArtifact): Promise<ExtensionInstance>
}

export class RuntimeRouter {
  private readonly adapters = new Map<ExtensionRuntime, ExtensionRuntimeAdapter>()

  register(adapter: ExtensionRuntimeAdapter): void {
    this.adapters.set(adapter.runtime, adapter)
  }

  async load(manifest: ExtensionManifest, artifact: ResolvedArtifact): Promise<ExtensionInstance> {
    const adapter = this.adapters.get(manifest.runtime)

    if (!adapter) {
      throw new Error(`Unsupported extension runtime: ${manifest.runtime}`)
    }

    return adapter.load(manifest, artifact)
  }
}

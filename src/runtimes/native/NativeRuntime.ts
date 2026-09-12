import type { ExtensionContext } from '../../contracts/ExtensionContext.js'
import type { ExtensionInstance } from '../../contracts/ExtensionInstance.js'
import type { ExtensionManifest } from '../../contracts/ExtensionManifest.js'
import type { ResolvedArtifact } from '../../core/ArtifactResolver.js'
import type { ExtensionRuntimeAdapter } from '../../core/RuntimeRouter.js'
import { ProcessRuntime } from '../process/ProcessRuntime.js'

export class NativeRuntime implements ExtensionRuntimeAdapter {
  readonly runtime = 'native' as const
  private readonly processRuntime = new ProcessRuntime()

  async load(manifest: ExtensionManifest, artifact: ResolvedArtifact): Promise<ExtensionInstance> {
    if (manifest.artifact.kind !== 'shared-library') {
      throw new Error(`Native runtime requires artifact.kind "shared-library": ${manifest.id}`)
    }

    const bridgeCommand = manifest.artifact.launch?.command
    if (!bridgeCommand) {
      throw new Error(`Native runtime requires artifact.launch.command bridge process: ${manifest.id}`)
    }

    const bridgedManifest: ExtensionManifest = {
      ...manifest,
      runtime: 'process',
      artifact: {
        ...manifest.artifact,
        kind: 'binary',
        entry: bridgeCommand,
        launch: {
          ...manifest.artifact.launch,
          command: bridgeCommand,
          args: [
            ...(manifest.artifact.launch?.args ?? []),
            artifact.entryPath,
          ],
        },
      },
    }

    const instance = await this.processRuntime.load(bridgedManifest, {
      ...artifact,
      entryPath: bridgeCommand,
      command: bridgeCommand,
      args: [
        ...(manifest.artifact.launch?.args ?? []),
        artifact.entryPath,
      ],
    })

    return {
      ...instance,
      manifest,
      security: {
        status: 'third-party-untrusted',
        reason: 'Runtime instances are untrusted until ExtensionManager evaluates authorization.',
      },
      async activate(context: ExtensionContext) {
        await instance.activate(context)
      },
      async deactivate() {
        await instance.deactivate()
      },
    }
  }
}

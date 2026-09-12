import { spawn } from 'node:child_process'
import type { ExtensionContext } from '../../contracts/ExtensionContext.js'
import type { ExtensionInstance } from '../../contracts/ExtensionInstance.js'
import type { ExtensionManifest } from '../../contracts/ExtensionManifest.js'
import type { ResolvedArtifact } from '../../core/ArtifactResolver.js'
import type { ExtensionRuntimeAdapter } from '../../core/RuntimeRouter.js'
import { requiresRealSession, resolveSessionContract } from '../../core/sessionContracts.js'
import { ExtensionProcessError } from '../../errors/ExtensionError.js'
import { createBufferedSession, createCompatibilitySession, isUnsupportedSessionError, waitForChildExit } from '../sessionRuntimeUtils.js'
import { JsonRpcTransport } from './JsonRpcTransport.js'

export class ProcessRuntime implements ExtensionRuntimeAdapter {
  readonly runtime = 'process' as const

  async load(manifest: ExtensionManifest, artifact: ResolvedArtifact): Promise<ExtensionInstance> {
    const child = spawn(artifact.command, artifact.args, {
      cwd: artifact.cwd,
      env: {
        ...process.env,
        ...(manifest.artifact.launch?.env ?? {}),
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    })

    if (!child.pid) {
      throw new ExtensionProcessError(`Failed to start extension process: ${manifest.id}`)
    }

    const transport = new JsonRpcTransport(child)
    let activated = false

    return {
      id: manifest.id,
      manifest,
      security: {
        status: 'third-party-untrusted',
        reason: 'Runtime instances are untrusted until ExtensionManager evaluates authorization.',
      },
      async activate(context: ExtensionContext) {
        if (activated) {
          return
        }

        await transport.request('extension/activate', createActivationPayload(context), manifest.artifact.launch?.timeoutMs)
        activated = true
      },
      async deactivate() {
        if (!activated) {
          return
        }

        await transport.request('extension/deactivate', undefined, manifest.artifact.launch?.timeoutMs)
        await waitForChildExit(child, manifest.artifact.launch?.timeoutMs, 'Extension process did not exit in time')

        if (!child.killed && child.exitCode === null) {
          child.kill()
          await waitForChildExit(child, manifest.artifact.launch?.timeoutMs, 'Extension process did not exit in time')
        }

        activated = false
      },
      async invoke(capability, input) {
        return transport.request('extension/invoke', {
          capability,
          input,
        }, manifest.artifact.launch?.timeoutMs)
      },
      async openSession(capability, input) {
        const contract = resolveSessionContract(manifest, capability)
        try {
          const opened = await transport.openSession(capability, input, manifest.artifact.launch?.timeoutMs)
          return createBufferedSession(
            opened.sessionId,
            opened.events,
            contract,
            {
              onSend: (data) => transport.sessionSend(opened.sessionId, data, manifest.artifact.launch?.timeoutMs),
              onCancel: () => transport.sessionCancel(opened.sessionId, manifest.artifact.launch?.timeoutMs),
              onClose: () => transport.sessionClose(opened.sessionId, manifest.artifact.launch?.timeoutMs),
              emptyQueueMessage: `Process session has no queued events: ${opened.sessionId}`,
            },
          )
        } catch (error) {
          if (isUnsupportedSessionError(error)) {
            if (requiresRealSession(contract)) {
              throw new ExtensionProcessError(`Capability requires a real session implementation: ${capability}`)
            }
            const output = await transport.request('extension/invoke', {
              capability,
              input,
            }, manifest.artifact.launch?.timeoutMs)
            return createCompatibilitySession(
              'process-compatibility-session',
              output,
              contract,
              'Compatibility process session has no more events',
            )
          }

          throw error
        }
      },
    }
  }
}

function createActivationPayload(context: ExtensionContext): Record<string, unknown> {
  return {
    extensionId: context.extensionId,
    workspacePath: context.workspacePath,
    storagePath: context.storagePath,
    initialization: context.initialization,
  }
}

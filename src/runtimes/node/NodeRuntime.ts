import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { ExtensionContext } from '../../contracts/ExtensionContext.js'
import type { ExtensionInstance } from '../../contracts/ExtensionInstance.js'
import type { ExtensionManifest } from '../../contracts/ExtensionManifest.js'
import type { ExtensionSession, ExtensionSessionEvent } from '../../contracts/ExtensionSession.js'
import { allowsSessionSend, requiresRealSession, resolveSessionContract, type SessionContract } from '../../core/sessionContracts.js'
import type { ResolvedArtifact } from '../../core/ArtifactResolver.js'
import type { ExtensionRuntimeAdapter } from '../../core/RuntimeRouter.js'
import { createBufferedSession, createCompatibilitySession } from '../sessionRuntimeUtils.js'

export type NodeCapabilityHandler<TInput = unknown, TOutput = unknown> = (input: TInput) => Promise<TOutput> | TOutput

export interface NodeExtensionSession {
  nextEvent(): Promise<ExtensionSessionEvent | null> | ExtensionSessionEvent | null
  send?(data: unknown): Promise<void> | void
  cancel?(): Promise<void> | void
  close?(): Promise<void> | void
}

export interface NodeExtensionModule {
  activate?(context: ExtensionContext): Promise<void> | void
  deactivate?(): Promise<void> | void
  capabilities: Record<string, NodeCapabilityHandler>
  openSession?(capability: string, input: unknown): Promise<NodeExtensionSession> | NodeExtensionSession
}

/**
 * In-process Node runtime.
 *
 * SECURITY: plugins loaded here run with full host privileges (same process, no
 * isolation) — `import()` of third-party code is only acceptable for trusted
 * first-party extensions. Untrusted plugins must use the process runtime or,
 * for realtime hosts, the in-process WASM data plane of the Rust kernel
 * (see docs/superpowers/plans/2026-08-29-embedded-realtime-kernel.md).
 */
export class NodeRuntime implements ExtensionRuntimeAdapter {
  readonly runtime = 'node' as const

  async load(manifest: ExtensionManifest, artifact: ResolvedArtifact): Promise<ExtensionInstance> {
    // Content-hash cache busting: Node caches ESM imports by URL, so an updated
    // plugin with an unchanged file name would otherwise keep serving the stale
    // module until process restart. Same bytes → same URL → cached; changed
    // bytes → fresh module (hot update works without renaming files).
    const entryBytes = await fs.readFile(artifact.entryPath)
    const contentHash = createHash('sha256').update(entryBytes).digest('hex').slice(0, 16)
    const imported = await import(`${pathToFileURL(artifact.entryPath).href}?h=${contentHash}`)
    const module = (imported.default ?? imported) as NodeExtensionModule

    if (!module.capabilities || typeof module.capabilities !== 'object') {
      throw new Error(`Node extension must export a capabilities map: ${manifest.id}`)
    }

    for (const capability of manifest.capabilities) {
      if (typeof module.capabilities[capability.name] !== 'function') {
        throw new Error(`Node extension is missing capability export: ${capability.name}`)
      }
    }

    return {
      id: manifest.id,
      manifest,
      security: {
        status: 'third-party-untrusted',
        reason: 'Runtime instances are untrusted until ExtensionManager evaluates authorization.',
      },
      async activate(context: ExtensionContext) {
        await module.activate?.(context)
      },
      async deactivate() {
        await module.deactivate?.()
      },
      async invoke<TInput = unknown, TOutput = unknown>(capability: string, input: TInput): Promise<TOutput> {
        const handler = module.capabilities[capability] as NodeCapabilityHandler<TInput, TOutput> | undefined

        if (typeof handler !== 'function') {
          throw new Error(`Node extension does not export capability: ${capability}`)
        }

        return await handler(input)
      },
      async openSession<TInput = unknown>(capability: string, input: TInput): Promise<ExtensionSession> {
        const contract = resolveSessionContract(manifest, capability)
        if (typeof module.openSession === 'function') {
          const session = await module.openSession(capability, input)
          const firstEvent = await session.nextEvent()
          return createBufferedSession(
            `${capability}:node-session`,
            firstEvent ? [firstEvent] : [],
            contract,
            {
              onSend: async (data) => {
                if (!allowsSessionSend(contract)) {
                  throw new Error(`Capability does not allow session.send: ${capability}`)
                }
                await session.send?.(data)
                const event = await session.nextEvent()
                return event ? [event] : []
              },
              onCancel: async () => {
                await session.cancel?.()
                const event = await session.nextEvent()
                return event ? [event] : []
              },
              onClose: async () => {
                await session.close?.()
              },
              emptyQueueMessage: `Node session has no queued events: ${capability}`,
            },
          )
        }

        if (requiresRealSession(contract)) {
          throw new Error(`Capability requires a real session implementation: ${capability}`)
        }

        const handler = module.capabilities[capability] as NodeCapabilityHandler<TInput, unknown> | undefined
        if (typeof handler !== 'function') {
          throw new Error(`Node extension does not export capability: ${capability}`)
        }

        const output = await handler(input)
        return createCompatibilitySession(
          'node-compatibility-session',
          output,
          contract,
          'Compatibility node session has no more events',
        )
      },
    }
  }
}

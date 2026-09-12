import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import type { ExtensionContext } from '../../contracts/ExtensionContext.js'
import type { ExtensionInstance } from '../../contracts/ExtensionInstance.js'
import type { ExtensionManifest } from '../../contracts/ExtensionManifest.js'
import type { ResolvedArtifact } from '../../core/ArtifactResolver.js'
import type { ExtensionRuntimeAdapter } from '../../core/RuntimeRouter.js'
import { assertWasmMemoryWithinQuota, WASM_MEMORY_QUOTA_PAGES } from '../../security/wasmModuleLimits.js'

/**
 * Compiled-module cache keyed by module content hash. WebAssembly.Module is
 * immutable and safe to share across instances, so N plugins built from the
 * same wasm file pay compilation once (10 ms → ~0 on the batch-load path).
 * Bounded FIFO so a host loading many distinct modules cannot grow memory
 * without limit; each cached entry only holds the compiled module.
 */
const MODULE_CACHE_CAPACITY = 64
const moduleCache = new Map<string, WebAssembly.Module>()

/**
 * Internal (exported for tests): returns the shared compiled module for these
 * exact bytes, compiling and caching on first sight.
 */
export function getOrCompileModule(moduleBytes: Buffer): WebAssembly.Module {
  const key = createHash('sha256').update(moduleBytes).digest('hex')
  const cached = moduleCache.get(key)
  if (cached) {
    // Refresh recency (Map iteration order = insertion order).
    moduleCache.delete(key)
    moduleCache.set(key, cached)
    return cached
  }

  // Copy into a plain ArrayBuffer-backed view: satisfies BufferSource typing
  // and detaches the module from the file-read buffer's pool.
  const compiled = new WebAssembly.Module(new Uint8Array(moduleBytes))
  moduleCache.set(key, compiled)
  if (moduleCache.size > MODULE_CACHE_CAPACITY) {
    const oldest = moduleCache.keys().next().value
    if (oldest !== undefined) {
      moduleCache.delete(oldest)
    }
  }
  return compiled
}

export class WasmRuntime implements ExtensionRuntimeAdapter {
  readonly runtime = 'wasm' as const

  async load(manifest: ExtensionManifest, artifact: ResolvedArtifact): Promise<ExtensionInstance> {
    const moduleBytes = await fs.readFile(artifact.entryPath)
    assertWasmMemoryWithinQuota(moduleBytes, WASM_MEMORY_QUOTA_PAGES)

    const module = getOrCompileModule(moduleBytes)
    const importObject: Record<string, Record<string, WebAssembly.Memory | (() => number)>> = {
      env: {
        now: () => Date.now(),
      },
    }

    // A module that imports its memory gets a host-capped memory object, so it
    // cannot grow past the quota either. Self-declared memory was already
    // bounded by the guard above.
    for (const entry of WebAssembly.Module.imports(module)) {
      if (entry.kind === 'memory') {
        importObject[entry.module] = {
          ...importObject[entry.module],
          [entry.name]: new WebAssembly.Memory({ initial: 1, maximum: WASM_MEMORY_QUOTA_PAGES }),
        }
      }
    }

    const instance = await WebAssembly.instantiate(module, importObject)

    const wasmExports = instance.exports as Record<string, unknown>
    const capabilityBindings = new Map(
      manifest.capabilities.map((capability) => [capability.name, capability.binding ?? capability.name]),
    )

    for (const [capabilityName, binding] of capabilityBindings) {
      if (typeof wasmExports[binding] !== 'function') {
        throw new Error(`WASM extension is missing exported capability binding: ${capabilityName} -> ${binding}`)
      }
    }

    return {
      id: manifest.id,
      manifest,
      security: {
        status: 'third-party-untrusted',
        reason: 'Runtime instances are untrusted until ExtensionManager evaluates authorization.',
      },
      async activate(_context: ExtensionContext) {
        const activate = wasmExports.activate
        if (typeof activate === 'function') {
          ;(activate as () => unknown)()
        }
      },
      async deactivate() {
        const deactivate = wasmExports.deactivate
        if (typeof deactivate === 'function') {
          ;(deactivate as () => unknown)()
        }
      },
      async invoke<TInput = unknown, TOutput = unknown>(capability: string, input: TInput): Promise<TOutput> {
        const binding = capabilityBindings.get(capability) ?? capability
        const exported = wasmExports[binding]

        if (typeof exported !== 'function') {
          throw new Error(`WASM extension does not export capability: ${capability}`)
        }

        const numericInput = normalizeNumericInput(input)
        const result = (exported as (value?: number) => unknown)(numericInput)
        return result as TOutput
      },
    }
  }
}

function normalizeNumericInput(input: unknown): number | undefined {
  if (typeof input === 'number') {
    return input
  }

  if (input && typeof input === 'object' && 'value' in input) {
    const value = (input as { value?: unknown }).value
    if (typeof value === 'number') {
      return value
    }
  }

  if (typeof input === 'undefined') {
    return undefined
  }

  throw new Error('WASM runtime currently supports numeric input or { value: number } input only')
}

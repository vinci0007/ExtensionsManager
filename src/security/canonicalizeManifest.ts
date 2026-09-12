import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'

export function canonicalizeManifest(manifest: ExtensionManifest): string {
  const { signature: _signature, ...unsignedManifest } = manifest
  return JSON.stringify(sortNode(unsignedManifest))
}

function sortNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortNode(item))
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortNode((value as Record<string, unknown>)[key])
        return acc
      }, {})
  }

  return value
}

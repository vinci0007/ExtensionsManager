import type { ExtensionCapability, ExtensionExecutionMode, ExtensionInteractionMode } from '../contracts/ExtensionCapability.js'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'

export interface SessionContract {
  capability: ExtensionCapability
  interactionMode: ExtensionInteractionMode
  executionMode: ExtensionExecutionMode
}

export function resolveSessionContract(
  manifest: ExtensionManifest,
  capabilityName: string,
): SessionContract {
  const capability = manifest.capabilities.find((entry) => entry.name === capabilityName)
  if (!capability) {
    throw new Error(`Capability is not declared in manifest: ${capabilityName}`)
  }

  return {
    capability,
    interactionMode: capability.interactionMode ?? 'unary',
    executionMode: capability.executionMode ?? 'ephemeral',
  }
}

export function requiresRealSession(contract: SessionContract): boolean {
  return contract.interactionMode !== 'unary' || contract.executionMode !== 'ephemeral'
}

export function allowsSessionSend(contract: SessionContract): boolean {
  return contract.interactionMode === 'client-stream' || contract.interactionMode === 'duplex'
}

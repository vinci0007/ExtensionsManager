export type ExtensionInteractionMode = 'unary' | 'server-stream' | 'client-stream' | 'duplex' | 'subscription'
export type ExtensionExecutionMode = 'ephemeral' | 'session' | 'persistent'
export type ExtensionRealtimeClass = 'batch' | 'interactive' | 'realtime'
export type ExtensionConcurrencyPolicy = 'single' | 'shared' | 'isolated'

export interface ExtensionResourceBudget {
  timeoutMs?: number
  memoryMb?: number
  maxConcurrency?: number
  /** Resident amortization contract: fuel slice per tick. */
  fuelPerTick?: number
}

export interface ExtensionCapability {
  name: string
  binding?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  interactionMode?: ExtensionInteractionMode
  executionMode?: ExtensionExecutionMode
  realtimeClass?: ExtensionRealtimeClass
  concurrencyPolicy?: ExtensionConcurrencyPolicy
  resourceBudget?: ExtensionResourceBudget
  /**
   * `'prompt'` = the host UI must grant this capability before its first use
   * (per session, cached after approval; see ExtensionManagerOptions
   * `onCapabilityPermission`). Absent = no per-call prompt.
   */
  permission?: 'prompt'
}

/**
 * Host performance-policy configuration (mirrors the Rust `KernelPolicy`).
 *
 * Sent to the kernel via `kernel.policy.set` (daemon path) or enforced by the
 * local bridge admission mirror. Everything optional: absent fields fall back
 * to the safe defaults (16 MiB hard cap, 200M instructions per call).
 */
export interface KernelFramePolicy {
  /** Frame cadence. Provide either tickHz or an explicit frameBudgetMs. */
  tickHz?: number
  frameBudgetMs?: number
  /** Share of the frame budget a single plugin may consume per tick (default 5). */
  pluginSharePct?: number
}

export interface KernelMemoryTiers {
  realtimeMb?: number
  interactiveMb?: number
  batchMb?: number
}

export interface KernelMemoryPolicy {
  /** Total plugin memory budget in MiB. */
  totalMb?: number
  /** Per-tier hard caps gating manifest-declared resourceBudget.memoryMb. */
  tiers?: KernelMemoryTiers
}

export interface KernelFuelPolicy {
  /** Explicit per-call fuel; wins over frame-budget derivation. */
  perCallOverride?: number
}

export interface KernelPolicyConfig {
  frame?: KernelFramePolicy
  memory?: KernelMemoryPolicy
  fuel?: KernelFuelPolicy
}

/**
 * A consentable policy exception, surfaced to the host's consent handler.
 * The manager never renders UI — the host decides how to ask its user.
 */
export interface PolicyConsentRequest {
  type: 'memoryTierOverflow' | 'residentOverBudget'
  extensionId: string
  /** Declared peak (resourceBudget.memoryMb). */
  declaredMb: number
  /** The configured cap the declaration overflows (tier cap or total budget). */
  capMb: number
  /** Human-readable reason, as produced by the admission engine. */
  reason: string
}

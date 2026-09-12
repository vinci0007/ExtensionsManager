/**
 * Plugin user-settings contract: a plugin declares declarative setting
 * definitions in its manifest (`settings`), the host UI renders them
 * generically, and the manager validates + stores values. Values are delivered
 * to the plugin through `context.settings` on every (re)activation.
 */

export type ExtensionSettingType = 'string' | 'number' | 'boolean' | 'enum'

export interface ExtensionSettingDefinition {
  /** Stable key — the plugin reads this property from `context.settings`. */
  key: string
  type: ExtensionSettingType
  /** Human-readable label for UI rendering. */
  title?: string
  description?: string
  default?: string | number | boolean
  /** Allowed values when `type: 'enum'`. */
  enum?: string[]
  /** Inclusive bounds when `type: 'number'`. */
  min?: number
  max?: number
}

export type ExtensionSettingValue = string | number | boolean

export function isExtensionSettingDefinition(value: unknown): value is ExtensionSettingDefinition {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.key !== 'string' || candidate.key.trim().length === 0) {
    return false
  }
  if (candidate.type !== 'string' && candidate.type !== 'number' && candidate.type !== 'boolean' && candidate.type !== 'enum') {
    return false
  }
  if (candidate.type === 'enum' && !(Array.isArray(candidate.enum) && candidate.enum.length > 0)) {
    return false
  }
  if (candidate.type === 'number' && (candidate.min !== undefined || candidate.max !== undefined)) {
    if (candidate.min !== undefined && typeof candidate.min !== 'number') return false
    if (candidate.max !== undefined && typeof candidate.max !== 'number') return false
  }
  if (candidate.default !== undefined && typeof candidate.default !== candidate.type) {
    return false
  }
  return true
}

/** Throws a user-facing error when `value` does not satisfy the definition. */
export function assertSettingValueMatches(definition: ExtensionSettingDefinition, value: unknown): void {
  const where = `setting "${definition.key}"`
  if (definition.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${where} expects a finite number`)
    }
    if (definition.min !== undefined && value < definition.min) {
      throw new Error(`${where} must be >= ${definition.min}`)
    }
    if (definition.max !== undefined && value > definition.max) {
      throw new Error(`${where} must be <= ${definition.max}`)
    }
    return
  }
  if (definition.type === 'enum') {
    if (typeof value !== 'string' || !definition.enum?.includes(value)) {
      throw new Error(`${where} must be one of: ${(definition.enum ?? []).join(', ')}`)
    }
    return
  }
  if (typeof value !== definition.type) {
    throw new Error(`${where} expects ${definition.type}`)
  }
}

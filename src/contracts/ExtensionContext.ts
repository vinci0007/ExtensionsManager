import type { ExtensionInitializationInfo } from './ExtensionInitialization.js'

export interface ExtensionContext {
  extensionId: string
  workspacePath?: string
  storagePath?: string
  initialization: ExtensionInitializationInfo
  /**
   * Current user-setting values (manifest `settings` definitions resolved
   * against host-stored overrides). Present when the manifest declares
   * settings; refreshed on every (re)activation.
   */
  settings?: Record<string, unknown>
  logger?: {
    debug(message: string, meta?: unknown): void
    info(message: string, meta?: unknown): void
    warn(message: string, meta?: unknown): void
    error(message: string, meta?: unknown): void
  }
}

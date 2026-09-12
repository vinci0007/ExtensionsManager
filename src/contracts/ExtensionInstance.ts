import type { ExtensionContext } from './ExtensionContext.js'
import type { ExtensionManifest } from './ExtensionManifest.js'
import type { ExtensionSession } from './ExtensionSession.js'

export type ExtensionSecurityStatus = 'authorized-safe' | 'unsigned' | 'third-party-untrusted'

export interface ExtensionSecurityInfo {
  status: ExtensionSecurityStatus
  reason: string
}

export interface ExtensionInstance {
  id: string
  manifest: ExtensionManifest
  security: ExtensionSecurityInfo
  activate(context: ExtensionContext): Promise<void>
  deactivate(): Promise<void>
  invoke<TInput = unknown, TOutput = unknown>(capability: string, input: TInput): Promise<TOutput>
  openSession?<TInput = unknown>(capability: string, input: TInput): Promise<ExtensionSession>
}

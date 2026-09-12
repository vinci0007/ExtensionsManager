import type { ExtensionContext } from '../contracts/ExtensionContext.js'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionSecurityInfo } from '../contracts/ExtensionInstance.js'
import type { ExtensionSession } from '../contracts/ExtensionSession.js'
import type { KernelAuditEntry, KernelAuditQuery, KernelAuditResult } from './KernelProtocol.js'

export interface KernelBridgeLoadResult {
  security: ExtensionSecurityInfo
}

export interface KernelBridge {
  load(manifest: ExtensionManifest, basePath: string): Promise<KernelBridgeLoadResult>
  activate(extensionId: string, context: ExtensionContext): Promise<void>
  deactivate(extensionId: string): Promise<void>
  invoke<TInput = unknown, TOutput = unknown>(extensionId: string, capability: string, input: TInput): Promise<TOutput>
  openSession(extensionId: string, capability: string, input: unknown): Promise<ExtensionSession>
  /** Kernel-backed audit/accounting query (daemon/embedded bridges only). */
  getAudit?(query?: KernelAuditQuery): Promise<KernelAuditResult>
  /** Await the next pushed governance (audit) event from the kernel. */
  nextAuditEvent?(): Promise<KernelAuditEntry>
  dispose?(): Promise<void> | void
}

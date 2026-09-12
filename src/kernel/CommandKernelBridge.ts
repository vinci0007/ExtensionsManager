import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import type { ChildProcess } from 'node:child_process'
import type { ExtensionContext } from '../contracts/ExtensionContext.js'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionSession, ExtensionSessionEvent } from '../contracts/ExtensionSession.js'
import type { KernelPolicyConfig, PolicyConsentRequest } from '../contracts/KernelPolicy.js'
import { ExtensionProcessError } from '../errors/ExtensionError.js'
import { ArtifactResolver } from '../core/ArtifactResolver.js'
import { resolveSessionContract } from '../core/sessionContracts.js'
import { createCompatibilitySession, isUnsupportedSessionError } from '../runtimes/sessionRuntimeUtils.js'
import type { KernelBridge, KernelBridgeLoadResult } from './KernelBridge.js'
import type {
  KernelEnvelope,
  KernelEventEnvelope,
  KernelLoadResult,
  KernelRequestEnvelope,
  KernelResponseEnvelope,
  KernelSecurityContext,
  KernelSessionOpenResult,
} from './KernelProtocol.js'
import { normalizeExtensionManifestForKernel } from './normalizeManifest.js'

export interface KernelBridgeDaemonOptions extends KernelSecurityContext {
  mode?: 'daemon' | 'embedded'
  transport?: 'pipe' | 'socket'
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  endpoint?: string
  timeoutMs?: number
  /**
   * Window for the REAL result of an async-dispatched invoke. When the kernel
   * scheduler accepts a boundary-runtime invoke it answers with an accepted
   * marker and delivers the actual envelope later on the same request id; the
   * bridge keeps the caller's promise pending until that envelope arrives.
   * Default 120000 (2 min).
   */
  asyncInvokeTimeoutMs?: number
  /** Performance policy; sent as kernel.policy.set once the daemon is up. */
  policy?: KernelPolicyConfig
  /**
   * Consent handler for policy exceptions: when the kernel answers
   * KERNEL_CONSENT_REQUIRED, the host handler decides; approval re-sends the
   * load with consentOverride. Absent handler = fail-closed.
   */
  onPolicyConsent?: (request: PolicyConsentRequest) => Promise<boolean>
}

/**
 * Legacy daemon-side kernel bridge.
 *
 * STATUS (2026-08): demoted to an optional sidecar path. The realtime data plane
 * lives in the embedded Rust kernel (`extensions-kernel` cdylib, C ABI
 * `emk_invoke_ptr` / `emk_tick_ptr`); this bridge remains for hosts that need
 * out-of-process governance or non-Node plugin runtimes, and its serialized
 * daemon protocol is unsuitable for per-frame call paths.
 * See docs/superpowers/plans/2026-08-29-embedded-realtime-kernel.md.
 */
export class CommandKernelBridge implements KernelBridge {
  private readonly artifactResolver = new ArtifactResolver()
  private readonly loadedSecurity = new Map<string, KernelBridgeLoadResult>()
  private readonly loadedManifests = new Map<string, ExtensionManifest>()
  private readonly transport: CommandKernelTransport

  constructor(private readonly options: KernelBridgeDaemonOptions) {
    this.transport = new CommandKernelTransport(options)
  }

  async load(manifest: ExtensionManifest, basePath: string): Promise<KernelBridgeLoadResult> {
    const artifact = this.artifactResolver.resolve(manifest, basePath)
    const normalized = normalizeExtensionManifestForKernel(manifest, artifact)
    const loadParams = (): Record<string, unknown> => ({
      manifest,
      runtime: normalized.resolvedRuntime.runtime,
      capabilities: normalized.capabilities,
      permissions: normalized.permissions,
      artifact,
      security: this.buildSecurityContext(),
    })

    let result: KernelLoadResult
    try {
      result = await this.transport.request<KernelLoadResult>('kernel.load', loadParams())
    } catch (error) {
      // The kernel answers KERNEL_CONSENT_REQUIRED for consentable policy
      // exceptions (tier overflow, resident over budget). Mediate consent via
      // the host handler; approval re-sends the load with consentOverride and
      // the kernel audits the decision.
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('KERNEL_CONSENT_REQUIRED')) {
        throw error
      }
      if (!this.options.onPolicyConsent) {
        throw new Error(`${message} (rejected: no consent handler configured)`)
      }
      const approved = await this.options.onPolicyConsent({
        type: message.includes('resident reservation') ? 'residentOverBudget' : 'memoryTierOverflow',
        extensionId: manifest.id,
        declaredMb: 0,
        capMb: 0,
        reason: message,
      })
      if (!approved) {
        throw new Error(`${message} (rejected by consent handler)`)
      }
      const retryParams = loadParams()
      retryParams.consentOverride = true
      result = await this.transport.request<KernelLoadResult>('kernel.load', retryParams)
    }

    const security = { security: result.security }
    this.loadedSecurity.set(manifest.id, security)
    this.loadedManifests.set(manifest.id, manifest)
    return security
  }

  async activate(extensionId: string, context: ExtensionContext): Promise<void> {
    await this.transport.request('kernel.activate', {
      extensionId,
      context: createSerializableContext(context),
    })
  }

  async deactivate(extensionId: string): Promise<void> {
    await this.transport.request('kernel.deactivate', {
      extensionId,
    })
  }

  async invoke<TInput = unknown, TOutput = unknown>(
    extensionId: string,
    capability: string,
    input: TInput,
  ): Promise<TOutput> {
    return this.transport.request<TOutput>('kernel.invoke', {
      extensionId,
      capability,
      input,
    })
  }

  async openSession(extensionId: string, capability: string, input: unknown): Promise<ExtensionSession> {
    try {
      const result = await this.transport.request<KernelSessionOpenResult>('kernel.openSession', {
        extensionId,
        capability,
        input,
      })

      return new RemoteKernelSession(this.transport, result.sessionId)
    } catch (error) {
      // Capabilities that never declare a real session get a compatibility session
      // backed by a plain invoke (mirrors the process runtime behavior).
      if (!isUnsupportedSessionError(error)) {
        throw error
      }

      const manifest = this.loadedManifests.get(extensionId)
      if (!manifest) {
        throw error
      }

      const contract = resolveSessionContract(manifest, capability)
      const output = await this.transport.request('kernel.invoke', {
        extensionId,
        capability,
        input,
      })
      return createCompatibilitySession(
        `${extensionId}:${capability}:daemon`,
        output,
        contract,
        'Compatibility daemon session has no more events',
      )
    }
  }

  async dispose(): Promise<void> {
    await this.transport.dispose()
    this.loadedSecurity.clear()
    this.loadedManifests.clear()
  }

  private buildSecurityContext(): KernelSecurityContext {
    return {
      signaturePolicy: this.options.signaturePolicy,
      isDevelopment: this.options.isDevelopment,
      trustBundle: this.options.trustBundle,
      revocationList: this.options.revocationList,
      trustedKeyDirectory: this.options.trustedKeyDirectory,
      trustedPublicKeys: this.options.trustedPublicKeys,
    }
  }
}

function createSerializableContext(context: ExtensionContext): Record<string, unknown> {
  return {
    extensionId: context.extensionId,
    workspacePath: context.workspacePath,
    storagePath: context.storagePath,
    initialization: context.initialization,
  }
}

class RemoteKernelSession implements ExtensionSession {
  private closed = false

  constructor(
    private readonly transport: CommandKernelTransport,
    readonly id: string,
  ) {}

  async send(data: unknown): Promise<void> {
    this.ensureOpen()
    await this.transport.request('kernel.session.send', {
      sessionId: this.id,
      data,
    })
  }

  async nextEvent(): Promise<ExtensionSessionEvent> {
    this.ensureOpen()
    return this.transport.nextSessionEvent(this.id)
  }

  async cancel(): Promise<void> {
    this.ensureOpen()
    await this.transport.request('kernel.cancel', {
      sessionId: this.id,
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    await this.transport.request('kernel.session.close', {
      sessionId: this.id,
    })
    this.transport.clearSessionState(this.id)
    this.closed = true
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new ExtensionProcessError(`Session is closed: ${this.id}`)
    }
  }
}

class CommandKernelTransport {
  private readonly pending = new Map<string, {
    method: KernelRequestEnvelope['method']
    resolve(value: unknown): void
    reject(reason?: unknown): void
    timer?: NodeJS.Timeout
    awaitingAsyncResult?: boolean
  }>()
  private readonly sessionQueues = new Map<string, ExtensionSessionEvent[]>()
  private readonly sessionWaiters = new Map<string, { resolve(event: ExtensionSessionEvent): void; reject(reason?: unknown): void }[]>()
  private child?: ChildProcess
  private reader?: readline.Interface
  private policySent = false
  private childExitPromise?: Promise<void>
  private closed = false
  private terminalError?: Error

  constructor(private readonly options: KernelBridgeDaemonOptions) {}

  async request<T = unknown>(method: KernelRequestEnvelope['method'], params?: unknown): Promise<T> {
    if (this.closed) {
      throw new ExtensionProcessError('Kernel transport is closed')
    }

    const child = this.ensureProcess()

    if (!child.stdin) {
      throw new ExtensionProcessError('Kernel transport stdin unavailable')
    }

    const id = randomUUID()
    const payload: KernelRequestEnvelope = {
      kind: 'request',
      id,
      method,
      params,
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = this.options.timeoutMs ?? 5000
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ExtensionProcessError(`Kernel request timed out: ${method}`))
      }, timeoutMs)

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
      })

      child.stdin?.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          this.clearPending(id)
          reject(error)
        }
      })
    })
  }

  async nextSessionEvent(sessionId: string): Promise<ExtensionSessionEvent> {
    const queue = this.sessionQueues.get(sessionId)
    if (queue && queue.length > 0) {
      return queue.shift() as ExtensionSessionEvent
    }

    return new Promise<ExtensionSessionEvent>((resolve, reject) => {
      const waiters = this.sessionWaiters.get(sessionId) ?? []
      waiters.push({ resolve, reject })
      this.sessionWaiters.set(sessionId, waiters)
    })
  }

  clearSessionState(sessionId: string): void {
    this.sessionQueues.delete(sessionId)
    const waiters = this.sessionWaiters.get(sessionId)
    if (waiters) {
      const error = new ExtensionProcessError(`Session is closed: ${sessionId}`)
      for (const waiter of waiters) {
        waiter.reject(error)
      }
      this.sessionWaiters.delete(sessionId)
    }
  }

  private ensureProcess(): ChildProcess {
    if (this.options.mode === 'embedded') {
      throw new ExtensionProcessError('Embedded kernel mode is not yet supported in the TypeScript facade')
    }

    if (this.options.transport && this.options.transport !== 'pipe') {
      throw new ExtensionProcessError(`Unsupported kernel transport: ${this.options.transport}`)
    }

    if (this.child) {
      return this.child
    }

    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    if (!child.stdout || !child.stdin) {
      throw new ExtensionProcessError('Kernel process requires stdio pipes')
    }

    this.child = child
    this.reader = readline.createInterface({ input: child.stdout })
    this.reader.on('line', (line) => {
      this.handleLine(line)
    })

    this.childExitPromise = new Promise<void>((resolve) => {
      child.once('close', (code, signal) => {
        this.closed = true
        const error = this.terminalError
          ?? new ExtensionProcessError(
            `Kernel process exited with code ${code ?? 'unknown'}${signal ? ` signal ${signal}` : ''}`,
          )
        this.failAll(error)
        resolve()
      })
    })

    process.once('exit', () => {
      child.kill()
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      console.error('[extensionsd stderr]', chunk.trim())
      // The caller sees structured failures through request rejection.
    })

    this.sendPolicy()

    return this.child
  }

  /**
   * Pushes the host performance policy to the daemon once, right after spawn.
   * Fire-and-forget: the derived-values response is dropped (no pending entry),
   * and an invalid config surfaces later through load-time admission errors.
   */
  private sendPolicy(): void {
    if (this.policySent || !this.options.policy) {
      return
    }
    this.policySent = true

    const payload: KernelRequestEnvelope = {
      kind: 'request',
      id: randomUUID(),
      method: 'kernel.policy.set',
      params: this.options.policy,
    }
    this.child?.stdin?.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    let envelope: unknown
    try {
      envelope = JSON.parse(line)
    } catch {
      this.failProtocol(new ExtensionProcessError('Invalid kernel envelope: malformed JSON from daemon stdout'))
      return
    }

    if (!isKernelEnvelope(envelope)) {
      this.failProtocol(new ExtensionProcessError('Invalid kernel envelope: unsupported daemon stdout payload'))
      return
    }

    this.handleEnvelope(envelope)
  }

  private handleEnvelope(envelope: KernelEnvelope): void {
    if (envelope.kind === 'response') {
      this.handleResponse(envelope)
      return
    }

    if (envelope.kind === 'event') {
      this.handleEvent(envelope)
    }
  }

  private handleResponse(envelope: KernelResponseEnvelope): void {
    const pending = this.pending.get(envelope.id)
    if (!pending) {
      // Late async-result envelopes for already-settled (e.g. timed-out)
      // requests are intentionally dropped — the caller has its answer.
      return
    }

    // Scheduler accepted model: an async-dispatched invoke answers with
    // `{accepted, async}` FIRST and delivers the real envelope later on the
    // SAME request id. Keep the caller's promise pending (with the async
    // result window) until that envelope settles it.
    if (
      pending.method === 'kernel.invoke'
      && pending.awaitingAsyncResult !== true
      && isAsyncAcceptedMarker(envelope)
    ) {
      pending.awaitingAsyncResult = true
      if (pending.timer) {
        clearTimeout(pending.timer)
      }
      const asyncTimeoutMs = this.options.asyncInvokeTimeoutMs ?? 120_000
      pending.timer = setTimeout(() => {
        this.pending.delete(envelope.id)
        pending.reject(new ExtensionProcessError(`Kernel async invoke timed out: ${pending.method}`))
      }, asyncTimeoutMs)
      return
    }

    this.clearPending(envelope.id)
    if (envelope.error) {
      pending.reject(new ExtensionProcessError(envelope.error.message))
      return
    }

    pending.resolve(envelope.result)
  }

  private handleEvent(envelope: KernelEventEnvelope): void {
    const waiters = this.sessionWaiters.get(envelope.sessionId)
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift()
      waiter?.resolve(envelope.event)
      if (waiters.length === 0) {
        this.sessionWaiters.delete(envelope.sessionId)
      }
      return
    }

    const queue = this.sessionQueues.get(envelope.sessionId) ?? []
    queue.push(envelope.event)
    this.sessionQueues.set(envelope.sessionId, queue)
  }

  private failProtocol(error: Error): void {
    this.closed = true
    this.terminalError = error
    this.reader?.close()
    this.child?.stdin?.destroy()
    this.child?.stdout?.destroy()
    this.child?.stderr?.destroy()
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      this.child.kill()
      return
    }
    this.failAll(error)
  }

  private clearPending(id: string): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }

    if (pending.timer) {
      clearTimeout(pending.timer)
    }

    this.pending.delete(id)
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) {
        clearTimeout(pending.timer)
      }
      pending.reject(error)
    }
    this.pending.clear()

    for (const [, waiters] of this.sessionWaiters) {
      for (const waiter of waiters) {
        waiter.reject(error)
      }
    }
    this.sessionWaiters.clear()
    this.sessionQueues.clear()
  }

  async dispose(): Promise<void> {
    if (this.child && !this.closed) {
      this.child.kill()
    }
    this.reader?.close()
    this.closed = true
    this.failAll(new ExtensionProcessError('Kernel transport disposed'))
    await this.childExitPromise
  }
}

/**
 * The scheduler's async-accept marker: a successful response whose result is
 * `{ accepted: true, async: true }`. The real envelope follows on the same id.
 */
function isAsyncAcceptedMarker(envelope: KernelResponseEnvelope): boolean {
  if (envelope.error) {
    return false
  }
  const result = envelope.result
  return typeof result === 'object' && result !== null
    && (result as { accepted?: unknown }).accepted === true
    && (result as { async?: unknown }).async === true
}

function isKernelEnvelope(value: unknown): value is KernelEnvelope {  if (!value || typeof value !== 'object' || !('kind' in value)) {
    return false
  }

  const kind = (value as { kind?: unknown }).kind
  if (kind === 'response') {
    return typeof (value as { id?: unknown }).id === 'string'
  }

  if (kind === 'event') {
    const eventEnvelope = value as { sessionId?: unknown; event?: unknown }
    return typeof eventEnvelope.sessionId === 'string'
      && Boolean(eventEnvelope.event)
      && typeof eventEnvelope.event === 'object'
  }

  return false
}

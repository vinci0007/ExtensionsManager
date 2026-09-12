import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import type { ExtensionSessionEvent } from '../../contracts/ExtensionSession.js'
import { ExtensionProcessError, ExtensionTimeoutError } from '../../errors/ExtensionError.js'
import type { JsonRpcFrame, JsonRpcRequest, JsonRpcResponse } from './JsonRpcTypes.js'

/**
 * Maximum number of session events buffered per session. A plugin flooding more
 * events than this breaches the quota: buffered events are dropped and the
 * session is failed (see SESSION_EVENT_QUOTA_EXCEEDED_MESSAGE).
 */
export const SESSION_EVENT_QUOTA = 4096

const SESSION_EVENT_QUOTA_EXCEEDED_MESSAGE = 'EVENT_QUOTA_EXCEEDED: session event queue overflow'

export class JsonRpcTransport {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(reason?: unknown): void; timer?: NodeJS.Timeout }>()
  private readonly sessionEvents = new Map<string, ExtensionSessionEvent[]>()
  private readonly breachedSessions = new Set<string>()
  private closed = false

  constructor(private readonly process: ChildProcess) {
    if (!process.stdout || !process.stdin) {
      throw new Error('Process transport requires stdio pipes')
    }

    const reader = readline.createInterface({ input: process.stdout })

    reader.on('line', (line: string) => {
      this.handleLine(line)
    })

    process.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.closed = true
      const error = new ExtensionProcessError(`Extension process exited with code ${code ?? 'unknown'}${signal ? ` signal ${signal}` : ''}`)
      this.failAll(error)
    })
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new ExtensionProcessError('Extension process is not running'))
    }

    const id = randomUUID()
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new ExtensionTimeoutError(`Timed out waiting for response to ${method}`))
            this.process.kill()
          }, timeoutMs)
        : undefined

      this.pending.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer,
      })

      this.process.stdin?.write(`${JSON.stringify(payload)}\n`, (error: Error | null | undefined) => {
        if (error) {
          this.clearPending(id)
          reject(error)
        }
      })
    })
  }

  async openSession(
    capability: string,
    input: unknown,
    timeoutMs?: number,
    extraParams: Record<string, unknown> = {},
  ): Promise<{ sessionId: string; events: ExtensionSessionEvent[] }> {
    const result = await this.request<{ sessionId: string }>('extension/openSession', {
      capability,
      input,
      ...extraParams,
    }, timeoutMs)

    return {
      sessionId: result.sessionId,
      events: this.takeSessionEvents(result.sessionId),
    }
  }

  async sessionSend(sessionId: string, data: unknown, timeoutMs?: number): Promise<ExtensionSessionEvent[]> {
    this.ensureSessionWithinQuota(sessionId)
    await this.request('extension/session.send', {
      sessionId,
      data,
    }, timeoutMs)
    return this.takeSessionEvents(sessionId)
  }

  async sessionCancel(sessionId: string, timeoutMs?: number): Promise<ExtensionSessionEvent[]> {
    this.ensureSessionWithinQuota(sessionId)
    await this.request('extension/session.cancel', {
      sessionId,
    }, timeoutMs)
    return this.takeSessionEvents(sessionId)
  }

  async sessionClose(sessionId: string, timeoutMs?: number): Promise<void> {
    this.ensureSessionWithinQuota(sessionId)
    await this.request('extension/session.close', {
      sessionId,
    }, timeoutMs)
    this.sessionEvents.delete(sessionId)
  }

  private handleLine(line: string): void {
    const frame = JSON.parse(line) as JsonRpcFrame
    if ('kind' in frame && frame.kind === 'event') {
      this.recordSessionEvent(frame.sessionId, frame.event)
      return
    }

    const response = frame as JsonRpcResponse
    const pending = this.pending.get(response.id)

    if (!pending) {
      return
    }

    this.clearPending(response.id)

    if ('error' in response) {
      pending.reject(new Error(response.error.message))
      return
    }

    pending.resolve(response.result)
  }

  private takeSessionEvents(sessionId: string): ExtensionSessionEvent[] {
    const events = this.sessionEvents.get(sessionId) ?? []
    this.sessionEvents.delete(sessionId)
    return [...events]
  }

  private recordSessionEvent(sessionId: string, event: ExtensionSessionEvent): void {
    if (this.breachedSessions.has(sessionId)) {
      return
    }

    const queue = this.sessionEvents.get(sessionId)
    if ((queue?.length ?? 0) >= SESSION_EVENT_QUOTA) {
      // Quota breach: drop buffered events so a flooding plugin cannot exhaust
      // host memory, and fail the session for all subsequent operations.
      this.sessionEvents.delete(sessionId)
      this.breachedSessions.add(sessionId)
      return
    }

    if (queue) {
      queue.push(event)
    } else {
      this.sessionEvents.set(sessionId, [event])
    }
  }

  private ensureSessionWithinQuota(sessionId: string): void {
    if (this.breachedSessions.has(sessionId)) {
      throw new ExtensionProcessError(SESSION_EVENT_QUOTA_EXCEEDED_MESSAGE)
    }
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
    this.sessionEvents.clear()
  }
}

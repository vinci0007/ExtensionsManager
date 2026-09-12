import type { ChildProcess } from 'node:child_process'
import type { ExtensionSession, ExtensionSessionEvent } from '../contracts/ExtensionSession.js'
import type { SessionContract } from '../core/sessionContracts.js'
import { allowsSessionSend } from '../core/sessionContracts.js'
import { ExtensionProcessError } from '../errors/ExtensionError.js'

export function createBufferedSession(
  sessionId: string,
  initialEvents: ExtensionSessionEvent[],
  contract: SessionContract | undefined,
  controls: {
    onSend(data: unknown): Promise<ExtensionSessionEvent[]>
    onCancel(): Promise<ExtensionSessionEvent[]>
    onClose(): Promise<void>
    emptyQueueMessage: string
  },
): ExtensionSession {
  const events = [...initialEvents]
  let closed = false

  return {
    id: sessionId,
    async send(data: unknown): Promise<void> {
      ensureSessionOpen(closed, sessionId)
      enforceSessionSendAllowed(contract)
      events.push(...await controls.onSend(data))
    },
    async nextEvent(): Promise<ExtensionSessionEvent> {
      ensureSessionOpen(closed, sessionId)
      const event = events.shift()
      if (!event) {
        throw new ExtensionProcessError(controls.emptyQueueMessage)
      }
      return event
    },
    async cancel(): Promise<void> {
      ensureSessionOpen(closed, sessionId)
      events.push(...await controls.onCancel())
    },
    async close(): Promise<void> {
      if (closed) {
        return
      }
      await controls.onClose()
      events.length = 0
      closed = true
    },
  }
}

export function createCompatibilitySession(
  sessionId: string,
  output: unknown,
  contract: SessionContract,
  emptyQueueMessage: string,
): ExtensionSession {
  const events: ExtensionSessionEvent[] = [
    { type: 'data', data: output },
    { type: 'end' },
  ]
  let closed = false

  return {
    id: sessionId,
    async send() {
      ensureSessionOpen(closed, sessionId)
      enforceSessionSendAllowed(contract)
      throw new ExtensionProcessError(`Capability requires a real session implementation: ${contract.capability.name}`)
    },
    async nextEvent() {
      ensureSessionOpen(closed, sessionId)
      const event = events.shift()
      if (!event) {
        throw new ExtensionProcessError(emptyQueueMessage)
      }
      return event
    },
    async cancel() {
      ensureSessionOpen(closed, sessionId)
      events.length = 0
      events.push({ type: 'end' })
    },
    async close() {
      if (closed) {
        return
      }
      events.length = 0
      closed = true
    },
  }
}

export function isUnsupportedSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return (
    message.includes('unsupported method')
    || message.includes('does not support sessions')
    || message.includes('does not require a real session')
  )
}

export async function waitForChildExit(
  child: ChildProcess,
  timeoutMs = 5000,
  timeoutMessage = 'Process did not exit in time',
): Promise<void> {
  if (child.exitCode !== null) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new ExtensionProcessError(timeoutMessage))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      child.off('exit', onExit)
      child.off('error', onError)
    }

    const onExit = () => {
      cleanup()
      resolve()
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    child.once('exit', onExit)
    child.once('error', onError)
  })
}

function enforceSessionSendAllowed(contract: SessionContract | undefined): void {
  if (contract && !allowsSessionSend(contract)) {
    throw new ExtensionProcessError(`Capability does not allow session.send: ${contract.capability.name}`)
  }
}

function ensureSessionOpen(closed: boolean, sessionId: string): void {
  if (closed) {
    throw new ExtensionProcessError(`Session is closed: ${sessionId}`)
  }
}

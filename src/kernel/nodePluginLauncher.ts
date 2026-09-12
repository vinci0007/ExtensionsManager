import { pathToFileURL } from 'node:url'
import readline from 'node:readline'
import type { ExtensionContext } from '../contracts/ExtensionContext.js'
import type { ExtensionInitializationInfo } from '../contracts/ExtensionInitialization.js'
import type { ExtensionSessionEvent } from '../contracts/ExtensionSession.js'
import type { NodeExtensionModule, NodeCapabilityHandler, NodeExtensionSession } from '../runtimes/node/NodeRuntime.js'

async function main(): Promise<void> {
  const entryPath = process.argv[2]
  if (!entryPath) {
    throw new Error('Node plugin launcher requires an entry path argument')
  }

  const imported = await import(pathToFileURL(entryPath).href)
  const extension = (imported.default ?? imported) as NodeExtensionModule

  if (!extension.capabilities || typeof extension.capabilities !== 'object') {
    throw new Error('Node plugin launcher requires a capabilities export map')
  }

  const sessions = new Map<string, NodeExtensionSession>()
  let nextSessionId = 1
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })

  rl.on('line', async (line) => {
    try {
      const request = JSON.parse(line) as {
        id: string
        method: string
        params?: {
          capability?: string
          input?: unknown
          sessionId?: string
          data?: unknown
          extensionId?: string
          workspacePath?: string
          storagePath?: string
          initialization?: ExtensionInitializationInfo
        }
      }

      if (request.method === 'extension/activate') {
        const context: ExtensionContext = {
          extensionId: request.params?.extensionId ?? 'legacy.node-extension',
          workspacePath: request.params?.workspacePath,
          storagePath: request.params?.storagePath,
          initialization: request.params?.initialization ?? createFallbackInitializationInfo(request.params?.extensionId),
          logger: createStdioSafeLogger(),
        }
        await extension.activate?.(context)
        writeResult(request.id, true)
        return
      }

      if (request.method === 'extension/deactivate') {
        await extension.deactivate?.()
        writeResult(request.id, true)
        process.exit(0)
        return
      }

      if (request.method === 'extension/invoke') {
        const capability = request.params?.capability
        const handler = capability ? extension.capabilities[capability] as NodeCapabilityHandler | undefined : undefined

        if (!handler) {
          writeError(request.id, `Unknown capability: ${capability ?? 'undefined'}`)
          return
        }

        const result = await handler(request.params?.input)
        writeResult(request.id, result)
        return
      }

      if (request.method === 'extension/openSession') {
        const runtimeSessionId = `runtime-session-${nextSessionId++}`
        const session = typeof extension.openSession === 'function'
          ? await extension.openSession(request.params?.capability ?? 'undefined', request.params?.input)
          : await createCompatibilitySession(extension, request.params?.capability, request.params?.input)
        sessions.set(runtimeSessionId, session)
        await drainSessionEvents(runtimeSessionId, session)
        writeResult(request.id, { sessionId: runtimeSessionId })
        return
      }

      if (request.method === 'extension/session.send') {
        const session = request.params?.sessionId ? sessions.get(request.params.sessionId) : undefined
        if (!session) {
          writeError(request.id, `Unknown session: ${request.params?.sessionId ?? 'undefined'}`)
          return
        }

        await session.send?.(request.params?.data)
        await drainSessionEvents(request.params!.sessionId!, session)
        writeResult(request.id, true)
        return
      }

      if (request.method === 'extension/session.cancel') {
        const session = request.params?.sessionId ? sessions.get(request.params.sessionId) : undefined
        if (!session) {
          writeError(request.id, `Unknown session: ${request.params?.sessionId ?? 'undefined'}`)
          return
        }

        await session.cancel?.()
        await drainSessionEvents(request.params!.sessionId!, session)
        writeResult(request.id, true)
        return
      }

      if (request.method === 'extension/session.close') {
        const session = request.params?.sessionId ? sessions.get(request.params.sessionId) : undefined
        if (!session) {
          writeError(request.id, `Unknown session: ${request.params?.sessionId ?? 'undefined'}`)
          return
        }

        await session.close?.()
        sessions.delete(request.params!.sessionId!)
        writeResult(request.id, true)
        return
      }

      writeError(request.id, `Unknown method: ${request.method}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${message}\n`)
    }
  })
}

function writeResult(id: string, result: unknown): void {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id,
    result,
  }) + '\n')
}

function writeError(id: string, message: string): void {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message,
    },
  }) + '\n')
}

function writeSessionEvent(sessionId: string, event: ExtensionSessionEvent): void {
  process.stdout.write(JSON.stringify({
    kind: 'event',
    sessionId,
    event,
  }) + '\n')
}

async function drainSessionEvents(sessionId: string, session: NodeExtensionSession): Promise<void> {
  while (true) {
    const event = await session.nextEvent()
    if (!event) {
      return
    }

    writeSessionEvent(sessionId, event as ExtensionSessionEvent)
    if ((event as ExtensionSessionEvent).type === 'end') {
      return
    }
  }
}

async function createCompatibilitySession(
  extension: NodeExtensionModule,
  capability: string | undefined,
  input: unknown,
): Promise<NodeExtensionSession> {
  const handler = capability ? extension.capabilities[capability] as NodeCapabilityHandler | undefined : undefined
  if (!handler) {
    throw new Error(`Unknown capability: ${capability ?? 'undefined'}`)
  }

  const events: ExtensionSessionEvent[] = [
    { type: 'data', data: await handler(input) },
    { type: 'end' },
  ]

  return {
    nextEvent() {
      return events.shift() ?? null
    },
    async send() {
      throw new Error('Compatibility session does not support send')
    },
    async cancel() {
      events.length = 0
      events.push({ type: 'end' })
    },
    async close() {
      events.length = 0
    },
  }
}

function createStdioSafeLogger(): NonNullable<ExtensionContext['logger']> {
  return {
    debug(message, meta) {
      writeLog('debug', message, meta)
    },
    info(message, meta) {
      writeLog('info', message, meta)
    },
    warn(message, meta) {
      writeLog('warn', message, meta)
    },
    error(message, meta) {
      writeLog('error', message, meta)
    },
  }
}

function createFallbackInitializationInfo(extensionId = 'legacy.node-extension'): ExtensionInitializationInfo {
  return {
    extensionId,
    extensionType: 'node',
    artifactKind: 'module',
    version: '0.0.0',
    protocolVersion: '1',
    capabilities: [],
    permissions: {},
    status: {
      state: 'unknown',
      reason: 'Launcher fallback initialization info was synthesized for compatibility.',
      checkedAt: new Date().toISOString(),
    },
    security: {
      status: 'third-party-untrusted',
      reason: 'Launcher fallback initialization info has no verified security context.',
    },
    supportsManualReinitialize: true,
    isActive: false,
  }
}

function writeLog(level: string, message: string, meta?: unknown): void {
  const suffix = typeof meta === 'undefined' ? '' : ` ${safeStringify(meta)}`
  process.stderr.write(`[${level}] ${message}${suffix}\n`)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})

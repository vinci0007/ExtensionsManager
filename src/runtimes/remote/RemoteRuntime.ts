import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ExtensionLaunchSpec } from '../../contracts/ExtensionArtifact.js'
import type { ExtensionContext } from '../../contracts/ExtensionContext.js'
import type { ExtensionInstance } from '../../contracts/ExtensionInstance.js'
import type { ExtensionManifest } from '../../contracts/ExtensionManifest.js'
import type { ExtensionSession, ExtensionSessionEvent } from '../../contracts/ExtensionSession.js'
import type { ResolvedArtifact } from '../../core/ArtifactResolver.js'
import type { ExtensionRuntimeAdapter } from '../../core/RuntimeRouter.js'
import { requiresRealSession, resolveSessionContract, type SessionContract } from '../../core/sessionContracts.js'
import { ExtensionProcessError } from '../../errors/ExtensionError.js'
import { isLoopbackHost } from '../../security/statusProbeGuard.js'
import { createBufferedSession, createCompatibilitySession, isUnsupportedSessionError, waitForChildExit } from '../sessionRuntimeUtils.js'
import { JsonRpcTransport } from '../process/JsonRpcTransport.js'

export interface RemoteRuntimeOptions {
  /**
   * Allow plain http:// remote endpoints for non-loopback hosts.
   * Loopback endpoints (localhost, 127.0.0.0/8, [::1]) are always allowed over http.
   * Default: false.
   */
  allowInsecureHttp?: boolean
}

export class RemoteRuntime implements ExtensionRuntimeAdapter {
  readonly runtime = 'remote' as const

  constructor(private readonly options: RemoteRuntimeOptions = {}) {}

  private get allowInsecureHttp(): boolean {
    return this.options.allowInsecureHttp ?? false
  }

  async load(manifest: ExtensionManifest, artifact: ResolvedArtifact): Promise<ExtensionInstance> {
    const endpoint = manifest.artifact.launch?.endpoint ?? artifact.command
    const transport = manifest.artifact.launch?.transport ?? 'process'

    if (transport === 'http' || transport === 'https') {
      if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
        throw new ExtensionProcessError(`Remote endpoint must be an http(s) URL: ${endpoint}`)
      }

      await sendHttpJsonRpc(endpoint, 'extension/load', {
        extensionId: manifest.id,
        manifest,
      }, this.createHttpCallOptions(manifest.artifact.launch))

      return this.createHttpInstance(manifest, endpoint)
    }

    if (transport !== 'process' && transport !== 'process-stdio' && transport !== 'stdio') {
      throw new ExtensionProcessError(`Unsupported remote transport: ${transport}`)
    }

    const child = spawn(artifact.command, artifact.args, {
      cwd: artifact.cwd,
      env: {
        ...process.env,
        ...(manifest.artifact.launch?.env ?? {}),
        EXTENSIONS_REMOTE_ENDPOINT: endpoint,
      },
      shell: manifest.artifact.launch?.shell ?? false,
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    })

    if (!child.pid || !child.stdin || !child.stdout) {
      throw new ExtensionProcessError(`Failed to start remote runtime process: ${manifest.id}`)
    }

    const transportBridge = new JsonRpcTransport(child)
    return this.createProcessInstance(manifest, transportBridge, child, endpoint)
  }

  private createHttpCallOptions(launch: ExtensionLaunchSpec | undefined): RemoteHttpCallOptions {
    return {
      timeoutMs: launch?.timeoutMs,
      headers: resolveAuthHeaders(launch),
      allowInsecureHttp: this.allowInsecureHttp,
    }
  }

  private createHttpInstance(manifest: ExtensionManifest, endpoint: string): ExtensionInstance {
    const callOptions = (): RemoteHttpCallOptions => this.createHttpCallOptions(manifest.artifact.launch)

    return {
      id: manifest.id,
      manifest,
      security: {
        status: 'third-party-untrusted',
        reason: 'Runtime instances are untrusted until ExtensionManager evaluates authorization.',
      },
      async activate(context: ExtensionContext) {
        await sendHttpJsonRpc(
          endpoint,
          'extension/activate',
          createActivationPayload(context, { endpoint }),
          callOptions(),
        )
      },
      async deactivate() {
        await sendHttpJsonRpc(endpoint, 'extension/deactivate', { endpoint }, callOptions())
      },
      async invoke<TInput = unknown, TOutput = unknown>(capability: string, input: TInput): Promise<TOutput> {
        return sendHttpJsonRpc<TOutput>(endpoint, 'extension/invoke', {
          capability,
          input,
          endpoint,
        }, callOptions())
      },
      async openSession<TInput = unknown>(capability: string, input: TInput): Promise<ExtensionSession> {
        const contract = resolveSessionContract(manifest, capability)
        try {
          const opened = await sendHttpJsonRpc<RemoteSessionOpenResult>(
            endpoint,
            'extension/openSession',
            {
              capability,
              input,
              endpoint,
            },
            callOptions(),
          )
          return createBufferedSession(
            opened.sessionId,
            opened.events ?? [],
            contract,
            {
              onSend: async (data) => {
                const result = await sendHttpJsonRpc<RemoteSessionEventResult>(
                  endpoint,
                  'extension/session.send',
                  {
                    sessionId: opened.sessionId,
                    data,
                    endpoint,
                  },
                  callOptions(),
                )
                return result.events ?? []
              },
              onCancel: async () => {
                const result = await sendHttpJsonRpc<RemoteSessionEventResult>(
                  endpoint,
                  'extension/session.cancel',
                  {
                    sessionId: opened.sessionId,
                    endpoint,
                  },
                  callOptions(),
                )
                return result.events ?? []
              },
              onClose: async () => {
                await sendHttpJsonRpc(
                  endpoint,
                  'extension/session.close',
                  {
                    sessionId: opened.sessionId,
                    endpoint,
                  },
                  callOptions(),
                )
              },
              emptyQueueMessage: `Remote session has no queued events: ${opened.sessionId}`,
            },
          )
        } catch (error) {
          if (isUnsupportedSessionError(error)) {
            if (requiresRealSession(contract)) {
              throw new ExtensionProcessError(`Capability requires a real session implementation: ${capability}`)
            }
            const output = await sendHttpJsonRpc(
              endpoint,
              'extension/invoke',
              {
                capability,
                input,
                endpoint,
              },
              callOptions(),
            )
            return createCompatibilitySession(
              'remote-http-compatibility-session',
              output,
              contract,
              'Compatibility remote HTTP session has no more events',
            )
          }

          throw error
        }
      },
    }
  }

  private createProcessInstance(
    manifest: ExtensionManifest,
    transportBridge: JsonRpcTransport,
    child: ReturnType<typeof spawn>,
    endpoint: string,
  ): ExtensionInstance {
    return {
      id: manifest.id,
      manifest,
      security: {
        status: 'third-party-untrusted',
        reason: 'Runtime instances are untrusted until ExtensionManager evaluates authorization.',
      },
      async activate(context: ExtensionContext) {
        await transportBridge.request(
          'extension/activate',
          createActivationPayload(context, { endpoint }),
          manifest.artifact.launch?.timeoutMs,
        )
      },
      async deactivate() {
        await transportBridge.request('extension/deactivate', undefined, manifest.artifact.launch?.timeoutMs)
        await waitForChildExit(child, manifest.artifact.launch?.timeoutMs, 'Remote process runtime did not exit in time')

        if (!child.killed && child.exitCode === null) {
          child.kill()
          await waitForChildExit(child, manifest.artifact.launch?.timeoutMs, 'Remote process runtime did not exit in time')
        }
      },
      async invoke<TInput = unknown, TOutput = unknown>(capability: string, input: TInput): Promise<TOutput> {
        return transportBridge.request('extension/invoke', {
          capability,
          input,
          endpoint,
        }, manifest.artifact.launch?.timeoutMs)
      },
      async openSession<TInput = unknown>(capability: string, input: TInput): Promise<ExtensionSession> {
        const contract = resolveSessionContract(manifest, capability)
        try {
          const opened = await transportBridge.openSession(
            capability,
            input,
            manifest.artifact.launch?.timeoutMs,
            { endpoint },
          )
          return createBufferedSession(
            opened.sessionId,
            opened.events,
            contract,
            {
              onSend: (data) => transportBridge.sessionSend(opened.sessionId, data, manifest.artifact.launch?.timeoutMs),
              onCancel: () => transportBridge.sessionCancel(opened.sessionId, manifest.artifact.launch?.timeoutMs),
              onClose: () => transportBridge.sessionClose(opened.sessionId, manifest.artifact.launch?.timeoutMs),
              emptyQueueMessage: `Remote process session has no queued events: ${opened.sessionId}`,
            },
          )
        } catch (error) {
          if (isUnsupportedSessionError(error)) {
            if (requiresRealSession(contract)) {
              throw new ExtensionProcessError(`Capability requires a real session implementation: ${capability}`)
            }
            const output = await transportBridge.request(
              'extension/invoke',
              {
                capability,
                input,
                endpoint,
              },
              manifest.artifact.launch?.timeoutMs,
            )
            return createCompatibilitySession(
              'remote-http-compatibility-session',
              output,
              contract,
              'Compatibility remote HTTP session has no more events',
            )
          }

          throw error
        }
      },
    }
  }
}

interface RemoteSessionOpenResult {
  sessionId: string
  events?: ExtensionSessionEvent[]
}

interface RemoteSessionEventResult {
  events?: ExtensionSessionEvent[]
}

function createActivationPayload(
  context: ExtensionContext,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    extensionId: context.extensionId,
    workspacePath: context.workspacePath,
    storagePath: context.storagePath,
    initialization: context.initialization,
    ...extra,
  }
}

interface RemoteHttpCallOptions {
  timeoutMs?: number
  headers?: Record<string, string>
  allowInsecureHttp?: boolean
}

/**
 * Resolve the auth header for an outgoing remote HTTP call. The secret is read
 * from process.env at request time; it is never stored in the manifest.
 */
function resolveAuthHeaders(launch: ExtensionLaunchSpec | undefined): Record<string, string> {
  const auth = launch?.auth
  if (!auth) {
    return {}
  }

  const secret = process.env[auth.valueEnv]
  if (secret === undefined || secret === '') {
    throw new ExtensionProcessError(`Remote auth env var is not set: ${auth.valueEnv}`)
  }

  if (auth.kind === 'bearer') {
    return { authorization: `Bearer ${secret}` }
  }

  if (auth.kind === 'header') {
    return { [auth.headerName ?? 'X-Api-Key']: secret }
  }

  throw new ExtensionProcessError(`Unsupported remote auth kind: ${String((auth as { kind?: unknown }).kind)}`)
}

function assertEndpointTlsPolicy(endpoint: string, allowInsecureHttp: boolean): void {
  if (allowInsecureHttp) {
    return
  }

  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return
  }

  if (parsed.protocol !== 'http:' || isLoopbackHost(parsed.hostname)) {
    return
  }

  throw new ExtensionProcessError(`Remote endpoint must use https:// for non-loopback hosts: ${endpoint}. Set allowInsecureHttp to true on RemoteRuntime to permit plain http.`)
}

async function sendHttpJsonRpc<T = unknown>(
  endpoint: string,
  method: string,
  params?: unknown,
  options: RemoteHttpCallOptions = {},
): Promise<T> {
  assertEndpointTlsPolicy(endpoint, options.allowInsecureHttp ?? false)

  const controller = options.timeoutMs ? new AbortController() : undefined
  const timer = options.timeoutMs
    ? setTimeout(() => controller?.abort(), options.timeoutMs)
    : undefined

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...options.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method,
        params,
      }),
      signal: controller?.signal,
    })

    if (!response.ok) {
      throw new ExtensionProcessError(`Remote endpoint request failed: ${response.status} ${response.statusText}`)
    }

    const payload = await response.json() as {
      result?: T
      error?: { message?: string }
    }

    if (payload.error) {
      throw new ExtensionProcessError(payload.error.message ?? 'Remote endpoint returned an error')
    }

    return payload.result as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ExtensionProcessError(`Remote endpoint request timed out: ${method}`)
    }

    throw error
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

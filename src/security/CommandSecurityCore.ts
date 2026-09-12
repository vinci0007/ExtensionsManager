import { spawn } from 'node:child_process'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ExtensionSecurityInfo } from '../contracts/ExtensionInstance.js'
import type { RevocationList, TrustBundle } from '../contracts/TrustBundle.js'
import type { SignaturePolicy } from './SignaturePolicy.js'
import type { ExtensionSecurityCore } from './ExtensionSecurityCore.js'

const validSecurityStatuses = new Set<ExtensionSecurityInfo['status']>([
  'authorized-safe',
  'third-party-untrusted',
  'unsigned',
])

export interface CommandSecurityCoreRequest {
  manifest: ExtensionManifest
  signaturePolicy?: SignaturePolicy
  isDevelopment?: boolean
  trustBundle?: TrustBundle
  revocationList?: RevocationList
  trustedKeyDirectory?: string
  trustedPublicKeys?: Record<string, string>
}

export type CommandSecurityCoreResponse = ExtensionSecurityInfo

export interface CommandSecurityCoreRequestOptions {
  signaturePolicy?: SignaturePolicy
  isDevelopment?: boolean
  trustBundle?: TrustBundle
  revocationList?: RevocationList
  trustedKeyDirectory?: string
  trustedPublicKeys?: Record<string, string>
}

export interface CommandSecurityCoreOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  signaturePolicy?: SignaturePolicy
  isDevelopment?: boolean
  trustBundle?: TrustBundle
  revocationList?: RevocationList
  trustedKeyDirectory?: string
  trustedPublicKeys?: Record<string, string>
}

export function createCommandSecurityCoreRequest(
  manifest: ExtensionManifest,
  options: CommandSecurityCoreRequestOptions = {},
): CommandSecurityCoreRequest {
  return {
    manifest,
    signaturePolicy: options.signaturePolicy,
    isDevelopment: options.isDevelopment,
    trustBundle: options.trustBundle,
    revocationList: options.revocationList,
    trustedKeyDirectory: options.trustedKeyDirectory,
    trustedPublicKeys: options.trustedPublicKeys,
  }
}

export function stringifyCommandSecurityCoreRequest(request: CommandSecurityCoreRequest): string {
  return JSON.stringify(request)
}

export function parseCommandSecurityCoreRequest(input: string): CommandSecurityCoreRequest {
  return JSON.parse(input) as CommandSecurityCoreRequest
}

export function parseCommandSecurityCoreResponse(input: string): CommandSecurityCoreResponse {
  const response = JSON.parse(input) as Partial<ExtensionSecurityInfo>
  assertValidCommandSecurityCoreResponse(response)
  return {
    status: response.status,
    reason: response.reason,
  }
}

export function stringifyCommandSecurityCoreResponse(response: CommandSecurityCoreResponse): string {
  assertValidCommandSecurityCoreResponse(response)
  return JSON.stringify(response)
}

export class CommandSecurityCore implements ExtensionSecurityCore {
  constructor(private readonly options: CommandSecurityCoreOptions) {}

  async evaluateManifest(manifest: ExtensionManifest): Promise<ExtensionSecurityInfo> {
    const request = createCommandSecurityCoreRequest(manifest, this.options)

    try {
      const stdout = await this.execute(stringifyCommandSecurityCoreRequest(request))
      return parseCommandSecurityCoreResponse(stdout)
    } catch (error) {
      throw new Error(`Security core command failed: ${manifest.id}`, { cause: error })
    }
  }

  private execute(input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd,
        env: {
          ...process.env,
          ...this.options.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let settled = false
      const timeoutMs = this.options.timeoutMs ?? 5000

      const timer = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        child.kill()
        reject(new Error(`Security core command timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      child.on('error', (error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        reject(error)
      })

      child.on('close', (code, signal) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)

        if (code !== 0) {
          const details = stderr.trim() || `exit code ${code}${signal ? `, signal ${signal}` : ''}`
          reject(new Error(details))
          return
        }

        resolve(stdout)
      })

      child.stdin.on('error', (error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        reject(error)
      })

      child.stdin.end(input)
    })
  }
}

function assertValidCommandSecurityCoreResponse(
  response: Partial<ExtensionSecurityInfo>,
): asserts response is CommandSecurityCoreResponse {
  if (!validSecurityStatuses.has(response.status as ExtensionSecurityInfo['status'])) {
    throw new Error('Security core command returned invalid status')
  }
  if (typeof response.reason !== 'string' || response.reason.length === 0) {
    throw new Error('Security core command returned invalid reason')
  }
}

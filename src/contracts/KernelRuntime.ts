import type { ExtensionRuntime } from './ExtensionRuntime.js'

export type CanonicalRuntimeKind = 'process' | 'wasm' | 'native-bridge' | 'remote'

export interface CanonicalProcessRuntimeSpec {
  kind: 'process'
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}

export interface CanonicalWasmRuntimeSpec {
  kind: 'wasm'
  entryPath: string
  cwd: string
}

export interface CanonicalNativeBridgeRuntimeSpec {
  kind: 'native-bridge'
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}

export interface CanonicalRemoteRuntimeSpec {
  kind: 'remote'
  endpoint: string
  transport?: string
}

export type CanonicalRuntimeSpec =
  | CanonicalProcessRuntimeSpec
  | CanonicalWasmRuntimeSpec
  | CanonicalNativeBridgeRuntimeSpec
  | CanonicalRemoteRuntimeSpec

export interface NormalizedResolvedArtifact {
  entryPath: string
  command: string
  args: string[]
  cwd: string
  basePath: string
}

export interface NormalizedResolvedRuntime {
  originalRuntime: ExtensionRuntime
  artifact: NormalizedResolvedArtifact
  runtime: CanonicalRuntimeSpec
}

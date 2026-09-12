export type ExtensionArtifactKind =
  | 'source-file'
  | 'source-dir'
  | 'module'
  | 'package'
  | 'binary'
  | 'shared-library'
  | 'wasm'

export type PlatformKey = `${NodeJS.Platform}-${NodeJS.Architecture}`

export type PlatformEntry = string | Partial<Record<PlatformKey | 'default', string>>

export interface ExtensionBuildSpec {
  command: string
  output?: string
  cwd?: string
}

export type ExtensionAuthKind = 'bearer' | 'header'

/**
 * Remote HTTP authentication specification. The secret value is never stored in
 * the manifest; it is read at request time from `process.env[valueEnv]`.
 */
export interface ExtensionAuthSpec {
  kind: ExtensionAuthKind
  /** Header name for kind 'header'. Defaults to 'X-Api-Key'. */
  headerName?: string
  /** Name of the environment variable holding the secret value. */
  valueEnv: string
}

export interface ExtensionLaunchSpec {
  command?: string
  args?: string[]
  cwd?: string
  shell?: boolean
  env?: Record<string, string>
  endpoint?: string
  transport?: string
  timeoutMs?: number
  auth?: ExtensionAuthSpec
}

export interface ExtensionArtifact {
  kind: ExtensionArtifactKind
  entry: PlatformEntry
  build?: ExtensionBuildSpec
  launch?: ExtensionLaunchSpec
  integrity?: string
}

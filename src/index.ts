export { createConfiguredExtensionManager, createExtensionManagerFromConfig, createExtensionManagerFromHostConfig, loadPluginsDirectory } from './core/createExtensionManagerFromConfig.js'
export type {
  CommandSecurityCoreConfig,
  ConfiguredExtensionManager,
  ExtensionManagerConfig,
  KernelConfig,
  KernelSecurityConfig,
  LoadPluginsDirectoryOptions,
} from './core/createExtensionManagerFromConfig.js'
export { ExtensionManager } from './core/ExtensionManager.js'
export type { ExtensionManagerOptions } from './core/ExtensionManager.js'
export { PluginStore } from './core/PluginStore.js'
export type { PluginStoreOptions } from './core/PluginStore.js'
export { defineExtension } from './sdk/defineExtension.js'
export { assertStatusProbeAllowed, isLoopbackHost, isPrivateNetworkHost } from './security/statusProbeGuard.js'
export { assertWasmMemoryWithinQuota, parseWasmMemoryLimits, WASM_MEMORY_QUOTA_PAGES } from './security/wasmModuleLimits.js'
export { SESSION_EVENT_QUOTA } from './runtimes/process/JsonRpcTransport.js'
export { NodeRuntime } from './runtimes/node/NodeRuntime.js'
export { ProcessRuntime } from './runtimes/process/ProcessRuntime.js'
export { WasmRuntime } from './runtimes/wasm/WasmRuntime.js'
export { NativeRuntime } from './runtimes/native/NativeRuntime.js'
export { RemoteRuntime } from './runtimes/remote/RemoteRuntime.js'
export type { RemoteRuntimeOptions } from './runtimes/remote/RemoteRuntime.js'
export type { ExtensionArtifact, ExtensionArtifactKind, ExtensionAuthKind, ExtensionAuthSpec, ExtensionBuildSpec, ExtensionLaunchSpec, PlatformEntry, PlatformKey } from './contracts/ExtensionArtifact.js'
export type { KernelPolicyConfig, KernelFramePolicy, KernelMemoryPolicy, KernelMemoryTiers, KernelFuelPolicy, PolicyConsentRequest } from './contracts/KernelPolicy.js'
export type {
  ExtensionCapability,
  ExtensionConcurrencyPolicy,
  ExtensionExecutionMode,
  ExtensionInteractionMode,
  ExtensionRealtimeClass,
  ExtensionResourceBudget,
} from './contracts/ExtensionCapability.js'
export type { ExtensionContext } from './contracts/ExtensionContext.js'
export type {
  ExtensionInitializationInfo,
  ExtensionInitializationStatus,
  ExtensionInitializationStatusState,
} from './contracts/ExtensionInitialization.js'
export type { ExtensionInstance, ExtensionSecurityInfo, ExtensionSecurityStatus } from './contracts/ExtensionInstance.js'
export type {
  ExtensionDistribution,
  ExtensionManifest,
  ExtensionManifestMetadata,
  ExtensionPartyInfo,
  ExtensionStatusCheck,
  ExtensionStatusCheckKind,
  ExtensionTrustDomain,
  ExtensionTrustMetadata,
} from './contracts/ExtensionManifest.js'
export type { ExtensionPermissionDescriptor, ExtensionPermissionSet } from './contracts/ExtensionPermissions.js'
export type { ExtensionRuntime } from './contracts/ExtensionRuntime.js'
export type {
  CanonicalRuntimeKind,
  CanonicalRuntimeSpec,
  NormalizedResolvedArtifact,
  NormalizedResolvedRuntime,
} from './contracts/KernelRuntime.js'
export type { ExtensionSession, ExtensionSessionEvent } from './contracts/ExtensionSession.js'
export type { ExtensionSignature } from './contracts/ExtensionSignature.js'
export type { RevocationList, RevokedIssuer, RevokedPublisher, RevokedSignatureKey, TrustAuthorization, TrustBundle, TrustBundleIssuer } from './contracts/TrustBundle.js'
export { CommandSecurityCore } from './security/CommandSecurityCore.js'
export {
  createCommandSecurityCoreRequest,
  parseCommandSecurityCoreRequest,
  parseCommandSecurityCoreResponse,
  stringifyCommandSecurityCoreRequest,
  stringifyCommandSecurityCoreResponse,
} from './security/CommandSecurityCore.js'
export type {
  CommandSecurityCoreOptions,
  CommandSecurityCoreRequest,
  CommandSecurityCoreRequestOptions,
  CommandSecurityCoreResponse,
} from './security/CommandSecurityCore.js'
export { TypeScriptSecurityCore } from './security/ExtensionSecurityCore.js'
export type { ExtensionSecurityCore, TypeScriptSecurityCoreOptions } from './security/ExtensionSecurityCore.js'
export { TypeScriptSignatureEvaluator } from './security/ExtensionSignatureEvaluator.js'
export type { ExtensionSignatureEvaluator, TypeScriptSignatureEvaluatorOptions } from './security/ExtensionSignatureEvaluator.js'
export { TypeScriptTrustEvaluator } from './security/ExtensionTrustEvaluator.js'
export type { ExtensionTrustEvaluator, TypeScriptTrustEvaluatorOptions } from './security/ExtensionTrustEvaluator.js'
export { enforceTrustPolicy } from './security/enforceTrustPolicy.js'
export { extensionManifestSchema, JsonSchemaValidator, JsonSchemaValidationError, validateExtensionManifestShape } from './core/JsonSchemaValidator.js'
export { PublicKeySignatureVerifier } from './security/PublicKeySignatureVerifier.js'
export type { ExtensionSignatureVerifier, TrustedKeyStore } from './security/PublicKeySignatureVerifier.js'
export type { SignaturePolicy } from './security/SignaturePolicy.js'
export { InMemoryTrustedKeyStore, FileTrustedKeyStore } from './security/TrustedKeyStores.js'
export { enforceSignaturePolicy, shouldRequireSignature } from './security/enforceSignaturePolicy.js'
export { canonicalizeManifest } from './security/canonicalizeManifest.js'
export { signManifest } from './security/signManifest.js'
export { generateSigningKeyPair } from './security/generateSigningKeyPair.js'
export { computeSha256, computeFileSha256, verifyArtifactIntegrity } from './security/artifactIntegrity.js'
export { loadTrustBundleFile, loadRevocationListFile } from './security/loadTrustConfig.js'
export { CommandKernelBridge } from './kernel/CommandKernelBridge.js'
export { LocalKernelBridge } from './kernel/LocalKernelBridge.js'
export { normalizeExtensionManifestForKernel } from './kernel/normalizeManifest.js'
export type {
  CanonicalKernelCapability,
  KernelEnvelope,
  KernelEventEnvelope,
  KernelLoadRequest,
  KernelLoadResult,
  KernelRequestEnvelope,
  KernelResponseEnvelope,
  KernelSecurityContext,
  KernelSessionOpenResult,
} from './kernel/KernelProtocol.js'
export type { KernelBridge, KernelBridgeLoadResult } from './kernel/KernelBridge.js'
export type { KernelBridgeDaemonOptions } from './kernel/CommandKernelBridge.js'

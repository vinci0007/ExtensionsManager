import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ExtensionAuthSpec, ExtensionLaunchSpec } from '../contracts/ExtensionArtifact.js'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ResolvedArtifact } from '../core/ArtifactResolver.js'
import { ExtensionManager, RemoteRuntime } from '../index.js'
import { assertStatusProbeAllowed } from '../security/statusProbeGuard.js'

interface CapturedRequest {
  method: string
  headers: http.IncomingHttpHeaders
}

interface RpcServerHandle {
  endpoint: string
  requests: CapturedRequest[]
  close: () => Promise<void>
}

async function startRpcServer(): Promise<RpcServerHandle> {
  const requests: CapturedRequest[] = []
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.statusCode = 405
      response.end()
      return
    }

    let body = ''
    for await (const chunk of request) {
      body += chunk.toString()
    }

    const rpc = JSON.parse(body) as { id: string; method: string }
    requests.push({ method: rpc.method, headers: request.headers })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind remote security test server')
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}/extensions/demo.secure`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function writeRemoteHttpManifest(
  tempDirectory: string,
  id: string,
  endpoint: string,
  auth?: ExtensionAuthSpec,
): Promise<void> {
  await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
    id,
    version: '1.0.0',
    protocolVersion: '1',
    artifact: {
      kind: 'binary',
      entry: './remote-placeholder',
      launch: {
        command: endpoint,
        endpoint,
        transport: 'http',
        ...(auth ? { auth } : {}),
      },
    },
    runtime: 'remote',
    capabilities: [{ name: 'demo.secure' }],
  }, null, 2), 'utf8')
}

function buildRemoteHttpManifest(endpoint: string, launchOverrides: Partial<ExtensionLaunchSpec> = {}): ExtensionManifest {
  return {
    id: 'demo.remote-direct',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: {
      kind: 'binary',
      entry: './remote-placeholder',
      launch: {
        command: endpoint,
        endpoint,
        transport: 'http',
        ...launchOverrides,
      },
    },
    runtime: 'remote',
    capabilities: [{ name: 'demo.secure' }],
  }
}

function createArtifactStub(basePath: string, command: string): ResolvedArtifact {
  return {
    entryPath: path.join(basePath, 'remote-placeholder'),
    command,
    args: [],
    cwd: basePath,
    basePath,
  }
}

test('remote http runtime sends bearer auth header from env', async () => {
  const envName = 'EXT_TEST_REMOTE_BEARER_TOKEN'
  process.env[envName] = 'secret-bearer-value'
  const server = await startRpcServer()
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-remote-auth-bearer-'))
  let manager: ExtensionManager | undefined

  try {
    await writeRemoteHttpManifest(tempDirectory, 'demo.remote-auth-bearer', server.endpoint, {
      kind: 'bearer',
      valueEnv: envName,
    })

    manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new RemoteRuntime())

    await manager.loadManifestFile(tempDirectory)
    const result = await manager.invoke('demo.remote-auth-bearer', 'demo.secure', {})
    assert.equal(result, true)

    const invoke = server.requests.find((item) => item.method === 'extension/invoke')
    assert.ok(invoke, 'extension/invoke request was not captured')
    assert.equal(invoke.headers.authorization, 'Bearer secret-bearer-value')
  } finally {
    await manager?.dispose().catch(() => {})
    delete process.env[envName]
    await server.close()
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('remote http runtime sends custom auth header from env', async () => {
  const envName = 'EXT_TEST_REMOTE_HEADER_TOKEN'
  process.env[envName] = 'secret-header-value'
  const server = await startRpcServer()
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-remote-auth-header-'))
  let manager: ExtensionManager | undefined

  try {
    await writeRemoteHttpManifest(tempDirectory, 'demo.remote-auth-header', server.endpoint, {
      kind: 'header',
      headerName: 'X-Custom-Credential',
      valueEnv: envName,
    })

    manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new RemoteRuntime())

    await manager.loadManifestFile(tempDirectory)
    await manager.invoke('demo.remote-auth-header', 'demo.secure', {})

    const invoke = server.requests.find((item) => item.method === 'extension/invoke')
    assert.ok(invoke, 'extension/invoke request was not captured')
    assert.equal(invoke.headers['x-custom-credential'], 'secret-header-value')
  } finally {
    await manager?.dispose().catch(() => {})
    delete process.env[envName]
    await server.close()
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('remote http runtime defaults auth header to x-api-key', async () => {
  const envName = 'EXT_TEST_REMOTE_API_KEY'
  process.env[envName] = 'secret-api-key-value'
  const server = await startRpcServer()
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-remote-auth-default-'))
  let manager: ExtensionManager | undefined

  try {
    await writeRemoteHttpManifest(tempDirectory, 'demo.remote-auth-default', server.endpoint, {
      kind: 'header',
      valueEnv: envName,
    })

    manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new RemoteRuntime())

    await manager.loadManifestFile(tempDirectory)
    await manager.invoke('demo.remote-auth-default', 'demo.secure', {})

    const invoke = server.requests.find((item) => item.method === 'extension/invoke')
    assert.ok(invoke, 'extension/invoke request was not captured')
    assert.equal(invoke.headers['x-api-key'], 'secret-api-key-value')
  } finally {
    await manager?.dispose().catch(() => {})
    delete process.env[envName]
    await server.close()
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('remote http runtime fails with actionable error when auth env var is missing', async () => {
  const envName = 'EXT_TEST_REMOTE_MISSING_TOKEN'
  delete process.env[envName]
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-remote-auth-missing-'))

  try {
    const endpoint = 'http://127.0.0.1:9/extensions/demo.missing-env'
    const runtime = new RemoteRuntime()
    const manifest = buildRemoteHttpManifest(endpoint, { auth: { kind: 'bearer', valueEnv: envName } })

    await assert.rejects(
      () => runtime.load(manifest, createArtifactStub(tempDirectory, endpoint)),
      /Remote auth env var is not set: EXT_TEST_REMOTE_MISSING_TOKEN/,
    )
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('remote http runtime rejects plain http for non-loopback endpoints', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-remote-tls-'))

  try {
    const endpoint = 'http://insecure.internal.example/extensions/demo.tls'
    const runtime = new RemoteRuntime()
    const manifest = buildRemoteHttpManifest(endpoint)

    await assert.rejects(
      () => runtime.load(manifest, createArtifactStub(tempDirectory, endpoint)),
      /Remote endpoint must use https:\/\/ for non-loopback hosts: http:\/\/insecure\.internal\.example\/extensions\/demo\.tls/,
    )
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('remote http runtime with allowInsecureHttp permits non-loopback http and reaches the network layer', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-remote-tls-allowed-'))

  try {
    const endpoint = 'http://unreachable-host-for-test.invalid/extensions/demo.tls-allowed'
    const runtime = new RemoteRuntime({ allowInsecureHttp: true })
    const manifest = buildRemoteHttpManifest(endpoint, { timeoutMs: 2000 })

    await assert.rejects(
      () => runtime.load(manifest, createArtifactStub(tempDirectory, endpoint)),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.doesNotMatch(message, /non-loopback/)
        return true
      },
    )
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('status probe guard allows own-endpoint, loopback, and allowlisted hosts', () => {
  assert.doesNotThrow(() => assertStatusProbeAllowed(
    'http://api.partner.example:8080/status',
    'http://api.partner.example:9000/rpc',
    [],
  ))
  assert.doesNotThrow(() => assertStatusProbeAllowed('http://127.0.0.1:4567/health', undefined, []))
  assert.doesNotThrow(() => assertStatusProbeAllowed('http://localhost/health', 'http://other.example/rpc', []))
  assert.doesNotThrow(() => assertStatusProbeAllowed('http://[::1]:8080/health', undefined, []))
  assert.doesNotThrow(() => assertStatusProbeAllowed('http://status.partner.example/status', undefined, [
    'STATUS.Partner.example',
  ]))
})

test('status probe guard rejects private-range and non-allowlisted hosts', () => {
  assert.throws(
    () => assertStatusProbeAllowed('http://10.0.0.5:8080/status', undefined, []),
    /Status probe host not allowed: 10\.0\.0\.5/,
  )
  assert.throws(
    () => assertStatusProbeAllowed('http://172.16.3.4/status', 'http://10.0.0.5/rpc', []),
    /Status probe host not allowed: 172\.16\.3\.4/,
  )
  assert.throws(
    () => assertStatusProbeAllowed('http://192.168.1.10/status', undefined, []),
    /Status probe host not allowed: 192\.168\.1\.10/,
  )
  assert.throws(
    () => assertStatusProbeAllowed('http://169.254.1.2/status', undefined, []),
    /Status probe host not allowed: 169\.254\.1\.2/,
  )
  assert.throws(
    () => assertStatusProbeAllowed('http://[fd12::1]/status', undefined, []),
    /Status probe host not allowed: fd12::1/,
  )
  assert.throws(
    () => assertStatusProbeAllowed('http://public.example/status', undefined, []),
    /Status probe host not allowed: public\.example/,
  )
  assert.throws(
    () => assertStatusProbeAllowed('http://10.1.2.3/status', undefined, ['10.1.2.4']),
    /Status probe host not allowed: 10\.1\.2\.3/,
  )
})

test('checkStatus allows a jsonrpc probe to the extension own endpoint', async () => {
  const server = await startRpcServer()
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-probe-guard-own-'))
  let manager: ExtensionManager | undefined

  try {
    await writeRemoteHttpManifest(tempDirectory, 'demo.remote-probe-own', server.endpoint)

    manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new RemoteRuntime())
    await manager.loadManifestFile(tempDirectory)

    const status = await manager.checkStatus('demo.remote-probe-own')
    assert.equal(status.state, 'available')
  } finally {
    await manager?.dispose().catch(() => {})
    await server.close()
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('checkStatus blocks url status probes targeting private hosts', async () => {
  const server = await startRpcServer()
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-probe-guard-private-'))
  let manager: ExtensionManager | undefined

  try {
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.remote-probe-private',
      version: '1.0.0',
      protocolVersion: '1',
      metadata: {
        statusCheck: {
          kind: 'url',
          endpoint: 'http://10.222.0.1:9/health',
          method: 'GET',
          timeoutMs: 300,
        },
      },
      artifact: {
        kind: 'binary',
        entry: './remote-placeholder',
        launch: {
          command: server.endpoint,
          endpoint: server.endpoint,
          transport: 'http',
        },
      },
      runtime: 'remote',
      capabilities: [{ name: 'demo.secure' }],
    }, null, 2), 'utf8')

    manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new RemoteRuntime())
    await manager.loadManifestFile(tempDirectory)

    const status = await manager.checkStatus('demo.remote-probe-private')
    assert.equal(status.state, 'unavailable')
    assert.match(status.reason, /Status probe host not allowed: 10\.222\.0\.1/)
  } finally {
    await manager?.dispose().catch(() => {})
    await server.close()
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('checkStatus blocks jsonrpc status probes targeting private hosts', async () => {
  const server = await startRpcServer()
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-probe-guard-jsonrpc-'))
  let manager: ExtensionManager | undefined

  try {
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.remote-probe-jsonrpc',
      version: '1.0.0',
      protocolVersion: '1',
      metadata: {
        statusCheck: {
          kind: 'jsonrpc',
          endpoint: 'http://192.168.7.7:9/rpc',
          timeoutMs: 300,
        },
      },
      artifact: {
        kind: 'binary',
        entry: './remote-placeholder',
        launch: {
          command: server.endpoint,
          endpoint: server.endpoint,
          transport: 'http',
        },
      },
      runtime: 'remote',
      capabilities: [{ name: 'demo.secure' }],
    }, null, 2), 'utf8')

    manager = new ExtensionManager({ isDevelopment: true })
    manager.registerRuntime(new RemoteRuntime())
    await manager.loadManifestFile(tempDirectory)

    const status = await manager.checkStatus('demo.remote-probe-jsonrpc')
    assert.equal(status.state, 'unavailable')
    assert.match(status.reason, /Status probe host not allowed: 192\.168\.7\.7/)
  } finally {
    await manager?.dispose().catch(() => {})
    await server.close()
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

test('checkStatus honors statusProbeAllowedHosts for otherwise blocked hosts', async () => {
  const server = await startRpcServer()
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-probe-guard-allowlist-'))
  let manager: ExtensionManager | undefined

  try {
    await fs.writeFile(path.join(tempDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.remote-probe-allowlist',
      version: '1.0.0',
      protocolVersion: '1',
      metadata: {
        statusCheck: {
          kind: 'url',
          endpoint: 'http://probe-allowed.invalid/health',
          method: 'GET',
          timeoutMs: 300,
        },
      },
      artifact: {
        kind: 'binary',
        entry: './remote-placeholder',
        launch: {
          command: server.endpoint,
          endpoint: server.endpoint,
          transport: 'http',
        },
      },
      runtime: 'remote',
      capabilities: [{ name: 'demo.secure' }],
    }, null, 2), 'utf8')

    manager = new ExtensionManager({ isDevelopment: true, statusProbeAllowedHosts: ['probe-allowed.invalid'] })
    manager.registerRuntime(new RemoteRuntime())
    await manager.loadManifestFile(tempDirectory)

    const status = await manager.checkStatus('demo.remote-probe-allowlist')
    assert.equal(status.state, 'unavailable')
    assert.doesNotMatch(status.reason, /Status probe host not allowed/)
  } finally {
    await manager?.dispose().catch(() => {})
    await server.close()
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

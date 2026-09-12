# Session Transport Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce session behavior drift and harden the command kernel transport against malformed daemon stdout.

**Architecture:** Keep `ExtensionManager` and the bridge interfaces unchanged. Reuse the shared TypeScript session helper in the local bridge, and add a defensive decode path inside `CommandKernelBridge` so malformed daemon output becomes structured request failure instead of an uncaught exception.

**Tech Stack:** TypeScript ES modules, Node `node:test`, Node child process stdio, existing `ExtensionProcessError` error type.

---

### Task 1: Add Regression Tests

**Files:**
- Modify: `src/test/kernel-bridge.test.ts`

- [x] **Step 1: Add a compatibility close-state regression test**

Add this test after `openSession returns unary compatibility events through the local kernel bridge`:

```ts
test('local unary compatibility session rejects operations after close', async () => {
  const manager = new ExtensionManager()
  manager.registerRuntime(new NodeRuntime())

  await manager.loadManifestFile(path.join(root, 'examples/node-extension'))
  const session = await manager.openSession('demo.node-extension', 'demo.hello', {})
  await session.close()

  await assert.rejects(
    () => session.nextEvent(),
    /session is closed/i,
  )
  await assert.rejects(
    () => session.send({ text: 'ping' }),
    /session is closed/i,
  )

  await manager.dispose()
})
```

- [x] **Step 2: Add a malformed daemon output regression test**

Add this test near the existing command kernel bridge tests:

```ts
test('command kernel bridge rejects malformed daemon stdout as a transport error', async (t) => {
  await ensureSpawnAvailable(t)
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'extensions-manager-kernel-bad-stdout-'))
  const pluginsDirectory = path.join(tempDirectory, 'plugins')
  const pluginDirectory = path.join(pluginsDirectory, 'plugin-a')
  const kernelDaemonPath = path.join(tempDirectory, 'kernel-daemon.mjs')
  const hostConfigPath = path.join(tempDirectory, 'host.config.json')

  try {
    await fs.mkdir(pluginDirectory, { recursive: true })
    await fs.writeFile(path.join(pluginDirectory, 'extension.json'), JSON.stringify({
      id: 'demo.kernel-bad-stdout-plugin',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'module', entry: './index.js' },
      runtime: 'node',
      capabilities: [{ name: 'demo.hello' }],
    }, null, 2), 'utf8')
    await fs.writeFile(path.join(pluginDirectory, 'index.js'), "export default { capabilities: { 'demo.hello': async () => ({ message: 'unused' }) } }\n", 'utf8')
    await fs.writeFile(kernelDaemonPath, createMalformedKernelDaemonStubScript(), 'utf8')
    await fs.writeFile(hostConfigPath, JSON.stringify({
      pluginsDirectory: './plugins',
      pluginsRecursive: true,
      kernel: {
        mode: 'daemon',
        transport: 'pipe',
        command: process.execPath,
        args: ['./kernel-daemon.mjs'],
        cwd: '.',
        timeoutMs: 1000,
      },
    }, null, 2), 'utf8')

    await assert.rejects(
      () => createExtensionManagerFromHostConfig(hostConfigPath),
      /invalid kernel envelope/i,
    )
  } finally {
    await removeDirectoryWithRetry(tempDirectory)
  }
})
```

Add this helper before `removeDirectoryWithRetry`:

```ts
function createMalformedKernelDaemonStubScript(): string {
  return `
process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {
  process.stdout.write('this is not json\\n')
})
`
}
```

- [x] **Step 3: Run the focused test and verify RED**

Run:

```powershell
npm run build
$tmp = Join-Path $PWD ".tmp"; New-Item -ItemType Directory -Force -Path $tmp | Out-Null; $env:TMP = $tmp; $env:TEMP = $tmp; node --test --test-isolation=none dist/test/kernel-bridge.test.js
```

Expected:
- The local compatibility close-state test fails because `LocalKernelBridge` still returns events after `close()`.
- The malformed daemon stdout test fails or crashes because `CommandKernelBridge` directly parses stdout with `JSON.parse`.

Actual RED note:
- The first regression exposed the local compatibility close-state drift.
- The malformed stdout regression also exposed a test-stub bug when the stub emitted a literal `\\n` instead of a real newline; after fixing the stub, the test captured the intended transport failure.

### Task 2: Reuse Shared Compatibility Session in Local Bridge

**Files:**
- Modify: `src/kernel/LocalKernelBridge.ts`

- [x] **Step 1: Import the shared helper**

Change imports to remove `ExtensionSessionEvent` and add `createCompatibilitySession`:

```ts
import type { ExtensionSession } from '../contracts/ExtensionSession.js'
import { createCompatibilitySession } from '../runtimes/sessionRuntimeUtils.js'
```

- [x] **Step 2: Replace the local hand-written compatibility session**

Replace:

```ts
return createUnaryCompatibilitySession(extensionId, capability, output)
```

with:

```ts
return createCompatibilitySession(
  `${extensionId}:${capability}:local`,
  output,
  contract,
  'Local kernel session has no more events',
)
```

- [x] **Step 3: Remove the private `createUnaryCompatibilitySession` function**

Delete the entire `createUnaryCompatibilitySession` function at the bottom of `LocalKernelBridge.ts`.

### Task 3: Harden Command Kernel Transport Decode

**Files:**
- Modify: `src/kernel/CommandKernelBridge.ts`

- [x] **Step 1: Replace the direct `JSON.parse` line handler**

Replace:

```ts
this.reader.on('line', (line) => {
  this.handleEnvelope(JSON.parse(line) as KernelEnvelope)
})
```

with:

```ts
this.reader.on('line', (line) => {
  this.handleLine(line)
})
```

- [x] **Step 2: Add `handleLine` and envelope guards**

Add private methods inside `CommandKernelTransport`:

```ts
private handleLine(line: string): void {
  let envelope: unknown
  try {
    envelope = JSON.parse(line)
  } catch {
    this.failAll(new ExtensionProcessError('Invalid kernel envelope: malformed JSON from daemon stdout'))
    return
  }

  if (!isKernelEnvelope(envelope)) {
    this.failProtocol(new ExtensionProcessError('Invalid kernel envelope: unsupported daemon stdout payload'))
    return
  }

  this.handleEnvelope(envelope)
}
```

Add module-level guard functions:

```ts
function isKernelEnvelope(value: unknown): value is KernelEnvelope {
  if (!value || typeof value !== 'object' || !('kind' in value)) {
    return false
  }

  const kind = (value as { kind?: unknown }).kind
  return kind === 'response' || kind === 'event'
}
```

### Task 4: Verify and Record

**Files:**
- Modify: `SESSION_STATE.md`

- [x] **Step 1: Run focused verification**

Run:

```powershell
npm run build
$tmp = Join-Path $PWD ".tmp"; New-Item -ItemType Directory -Force -Path $tmp | Out-Null; $env:TMP = $tmp; $env:TEMP = $tmp; node --test --test-isolation=none dist/test/kernel-bridge.test.js
```

Expected: focused bridge tests pass.

Actual: `10` bridge tests passed, `0` failed.

- [x] **Step 2: Run full TypeScript test suite**

Run:

```powershell
$tmp = Join-Path $PWD ".tmp"; New-Item -ItemType Directory -Force -Path $tmp | Out-Null; $env:TMP = $tmp; $env:TEMP = $tmp; npm test
```

Expected: full TypeScript suite passes.

Actual: `78` TypeScript tests passed, `0` failed.

- [x] **Step 3: Update `SESSION_STATE.md`**

Update the state file with:

```md
- Local kernel compatibility sessions now reuse the shared TypeScript session helper.
- Command kernel transport now converts malformed daemon stdout into structured transport errors.
- Added bridge regression tests for compatibility close-state and malformed daemon stdout.
```

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ExtensionManifest } from '../contracts/ExtensionManifest.js'
import type { ResolvedArtifact } from '../core/ArtifactResolver.js'
import { assertWasmMemoryWithinQuota, parseWasmMemoryLimits } from '../security/wasmModuleLimits.js'
import { getOrCompileModule, WasmRuntime } from '../runtimes/wasm/WasmRuntime.js'

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]

function leb128(value: number): number[] {
  const bytes: number[] = []
  let current = value
  for (;;) {
    let byte = current & 0x7f
    current = Math.floor(current / 128)
    if (current !== 0) {
      byte |= 0x80
    }
    bytes.push(byte)
    if (current === 0) {
      return bytes
    }
  }
}

function memorySectionBytes(min: number, max?: number | null): Uint8Array {
  const flags = max == null ? 0x00 : 0x01
  const payload = [0x01, flags, ...leb128(min), ...(max == null ? [] : leb128(max))]
  return new Uint8Array([...WASM_HEADER, 0x05, ...leb128(payload.length), ...payload])
}

test('parses memory limits from module bytes', () => {
  assert.deepEqual(parseWasmMemoryLimits(memorySectionBytes(1, 256)), { minPages: 1, maxPages: 256 })
  assert.deepEqual(parseWasmMemoryLimits(memorySectionBytes(10)), { minPages: 10, maxPages: null })
  assert.equal(parseWasmMemoryLimits(new Uint8Array(WASM_HEADER)), null)
})

test('compiled-module cache shares identical bytes and separates distinct bytes', () => {
  const first = Buffer.from(memorySectionBytes(1, 64))
  const same = Buffer.from(memorySectionBytes(1, 64))
  const different = Buffer.from(memorySectionBytes(2, 64))

  const moduleA = getOrCompileModule(first)
  const moduleB = getOrCompileModule(same)
  const moduleC = getOrCompileModule(different)

  assert.equal(moduleA, moduleB, 'identical module bytes must share one compiled WebAssembly.Module')
  assert.notEqual(moduleA, moduleC, 'different module bytes must compile separately')
})

test('guard accepts memory within the 256-page quota and no-memory modules', () => {
  assert.doesNotThrow(() => assertWasmMemoryWithinQuota(memorySectionBytes(1, 256)))
  assert.doesNotThrow(() => assertWasmMemoryWithinQuota(memorySectionBytes(0, 128)))
  assert.doesNotThrow(() => assertWasmMemoryWithinQuota(new Uint8Array(WASM_HEADER)))
})

test('guard rejects unbounded and oversized memory declarations', () => {
  assert.throws(
    () => assertWasmMemoryWithinQuota(memorySectionBytes(1024)),
    /unbounded linear memory/,
  )
  assert.throws(
    () => assertWasmMemoryWithinQuota(memorySectionBytes(300, 300)),
    /exceeds the 256-page/,
  )
  assert.throws(
    () => assertWasmMemoryWithinQuota(memorySectionBytes(1, 257)),
    /exceeds the 256-page/,
  )
})

test('rejects malformed module bytes with a clear error', () => {
  assert.throws(() => parseWasmMemoryLimits(new Uint8Array([0, 1, 2, 3])), /truncated header/)
  assert.throws(
    () => parseWasmMemoryLimits(new Uint8Array([...WASM_HEADER, 0x05, 0x7f])),
    /truncated section/,
  )
})

test('shipped wasm template without memory still loads and invokes', async () => {
  const templateDirectory = path.resolve(import.meta.dirname ?? '.', '../../examples/wasm-extension-template')
  const runtime = new WasmRuntime()
  const basePath = templateDirectory
  const artifact: ResolvedArtifact = {
    entryPath: path.join(templateDirectory, 'plugin.wasm'),
    command: path.join(templateDirectory, 'plugin.wasm'),
    args: [],
    cwd: basePath,
    basePath,
  }
  const manifest: ExtensionManifest = {
    id: 'demo.wasm-guard-template',
    version: '1.0.0',
    protocolVersion: '1',
    artifact: { kind: 'wasm', entry: './plugin.wasm' },
    runtime: 'wasm',
    capabilities: [{ name: 'addOne' }],
  }

  const extension = await runtime.load(manifest, artifact)
  const result = await extension.invoke<unknown, number>('addOne', { value: 41 })
  assert.equal(result, 42)

  await extension.deactivate()
})

test('memory-capped module loads through the runtime with a capped imported memory', async () => {
  // A module that imports env memory (1 page max 256 from the host) and exports
  // nothing else; instantiation must succeed under the host cap.
  // Import section payload: count(1) + "env"(1+3) + "memory"(1+6) + kind(1)
  // + limits flags(1) + min(1) + max LEB128(2) = 17 bytes.
  const importMemoryModule = new Uint8Array([
    ...WASM_HEADER,
    0x02, 0x11, 0x01,
    0x03, 0x65, 0x6e, 0x76, // "env"
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, // "memory"
    0x02, 0x01, 0x01, 0x80, 0x02,
  ])

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-guard-'))
  const modulePath = path.join(tempDirectory, 'import-memory.wasm')
  await fs.writeFile(modulePath, importMemoryModule)

  try {
    assert.doesNotThrow(() => assertWasmMemoryWithinQuota(importMemoryModule))

    const runtime = new WasmRuntime()
    const manifest: ExtensionManifest = {
      id: 'demo.wasm-guard-import',
      version: '1.0.0',
      protocolVersion: '1',
      artifact: { kind: 'wasm', entry: './import-memory.wasm' },
      runtime: 'wasm',
      capabilities: [],
    }
    const artifact: ResolvedArtifact = {
      entryPath: modulePath,
      command: modulePath,
      args: [],
      cwd: tempDirectory,
      basePath: tempDirectory,
    }

    const extension = await runtime.load(manifest, artifact)
    await extension.deactivate()
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true })
  }
})

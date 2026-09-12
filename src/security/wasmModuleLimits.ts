/**
 * Binary wasm module memory-section parsing for the Node-side wasm runtime.
 *
 * The Rust kernel enforces a 16 MiB (256 pages) linear-memory quota on plugin
 * modules; the Node runtime gets the same guarantee by inspecting the module
 * bytes before instantiation, because the JS WebAssembly API cannot cap a
 * module's self-declared memory.
 *
 * Module layout: 8-byte magic+version header, then sections
 * `[id: u8][size: LEB128][payload]`. The memory section has id 5 and its
 * payload is `[count: u32][limits...]` with limits `[flags: u8][min: LEB128]`
 * plus `[max: LEB128]` when flags & 0x01.
 */

export const WASM_MEMORY_QUOTA_PAGES = 256

export interface WasmMemoryLimits {
  minPages: number
  maxPages: number | null
}

export function parseWasmMemoryLimits(bytes: Uint8Array): WasmMemoryLimits | null {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  if (bytes.length < header.length) {
    throw new Error('Invalid wasm module: truncated header')
  }
  for (let index = 0; index < header.length; index += 1) {
    if (bytes[index] !== header[index]) {
      throw new Error('Invalid wasm module: bad magic or version')
    }
  }

  let offset = header.length
  while (offset < bytes.length) {
    const sectionId = bytes[offset]
    offset += 1

    const [sectionSize, next] = readLeb128(bytes, offset)
    offset = next
    if (offset + sectionSize > bytes.length) {
      throw new Error('Invalid wasm module: truncated section')
    }

    if (sectionId === 5) {
      return parseMemorySection(bytes, offset, sectionSize)
    }

    offset += sectionSize
  }

  return null
}

export function assertWasmMemoryWithinQuota(
  bytes: Uint8Array,
  quotaPages: number = WASM_MEMORY_QUOTA_PAGES,
): void {
  const limits = parseWasmMemoryLimits(bytes)

  if (!limits) {
    return
  }

  if (limits.maxPages === null) {
    throw new Error(
      `WASM module declares unbounded linear memory; a maximum of at most ${quotaPages} pages (16 MiB) is required`,
    )
  }

  if (limits.minPages > quotaPages || limits.maxPages > quotaPages) {
    throw new Error(
      `WASM module memory exceeds the ${quotaPages}-page (16 MiB) quota: min ${limits.minPages}, max ${limits.maxPages}`,
    )
  }
}

function parseMemorySection(bytes: Uint8Array, start: number, size: number): WasmMemoryLimits | null {
  const end = start + size
  let offset = start

  const [count, afterCount] = readLeb128(bytes, offset)
  offset = afterCount

  if (count < 1) {
    // Zero memories is technically valid; treat as "no memory declared".
    return null
  }

  if (offset >= end) {
    throw new Error('Invalid wasm module: truncated memory section')
  }

  const flags = bytes[offset]
  offset += 1

  if (flags !== 0x00 && flags !== 0x01) {
    throw new Error(`Invalid wasm module: unsupported memory limits flags 0x${flags.toString(16)}`)
  }

  const [minPages, afterMin] = readLeb128(bytes, offset)
  offset = afterMin

  if (flags === 0x01) {
    const [maxPages, afterMax] = readLeb128(bytes, offset)
    offset = afterMax
    if (offset > end) {
      throw new Error('Invalid wasm module: truncated memory limits')
    }
    return { minPages, maxPages }
  }

  if (offset > end) {
    throw new Error('Invalid wasm module: truncated memory limits')
  }

  return { minPages, maxPages: null }
}

function readLeb128(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0
  let shift = 0
  let current = offset

  for (;;) {
    if (current >= bytes.length) {
      throw new Error('Invalid wasm module: truncated LEB128 value')
    }

    const byte = bytes[current]
    current += 1
    result += (byte & 0x7f) * Math.pow(2, shift)

    if ((byte & 0x80) === 0) {
      break
    }

    shift += 7
    if (shift > 35) {
      throw new Error('Invalid wasm module: LEB128 value too large')
    }
  }

  return [result, current]
}

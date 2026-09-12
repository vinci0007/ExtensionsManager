import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { ExtensionProcessError } from '../errors/ExtensionError.js'
import { JsonRpcTransport, SESSION_EVENT_QUOTA } from '../runtimes/process/JsonRpcTransport.js'

const EVENT_QUOTA_EXCEEDED_MESSAGE = 'EVENT_QUOTA_EXCEEDED: session event queue overflow'

interface FakeChildProcess {
  child: ChildProcess
  stdout: PassThrough
  stdin: PassThrough
  writes: string[]
}

function createFakeChild(): FakeChildProcess {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const writes: string[] = []
  stdin.on('data', (chunk: Buffer) => {
    writes.push(chunk.toString('utf8'))
  })

  const child = new EventEmitter() as unknown as ChildProcess
  Object.assign(child, {
    stdout,
    stdin,
    kill: () => true,
  })

  return { child, stdout, stdin, writes }
}

async function nextRequest(fake: FakeChildProcess): Promise<{ id: string; method: string }> {
  await once(fake.stdin, 'data')
  const lines = fake.writes.join('').split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

function quotaExceededError(error: unknown): boolean {
  return error instanceof ExtensionProcessError && error.message === EVENT_QUOTA_EXCEEDED_MESSAGE
}

test('session event quota constant matches the Rust kernel quota', () => {
  assert.equal(SESSION_EVENT_QUOTA, 4096)
})

test('fails session operations after a plugin floods beyond the session event quota', async () => {
  const fake = createFakeChild()
  const transport = new JsonRpcTransport(fake.child)

  // Register the request listener before the transport call: the fake stdin
  // emits synchronously on write, so a later once() would miss the event.
  const requestPromise = nextRequest(fake)
  // A request in flight while the flood arrives; its response is written after
  // the flooded frames, so once it resolves every frame has been processed.
  const sendPromise = transport.sessionSend('session-flood', { trigger: true })
  const request = await requestPromise

  const lines: string[] = []
  for (let index = 0; index <= SESSION_EVENT_QUOTA; index += 1) {
    lines.push(JSON.stringify({
      kind: 'event',
      sessionId: 'session-flood',
      event: { type: 'event', name: 'tick', payload: index },
    }))
  }
  lines.push(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }))
  fake.stdout.write(`${lines.join('\n')}\n`)

  const buffered = await sendPromise
  assert.deepEqual(buffered, [])

  await assert.rejects(() => transport.sessionSend('session-flood', {}), quotaExceededError)
  await assert.rejects(() => transport.sessionCancel('session-flood'), quotaExceededError)
  await assert.rejects(() => transport.sessionClose('session-flood'), quotaExceededError)

  fake.stdout.end()
  fake.stdin.end()
})

test('normal small sessions keep working under the quota', async () => {
  const fake = createFakeChild()
  const transport = new JsonRpcTransport(fake.child)

  const openRequestPromise = nextRequest(fake)
  const openPromise = transport.openSession('demo.chat', { prompt: 'hi' })
  const openRequest = await openRequestPromise
  fake.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: openRequest.id,
    result: { sessionId: 'session-small' },
  })}\n`)
  const opened = await openPromise
  assert.equal(opened.sessionId, 'session-small')
  assert.deepEqual(opened.events, [])

  const sendRequestPromise = nextRequest(fake)
  const sendPromise = transport.sessionSend('session-small', { text: 'ping' })
  const sendRequest = await sendRequestPromise
  const lines = [0, 1, 2].map((index) => JSON.stringify({
    kind: 'event',
    sessionId: 'session-small',
    event: { type: 'event', name: 'tick', payload: index },
  }))
  lines.push(JSON.stringify({ jsonrpc: '2.0', id: sendRequest.id, result: true }))
  fake.stdout.write(`${lines.join('\n')}\n`)

  const events = await sendPromise
  assert.deepEqual(events, [
    { type: 'event', name: 'tick', payload: 0 },
    { type: 'event', name: 'tick', payload: 1 },
    { type: 'event', name: 'tick', payload: 2 },
  ])

  const closeRequestPromise = nextRequest(fake)
  const closePromise = transport.sessionClose('session-small')
  const closeRequest = await closeRequestPromise
  fake.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: closeRequest.id, result: true })}\n`)
  await closePromise

  fake.stdout.end()
  fake.stdin.end()
})

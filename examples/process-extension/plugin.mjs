#!/usr/bin/env node
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })

rl.on('line', (line) => {
  const request = JSON.parse(line)

  if (request.method === 'extension/activate') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }) + '\n')
    return
  }

  if (request.method === 'extension/deactivate') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: true }) + '\n')
    process.exit(0)
    return
  }

  if (request.method === 'extension/invoke') {
    const capability = request.params?.capability

    if (capability === 'demo.hello') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { message: 'hello from process extension' } }) + '\n')
      return
    }

    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: `Unknown capability: ${capability}` }
    }) + '\n')
  }
})

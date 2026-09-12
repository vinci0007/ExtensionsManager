#!/usr/bin/env node
import fs from 'node:fs'
import readline from 'node:readline'

const libraryPath = process.argv[2]

if (!libraryPath) {
  throw new Error('shared-library path missing')
}

if (!fs.existsSync(libraryPath)) {
  throw new Error(`shared-library not found: ${libraryPath}`)
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })

rl.on('line', (line) => {
  const request = JSON.parse(line)

  if (request.method === 'extension/activate') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        activated: true,
        libraryPath,
      },
    }) + '\n')
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
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          message: 'hello from native bridge template',
          libraryPath,
        },
      }) + '\n')
      return
    }

    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: `Unknown capability: ${capability}` },
    }) + '\n')
  }
})

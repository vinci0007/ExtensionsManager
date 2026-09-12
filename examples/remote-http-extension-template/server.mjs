import http from 'node:http'

const port = Number(process.env.PORT ?? '47111')
let active = false

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

  const rpc = JSON.parse(body)
  response.setHeader('content-type', 'application/json')

  if (rpc.method === 'extension/load') {
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
    return
  }

  if (rpc.method === 'extension/status') {
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        state: 'available',
        reason: 'remote-http template endpoint is reachable',
      },
    }))
    return
  }

  if (rpc.method === 'extension/activate') {
    active = true
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
    return
  }

  if (rpc.method === 'extension/deactivate') {
    active = false
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))
    return
  }

  if (rpc.method === 'extension/invoke') {
    if (!active) {
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        error: { message: 'remote-http template endpoint is not active' },
      }))
      return
    }

    if (rpc.params?.capability === 'demo.hello') {
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          message: 'hello from remote http extension',
          endpoint: request.url,
        },
      }))
      return
    }
  }

  response.end(JSON.stringify({
    jsonrpc: '2.0',
    id: rpc.id,
    error: { message: `unsupported method: ${rpc.method}` },
  }))
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`remote-http template listening on http://127.0.0.1:${port}\n`)
})

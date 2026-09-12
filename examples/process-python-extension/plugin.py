#!/usr/bin/env python3
import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')

    if method == 'extension/activate':
        sys.stdout.write(json.dumps({ 'jsonrpc': '2.0', 'id': request['id'], 'result': True }) + '\n')
        sys.stdout.flush()
        continue

    if method == 'extension/deactivate':
        sys.stdout.write(json.dumps({ 'jsonrpc': '2.0', 'id': request['id'], 'result': True }) + '\n')
        sys.stdout.flush()
        break

    if method == 'extension/invoke':
        capability = request.get('params', {}).get('capability')
        if capability == 'demo.hello':
            sys.stdout.write(json.dumps({
                'jsonrpc': '2.0',
                'id': request['id'],
                'result': { 'message': 'hello from python process extension' },
            }) + '\n')
        else:
            sys.stdout.write(json.dumps({
                'jsonrpc': '2.0',
                'id': request['id'],
                'error': { 'code': -32601, 'message': f'Unknown capability: {capability}' },
            }) + '\n')
        sys.stdout.flush()

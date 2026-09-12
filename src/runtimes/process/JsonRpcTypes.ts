import type { ExtensionSessionEvent } from '../../contracts/ExtensionSession.js'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string
  method: string
  params?: unknown
}

export interface JsonRpcSuccessResponse<T = unknown> {
  jsonrpc: '2.0'
  id: string
  result: T
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: string
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export interface JsonRpcEventFrame {
  kind: 'event'
  sessionId: string
  event: ExtensionSessionEvent
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccessResponse<T> | JsonRpcErrorResponse
export type JsonRpcFrame<T = unknown> = JsonRpcResponse<T> | JsonRpcEventFrame

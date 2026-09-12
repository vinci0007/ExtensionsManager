export type ExtensionSessionEvent =
  | { type: 'data'; data: unknown }
  | { type: 'end' }
  | { type: 'error'; message: string }
  | { type: 'event'; name: string; payload?: unknown }
  | { type: 'resourceGrant'; resource: string; payload?: unknown }
  | { type: 'resourceRelease'; resource: string; payload?: unknown }

export interface ExtensionSession {
  id: string
  send(data: unknown): Promise<void>
  nextEvent(): Promise<ExtensionSessionEvent>
  cancel(): Promise<void>
  close(): Promise<void>
}

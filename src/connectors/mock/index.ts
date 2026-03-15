/**
 * Mock connector for testing.
 *
 * Implements the full Connector interface with configurable capabilities.
 * Captures all send/sendStream calls for test assertions while maintaining
 * correct behavioral semantics (drains streams, returns delivered: true).
 *
 * Usage:
 *   const conn = new MockConnector({ channel: 'test' })
 *   centerOrPlugin.register(conn)
 *   // ... exercise code ...
 *   expect(conn.calls).toHaveLength(1)
 *   expect(conn.calls[0].payload.text).toBe('hello')
 */

import type { Connector, ConnectorCapabilities, SendPayload, SendResult } from './types.js'
import type { StreamableResult } from '../core/ai-provider-manager.js'

export interface MockConnectorCall {
  method: 'send' | 'sendStream'
  payload?: SendPayload
  stream?: StreamableResult
  meta?: Pick<SendPayload, 'kind' | 'source'>
}

export interface MockConnectorOpts {
  channel?: string
  to?: string
  push?: boolean
  media?: boolean
  /** Set to false to remove sendStream, forcing ConnectorCenter to fall back to send. */
  sendStream?: boolean
}

export class MockConnector implements Connector {
  readonly channel: string
  readonly to: string
  readonly capabilities: ConnectorCapabilities
  readonly calls: MockConnectorCall[] = []

  constructor(opts?: MockConnectorOpts) {
    this.channel = opts?.channel ?? 'mock'
    this.to = opts?.to ?? 'default'
    this.capabilities = {
      push: opts?.push ?? true,
      media: opts?.media ?? false,
    }
    if (opts?.sendStream === false) {
      // Shadow prototype method with undefined so ConnectorCenter falls back to send
      ;(this as any).sendStream = undefined
    }
  }

  async send(payload: SendPayload): Promise<SendResult> {
    this.calls.push({ method: 'send', payload })
    return { delivered: true }
  }

  async sendStream(stream: StreamableResult, meta?: Pick<SendPayload, 'kind' | 'source'>): Promise<SendResult> {
    // Drain the stream to prevent hanging generators
    for await (const _e of stream) { /* drain */ }
    this.calls.push({ method: 'sendStream', stream, meta })
    return { delivered: true }
  }
}

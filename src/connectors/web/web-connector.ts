/**
 * Web UI outbound connector.
 *
 * Delivers messages and streaming AI responses to connected web clients via
 * Server-Sent Events (SSE). Persists media attachments to the content-addressable
 * media store and records all outbound messages in the session JSONL for history.
 *
 * Supports both send() for completed messages and sendStream() for real-time
 * streaming of ProviderEvents (tool_use, tool_result, text) to the browser.
 */

import type { Connector, ConnectorCapabilities, SendPayload, SendResult } from '../types.js'
import type { StreamableResult } from '../../core/ai-provider-manager.js'
import type { SSEClient } from './routes/chat.js'
import { SessionStore, type ContentBlock } from '../../core/session.js'
import { persistMedia } from '../../core/media-store.js'

export class WebConnector implements Connector {
  readonly channel = 'web'
  readonly to = 'default'
  readonly capabilities: ConnectorCapabilities = { push: true, media: true }

  constructor(
    private readonly sseByChannel: Map<string, Map<string, SSEClient>>,
    private readonly session: SessionStore,
  ) {}

  async send(payload: SendPayload): Promise<SendResult> {
    // Persist media to data/media/ with 3-word names
    const media: Array<{ type: 'image'; url: string }> = []
    for (const m of payload.media ?? []) {
      const name = await persistMedia(m.path)
      media.push({ type: 'image', url: `/api/media/${name}` })
    }

    const data = JSON.stringify({
      type: 'message',
      kind: payload.kind,
      text: payload.text,
      media: media.length > 0 ? media : undefined,
      source: payload.source,
    })

    // Only broadcast to default channel SSE clients (heartbeat/cron stay in main channel)
    const defaultClients = this.sseByChannel.get('default') ?? new Map()
    for (const client of defaultClients.values()) {
      try { client.send(data) } catch { /* client disconnected */ }
    }

    // Persist to session so history survives page refresh (text + image blocks)
    const blocks: ContentBlock[] = [
      { type: 'text', text: payload.text },
      ...media.map((m) => ({ type: 'image' as const, url: m.url })),
    ]
    await this.session.appendAssistant(blocks, 'notification', {
      kind: payload.kind,
      source: payload.source,
    })

    return { delivered: defaultClients.size > 0 }
  }

  async sendStream(
    stream: StreamableResult,
    meta?: Pick<SendPayload, 'kind' | 'source'>,
  ): Promise<SendResult> {
    const defaultClients = this.sseByChannel.get('default') ?? new Map()

    // Push streaming events to SSE clients as they arrive
    for await (const event of stream) {
      if (event.type === 'done') continue
      const data = JSON.stringify({ type: 'stream', event })
      for (const client of defaultClients.values()) {
        try { client.send(data) } catch { /* disconnected */ }
      }
    }

    // Get completed result (resolves immediately — drain already finished)
    const result = await stream

    // Persist media
    const media: Array<{ type: 'image'; url: string }> = []
    for (const m of result.media) {
      const name = await persistMedia(m.path)
      media.push({ type: 'image', url: `/api/media/${name}` })
    }

    // Push final message to SSE (same format as send())
    const data = JSON.stringify({
      type: 'message',
      kind: meta?.kind ?? 'notification',
      text: result.text,
      media: media.length > 0 ? media : undefined,
      source: meta?.source,
    })
    for (const client of defaultClients.values()) {
      try { client.send(data) } catch { /* disconnected */ }
    }

    // Persist to session (push notifications appear in web chat history)
    const blocks: ContentBlock[] = [
      { type: 'text', text: result.text },
      ...media.map((m) => ({ type: 'image' as const, url: m.url })),
    ]
    await this.session.appendAssistant(blocks, 'notification', {
      kind: meta?.kind ?? 'notification',
      source: meta?.source,
    })

    return { delivered: defaultClients.size > 0 }
  }
}

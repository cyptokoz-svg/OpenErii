import type { MediaAttachment } from '../core/types.js'
import type { StreamableResult } from '../core/ai-provider-manager.js'

// ==================== Send Types ====================

/** Structured payload for outbound send (heartbeat, cron, manual, etc.). */
export interface SendPayload {
  /** Whether this is a chat message or a notification. */
  kind: 'message' | 'notification'
  /** The text content to send. */
  text: string
  /** Media attachments (e.g. screenshots from tools). */
  media?: MediaAttachment[]
  /** Where this payload originated from. */
  source?: 'heartbeat' | 'cron' | 'manual'
}

/** Result of a send() call. */
export interface SendResult {
  /** Whether the message was actually sent (false for pull-based connectors). */
  delivered: boolean
}

// ==================== Connector Interface ====================

/** Discoverable capabilities a connector may support. */
export interface ConnectorCapabilities {
  /** Can push messages proactively (heartbeat/cron). False for pull-based. */
  push: boolean
  /** Can send media attachments (images). */
  media: boolean
}

/**
 * A connector that can send outbound messages to a user.
 *
 * Each plugin (Telegram, Web, MCP-ask) implements this interface and
 * registers itself with the ConnectorCenter.
 */
export interface Connector {
  /** Channel identifier, e.g. "telegram", "web", "mcp-ask". */
  readonly channel: string
  /** Recipient identifier (chat id, "default", session id, etc.). */
  readonly to: string
  /** What this connector can do. */
  readonly capabilities: ConnectorCapabilities
  /** Send a structured payload through this connector. */
  send(payload: SendPayload): Promise<SendResult>
  /**
   * Optional: stream AI response events to the client in real-time.
   * Connectors that support this can push ProviderEvents (tool_use, tool_result, text)
   * as they arrive, then deliver the final result at the end.
   *
   * If not implemented, ConnectorCenter falls back to draining the stream
   * and calling send() with the completed result.
   */
  sendStream?(stream: StreamableResult, meta?: Pick<SendPayload, 'kind' | 'source'>): Promise<SendResult>
}

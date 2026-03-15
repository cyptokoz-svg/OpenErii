import type { ISessionStore, SessionEntry } from '../core/session.js'
import type { CompactionConfig, CompactionResult } from '../core/compaction.js'
import type { MediaAttachment } from '../core/types.js'

// ==================== Provider Events ====================

/** Streaming event emitted by AI providers during generation. */
export type ProviderEvent =
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'text'; text: string }
  | { type: 'done'; result: ProviderResult }

// ==================== Types ====================

export interface ProviderResult {
  text: string
  media: MediaAttachment[]
  mediaUrls?: string[]
}

// ==================== GenerateOpts ====================

/** Per-request options passed through to the underlying provider. */
export interface GenerateOpts {
  /** System prompt override for this call. */
  systemPrompt?: string
  /** Preamble text for chat history (text providers only). */
  historyPreamble?: string
  /** Max history entries to include (text providers only). */
  maxHistoryEntries?: number
  disabledTools?: string[]
  vercelAiSdk?: { provider: string; model: string; baseUrl?: string; apiKey?: string }
  agentSdk?: { model?: string; apiKey?: string; baseUrl?: string }
}

// ==================== AIProvider ====================

/**
 * Slim provider interface — pure data-source adapter.
 *
 * Receives raw session entries + current prompt. Each provider decides
 * how to serialize history for its backend (text string, structured messages, etc.).
 */
export interface AIProvider {
  /** Session log provenance tag. */
  readonly providerTag: 'vercel-ai' | 'claude-code' | 'agent-sdk'
  /** Stateless one-shot prompt (used for compaction summarization, etc.). */
  ask(prompt: string): Promise<ProviderResult>
  /** Stream events from the backend. Yields tool_use/tool_result/text, then done. */
  generate(entries: SessionEntry[], prompt: string, opts?: GenerateOpts): AsyncIterable<ProviderEvent>
  /**
   * Optional: custom compaction strategy. If implemented, AgentCenter delegates
   * compaction to the provider instead of using the default compactIfNeeded.
   */
  compact?(session: ISessionStore, config: CompactionConfig): Promise<CompactionResult>
}

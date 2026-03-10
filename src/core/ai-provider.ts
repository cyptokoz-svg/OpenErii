/**
 * AIProvider — unified abstraction over AI backends.
 *
 * Each provider (Vercel AI SDK, Claude Code CLI, …) implements this interface
 * with its own session management flow.  ProviderRouter reads the runtime
 * config and delegates to the correct implementation.
 */

import type { SessionStore } from './session.js'
import type { MediaAttachment } from './types.js'
import { readAIProviderConfig } from './config.js'

// ==================== Types ====================

export interface AskOptions {
  /**
   * Preamble text describing the conversation context.
   * Claude Code: injected inside the `<chat_history>` text block.
   * Vercel AI SDK: not used (native ModelMessage[] carries the history directly).
   */
  historyPreamble?: string
  /**
   * System prompt override for this call.
   * Claude Code: passed as `--system-prompt` to the CLI.
   * Vercel AI SDK: replaces the agent's `instructions` for this call (triggers agent re-creation if changed).
   */
  systemPrompt?: string
  /**
   * Max text history entries to include in context.
   * Claude Code: limits entries in the `<chat_history>` block. Default: 50.
   * Vercel AI SDK: not used (compaction via `compactIfNeeded` controls context size).
   */
  maxHistoryEntries?: number
}

export interface ProviderResult {
  text: string
  media: MediaAttachment[]
}

/** Unified AI provider — each backend implements its own session handling. */
export interface AIProvider {
  /** Stateless prompt — no session context. */
  ask(prompt: string): Promise<ProviderResult>
  /** Prompt with session history and compaction. */
  askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): Promise<ProviderResult>
}

// ==================== Router ====================

/** Reads runtime AI config and delegates to the correct provider. */
export class ProviderRouter implements AIProvider {
  constructor(
    private vercel: AIProvider,
    private claudeCode: AIProvider | null,
  ) {}

  async ask(prompt: string): Promise<ProviderResult> {
    const config = await readAIProviderConfig()
    if (config.backend === 'claude-code' && this.claudeCode) {
      return this.claudeCode.ask(prompt)
    }
    return this.vercel.ask(prompt)
  }

  async askWithSession(prompt: string, session: SessionStore, opts?: AskOptions): Promise<ProviderResult> {
    const config = await readAIProviderConfig()
    if (config.backend === 'claude-code' && this.claudeCode) {
      return this.claudeCode.askWithSession(prompt, session, opts)
    }
    return this.vercel.askWithSession(prompt, session, opts)
  }
}

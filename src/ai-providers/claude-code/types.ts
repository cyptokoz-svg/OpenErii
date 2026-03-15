import type { ContentBlock } from '../../core/session.js'

export interface ClaudeCodeConfig {
  /** Tools pre-approved for use in non-interactive (-p) mode. */
  allowedTools?: string[]
  /** Tools removed from the model's context entirely (not just denied). */
  disallowedTools?: string[]
  /** When true, grants Bash access and broader permissions. */
  evolutionMode?: boolean
  /** Max agentic turns before Claude Code exits. Default: 20 */
  maxTurns?: number
  /** Working directory for Claude Code. Default: process.cwd() */
  cwd?: string
  /** Custom system prompt (replaces Claude Code default). */
  systemPrompt?: string
  /** Append to Claude Code's default system prompt. */
  appendSystemPrompt?: string
  /** Model override (e.g. 'claude-haiku-4-5'). Maps to --model flag. */
  model?: string
  /** AbortSignal to cancel the running process. */
  abortSignal?: AbortSignal
  /**
   * Called for each tool_use block in the JSONL stream.
   * Use this to stream tool call events to consumers.
   */
  onToolUse?: (toolUse: { id: string; name: string; input: unknown }) => void
  /**
   * Called for each tool_result block in the JSONL stream.
   * Use this to extract side-channel data (e.g. images) from tool results.
   */
  onToolResult?: (toolResult: { toolUseId: string; content: string }) => void
  /**
   * Called for each intermediate text block in the JSONL stream.
   * Use this to stream thinking/reasoning text to consumers during tool loops.
   */
  onText?: (text: string) => void
}

export interface ClaudeCodeMessage {
  role: 'assistant' | 'user'
  content: ContentBlock[]
}

export interface ClaudeCodeResult {
  /** The text response from Claude Code. */
  text: string
  /** Whether the run was successful. */
  ok: boolean
  /** All intermediate messages (assistant tool_use + user tool_result) from the stream. */
  messages: ClaudeCodeMessage[]
}

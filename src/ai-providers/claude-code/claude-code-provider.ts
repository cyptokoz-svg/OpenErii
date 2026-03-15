/**
 * ClaudeCodeProvider — GenerateProvider backed by the Claude Code CLI.
 *
 * Slim data-source adapter: only calls the CLI and yields ProviderEvents.
 * Session management (append, compact, persist) lives in AgentCenter.
 *
 * Agent config (evolutionMode, allowedTools, disallowedTools) is re-read from
 * disk on every request so that Web UI changes take effect without restart.
 */

import { resolve } from 'node:path'
import type { ProviderResult, ProviderEvent, AIProvider, GenerateOpts } from '../types.js'
import type { SessionEntry } from '../../core/session.js'
import type { ClaudeCodeConfig } from './types.js'
import { toTextHistory } from '../../core/session.js'
import { buildChatHistoryPrompt, DEFAULT_MAX_HISTORY } from '../utils.js'
import { readAgentConfig } from '../../core/config.js'
import { createChannel } from '../../core/async-channel.js'
import { askClaudeCode } from './provider.js'

export class ClaudeCodeProvider implements AIProvider {
  readonly providerTag = 'claude-code' as const

  constructor(
    private systemPrompt?: string,
  ) {}

  /** Re-read agent config from disk to pick up hot-reloaded settings. */
  private async resolveConfig(): Promise<ClaudeCodeConfig> {
    const agent = await readAgentConfig()
    return {
      ...agent.claudeCode,
      evolutionMode: agent.evolutionMode,
      cwd: agent.evolutionMode ? process.cwd() : resolve('data/brain'),
    }
  }

  async ask(prompt: string): Promise<ProviderResult> {
    const config = await this.resolveConfig()
    const result = await askClaudeCode(prompt, config)
    return { text: result.text, media: [] }
  }

  async *generate(entries: SessionEntry[], prompt: string, opts?: GenerateOpts): AsyncGenerator<ProviderEvent> {
    const maxHistory = opts?.maxHistoryEntries ?? DEFAULT_MAX_HISTORY
    const textHistory = toTextHistory(entries).slice(-maxHistory)
    const fullPrompt = buildChatHistoryPrompt(prompt, textHistory, opts?.historyPreamble)

    const config = await this.resolveConfig()
    const claudeCode: ClaudeCodeConfig = {
      ...config,
      ...(opts?.disabledTools?.length
        ? { disallowedTools: [...(config.disallowedTools ?? []), ...opts.disabledTools] }
        : {}),
      systemPrompt: opts?.systemPrompt ?? this.systemPrompt,
    }

    const channel = createChannel<ProviderEvent>()

    const resultPromise = askClaudeCode(fullPrompt, {
      ...claudeCode,
      onToolUse: ({ id, name, input: toolInput }) => {
        channel.push({ type: 'tool_use', id, name, input: toolInput })
      },
      onToolResult: ({ toolUseId, content }) => {
        channel.push({ type: 'tool_result', tool_use_id: toolUseId, content })
      },
      onText: (text) => {
        channel.push({ type: 'text', text })
      },
    })

    resultPromise.then(() => channel.close()).catch((err) => channel.error(err instanceof Error ? err : new Error(String(err))))
    yield* channel

    const result = await resultPromise
    const prefix = result.ok ? '' : '[error] '
    yield { type: 'done', result: { text: prefix + result.text, media: [] } }
  }

}

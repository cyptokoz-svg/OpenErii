/**
 * AgentSdkProvider — GenerateProvider backed by @anthropic-ai/claude-agent-sdk.
 *
 * Slim data-source adapter: only calls the Agent SDK and yields ProviderEvents.
 * Session management (append, compact, persist) lives in AgentCenter.
 *
 * Reuses agent.json's `claudeCode` config block (allowedTools, disallowedTools, maxTurns)
 * since both providers are backed by the same Claude Code CLI.
 */

import { resolve } from 'node:path'
import type { Tool } from 'ai'
import type { ProviderResult, ProviderEvent, AIProvider, GenerateOpts } from '../types.js'
import type { SessionEntry } from '../../core/session.js'
import type { AgentSdkConfig, AgentSdkOverride } from './query.js'
import { toTextHistory } from '../../core/session.js'
import { buildChatHistoryPrompt, DEFAULT_MAX_HISTORY } from '../utils.js'
import { readAgentConfig } from '../../core/config.js'
import { createChannel } from '../../core/async-channel.js'
import { askAgentSdk } from './query.js'
import { buildAgentSdkMcpServer } from './tool-bridge.js'

export class AgentSdkProvider implements AIProvider {
  readonly providerTag = 'agent-sdk' as const

  constructor(
    private getTools: () => Promise<Record<string, Tool>>,
    private systemPrompt?: string,
  ) {}

  /** Re-read agent config from disk to pick up hot-reloaded settings. */
  private async resolveConfig(): Promise<AgentSdkConfig> {
    const agent = await readAgentConfig()
    return {
      ...agent.claudeCode,
      evolutionMode: agent.evolutionMode,
      cwd: agent.evolutionMode ? process.cwd() : resolve('data/brain'),
    }
  }

  /** Build an in-process MCP server from ToolCenter, filtering disabled tools. */
  private async buildMcpServer(disabledTools?: string[]) {
    const tools = await this.getTools()
    return buildAgentSdkMcpServer(tools, disabledTools)
  }

  async ask(prompt: string): Promise<ProviderResult> {
    const config = await this.resolveConfig()
    const mcpServer = await this.buildMcpServer()
    const result = await askAgentSdk(prompt, config, undefined, mcpServer)
    return { text: result.text, media: [] }
  }

  async *generate(entries: SessionEntry[], prompt: string, opts?: GenerateOpts): AsyncGenerator<ProviderEvent> {
    const maxHistory = opts?.maxHistoryEntries ?? DEFAULT_MAX_HISTORY
    const textHistory = toTextHistory(entries).slice(-maxHistory)
    const fullPrompt = buildChatHistoryPrompt(prompt, textHistory, opts?.historyPreamble)

    const config = await this.resolveConfig()
    const agentSdkConfig: AgentSdkConfig = {
      ...config,
      ...(opts?.disabledTools?.length
        ? { disallowedTools: [...(config.disallowedTools ?? []), ...opts.disabledTools] }
        : {}),
      systemPrompt: opts?.systemPrompt ?? this.systemPrompt,
    }

    const override: AgentSdkOverride | undefined = opts?.agentSdk
    const mcpServer = await this.buildMcpServer(opts?.disabledTools)

    const channel = createChannel<ProviderEvent>()

    const resultPromise = askAgentSdk(
      fullPrompt,
      {
        ...agentSdkConfig,
        onToolUse: ({ id, name, input: toolInput }) => {
          channel.push({ type: 'tool_use', id, name, input: toolInput })
        },
        onToolResult: ({ toolUseId, content }) => {
          channel.push({ type: 'tool_result', tool_use_id: toolUseId, content })
        },
        onText: (text) => {
          channel.push({ type: 'text', text })
        },
      },
      override,
      mcpServer,
    )

    resultPromise.then(() => channel.close()).catch((err) => channel.error(err instanceof Error ? err : new Error(String(err))))
    yield* channel

    const result = await resultPromise
    const prefix = result.ok ? '' : '[error] '
    yield { type: 'done', result: { text: prefix + result.text, media: [] } }
  }

}

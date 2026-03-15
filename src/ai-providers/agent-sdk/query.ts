/**
 * Agent SDK query wrapper — encapsulates `query()` with env injection and result collection.
 *
 * API key comes from `readAIProviderConfig().apiKeys.anthropic`, injected via
 * `env: { ANTHROPIC_API_KEY }`. Per-channel overrides take precedence.
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { pino } from 'pino'
import type { ContentBlock } from '../../core/session.js'
import { readAIProviderConfig } from '../../core/config.js'
import { logToolCall } from '../utils.js'

const logger = pino({
  transport: { target: 'pino/file', options: { destination: 'logs/agent-sdk.log', mkdir: true } },
})

// ==================== Types ====================

export interface AgentSdkConfig {
  allowedTools?: string[]
  disallowedTools?: string[]
  evolutionMode?: boolean
  maxTurns?: number
  cwd?: string
  systemPrompt?: string
  appendSystemPrompt?: string
  /** Called for each tool_use block in the stream. */
  onToolUse?: (toolUse: { id: string; name: string; input: unknown }) => void
  /** Called for each tool_result in the stream. */
  onToolResult?: (toolResult: { toolUseId: string; content: string }) => void
  /** Called for each intermediate text block in the stream. */
  onText?: (text: string) => void
}

export interface AgentSdkOverride {
  model?: string
  apiKey?: string
  baseUrl?: string
}

export interface AgentSdkMessage {
  role: 'assistant' | 'user'
  content: ContentBlock[]
}

export interface AgentSdkResult {
  text: string
  ok: boolean
  messages: AgentSdkMessage[]
}

// ==================== Tool lists ====================

const NORMAL_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'mcp__open-alice__*',
]

const EVOLUTION_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'mcp__open-alice__*',
]

const NORMAL_EXTRA_DISALLOWED = ['Bash']
const EVOLUTION_EXTRA_DISALLOWED: string[] = []

// ==================== Strip image data ====================

function stripImageData(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return raw
    let changed = false
    const cleaned = parsed.map((item: Record<string, unknown>) => {
      if (item.type === 'image' && (item.source as Record<string, unknown>)?.data) {
        changed = true
        return { type: 'text', text: '[Image saved to disk — use Read tool to view the file]' }
      }
      return item
    })
    return changed ? JSON.stringify(cleaned) : raw
  } catch { return raw }
}

// ==================== Public ====================

/**
 * Call Agent SDK `query()` and collect the result.
 *
 * Each invocation is independent (persistSession: false). The caller manages
 * session persistence via SessionStore, matching the Claude Code CLI provider pattern.
 */
export async function askAgentSdk(
  prompt: string,
  config: AgentSdkConfig = {},
  override?: AgentSdkOverride,
  mcpServer?: McpSdkServerConfigWithInstance,
): Promise<AgentSdkResult> {
  const {
    allowedTools = [],
    disallowedTools = [],
    evolutionMode = false,
    maxTurns = 20,
    cwd = process.cwd(),
    systemPrompt,
    onToolUse,
    onToolResult,
    onText,
  } = config

  // Merge: explicit config overrides mode defaults
  const modeAllowed = evolutionMode ? EVOLUTION_ALLOWED_TOOLS : NORMAL_ALLOWED_TOOLS
  const modeDisallowed = evolutionMode ? EVOLUTION_EXTRA_DISALLOWED : NORMAL_EXTRA_DISALLOWED
  const finalAllowed = allowedTools.length > 0 ? allowedTools : modeAllowed
  const finalDisallowed = [...disallowedTools, ...modeDisallowed]

  // Build env with API key injection
  const aiConfig = await readAIProviderConfig()
  const apiKey = override?.apiKey ?? aiConfig.apiKeys.anthropic
  const baseUrl = override?.baseUrl ?? aiConfig.baseUrl
  const env: Record<string, string | undefined> = { ...process.env }
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl

  // MCP servers
  const mcpServers: Record<string, any> = {}
  if (mcpServer) {
    mcpServers['open-alice'] = mcpServer
  }

  const messages: AgentSdkMessage[] = []
  let resultText = ''
  let ok = true

  try {
    for await (const event of sdkQuery({
      prompt,
      options: {
        cwd,
        env,
        model: override?.model ?? aiConfig.model,
        maxTurns,
        allowedTools: finalAllowed,
        disallowedTools: finalDisallowed,
        mcpServers,
        systemPrompt,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: false,
      },
    })) {
      // assistant message — extract tool_use + text blocks
      if (event.type === 'assistant' && 'message' in event) {
        const msg = (event as any).message
        if (msg?.content) {
          const blocks: ContentBlock[] = []
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              logToolCall(block.name, block.input)
              logger.info({ tool: block.name, input: block.input }, 'tool_use')
              blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
              onToolUse?.({ id: block.id, name: block.name, input: block.input })
            } else if (block.type === 'text') {
              blocks.push({ type: 'text', text: block.text })
              onText?.(block.text)
            }
          }
          if (blocks.length > 0) {
            messages.push({ role: 'assistant', content: blocks })
          }
        }
      }

      // user message — extract tool_result blocks
      else if (event.type === 'user' && 'message' in event) {
        const msg = (event as any).message
        const content = msg?.content
        if (Array.isArray(content)) {
          const blocks: ContentBlock[] = []
          for (const block of content) {
            if (block.type === 'tool_result') {
              const raw = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content ?? '')
              const sessionContent = stripImageData(raw)
              logger.info({ toolUseId: block.tool_use_id, content: sessionContent.slice(0, 500) }, 'tool_result')
              blocks.push({ type: 'tool_result', tool_use_id: block.tool_use_id, content: sessionContent })
              onToolResult?.({ toolUseId: block.tool_use_id, content: raw })
            }
          }
          if (blocks.length > 0) {
            messages.push({ role: 'user', content: blocks })
          }
        }
      }

      // result — final text
      else if (event.type === 'result') {
        const result = event as any
        if (result.subtype === 'success') {
          resultText = result.result ?? ''
        } else {
          ok = false
          resultText = result.errors?.join('\n') ?? `Agent SDK error: ${result.subtype}`
        }
        logger.info({ subtype: result.subtype, turns: result.num_turns, durationMs: result.duration_ms }, 'result')
      }
    }
  } catch (err) {
    logger.error({ error: String(err) }, 'query_error')
    ok = false
    resultText = `Agent SDK error: ${err}`
  }

  // Fallback: if result is empty, extract last assistant text
  if (!resultText && ok) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        resultText = messages[i].content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text)
          .join('\n')
        if (resultText) break
      }
    }
  }

  return {
    text: resultText || '(no output)',
    ok,
    messages,
  }
}

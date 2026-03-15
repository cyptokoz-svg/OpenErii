/**
 * Shared utilities used across AI providers and AgentCenter.
 */

// ==================== Strip Image Data ====================

/** Strip base64 image data from tool_result content before persisting to session. */
export function stripImageData(raw: string): string {
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

// ==================== Tool Permission Lists ====================

/** Tools pre-approved in normal mode (no Bash). */
export const NORMAL_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'mcp__open-alice__*',
]

/** Tools pre-approved in evolution mode (includes Bash). */
export const EVOLUTION_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'mcp__open-alice__*',
]

/** Extra tools to disallow in normal mode. */
export const NORMAL_EXTRA_DISALLOWED = ['Bash']

/** Extra tools to disallow in evolution mode. */
export const EVOLUTION_EXTRA_DISALLOWED: string[] = []

/** Resolve tool permissions based on evolution mode and explicit overrides. */
export function resolveToolPermissions(opts: {
  evolutionMode?: boolean
  allowedTools?: string[]
  disallowedTools?: string[]
}): { allowed: string[]; disallowed: string[] } {
  const { evolutionMode = false, allowedTools = [], disallowedTools = [] } = opts
  const modeAllowed = evolutionMode ? EVOLUTION_ALLOWED_TOOLS : NORMAL_ALLOWED_TOOLS
  const modeDisallowed = evolutionMode ? EVOLUTION_EXTRA_DISALLOWED : NORMAL_EXTRA_DISALLOWED
  return {
    allowed: allowedTools.length > 0 ? allowedTools : modeAllowed,
    disallowed: [...disallowedTools, ...modeDisallowed],
  }
}

// ==================== Chat History Prompt ====================

export interface TextHistoryEntry {
  role: 'user' | 'assistant'
  text: string
}

const DEFAULT_PREAMBLE =
  'The following is the recent conversation history. Use it as context if it references earlier events or decisions.'

/**
 * Build a full prompt with `<chat_history>` block prepended.
 * Used by text-based providers (Claude Code CLI, Agent SDK) that receive
 * a single string prompt rather than structured ModelMessage[].
 */
export function buildChatHistoryPrompt(
  prompt: string,
  textHistory: TextHistoryEntry[],
  preamble?: string,
): string {
  if (textHistory.length === 0) return prompt

  const lines = textHistory.map((entry) => {
    const tag = entry.role === 'user' ? 'User' : 'Bot'
    return `[${tag}] ${entry.text}`
  })
  return [
    '<chat_history>',
    preamble ?? DEFAULT_PREAMBLE,
    '',
    ...lines,
    '</chat_history>',
    '',
    prompt,
  ].join('\n')
}

/** Default max history entries for text-based providers. */
export const DEFAULT_MAX_HISTORY = 50

// ==================== Tool Call Logging ====================

/** Log a tool call with a short input preview. */
export function logToolCall(name: string, input: unknown) {
  const preview = JSON.stringify(input).slice(0, 120)
  console.log(`  ↳ ${name}(${preview})`)
}

import { describe, it, expect, vi } from 'vitest'
import {
  estimateTokens,
  estimateEntryTokens,
  estimateSessionTokens,
  getEffectiveWindow,
  getAutoCompactThreshold,
  getActiveEntries,
  microcompact,
  buildSummarizationPrompt,
  createCompactBoundary,
  createSummaryEntry,
  compactIfNeeded,
  forceCompact,
  DEFAULT_COMPACTION_CONFIG,
  type CompactionConfig,
} from './compaction.js'
import { MemorySessionStore } from './session.js'
import type { SessionEntry, ContentBlock } from './session.js'

// ==================== Helpers ====================

function makeEntry(overrides: Partial<SessionEntry> & Pick<SessionEntry, 'type' | 'message'>): SessionEntry {
  return {
    uuid: 'u1',
    parentUuid: null,
    sessionId: 's1',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function userText(content: string): SessionEntry {
  return makeEntry({ type: 'user', message: { role: 'user', content } })
}

function assistantText(content: string): SessionEntry {
  return makeEntry({ type: 'assistant', message: { role: 'assistant', content } })
}

function toolResultEntry(content: string, toolUseId = 't1'): SessionEntry {
  return makeEntry({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  })
}

function compactBoundary(): SessionEntry {
  return makeEntry({
    type: 'system',
    subtype: 'compact_boundary',
    message: { role: 'system', content: 'Conversation compacted' },
  })
}

const config: CompactionConfig = { ...DEFAULT_COMPACTION_CONFIG }

// ==================== estimateTokens ====================

describe('estimateTokens', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('should estimate based on 3.5 chars per token', () => {
    // 7 chars / 3.5 = 2 tokens
    expect(estimateTokens('1234567')).toBe(2)
  })

  it('should ceil fractional tokens', () => {
    // 1 char / 3.5 = 0.28... → 1
    expect(estimateTokens('a')).toBe(1)
  })
})

// ==================== estimateEntryTokens ====================

describe('estimateEntryTokens', () => {
  it('should estimate string content', () => {
    const entry = userText('hello') // 5 chars / 3.5 ≈ 2
    expect(estimateEntryTokens(entry)).toBe(2)
  })

  it('should estimate text blocks', () => {
    const entry = makeEntry({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' }, // 5 chars
          { type: 'text', text: 'world' }, // 5 chars
        ],
      },
    })
    // 10 chars / 3.5 ≈ 3
    expect(estimateEntryTokens(entry)).toBe(3)
  })

  it('should estimate tool_use blocks (name + serialized input)', () => {
    const entry = makeEntry({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/tmp' } },
        ],
      },
    })
    // name "Read" (4) + JSON.stringify({path:"/tmp"}) (15) = 19 / 3.5 ≈ 6
    const result = estimateEntryTokens(entry)
    expect(result).toBeGreaterThan(0)
  })

  it('should estimate tool_result blocks', () => {
    const entry = toolResultEntry('some result content') // 19 chars / 3.5 ≈ 6
    expect(estimateEntryTokens(entry)).toBe(6)
  })
})

// ==================== estimateSessionTokens ====================

describe('estimateSessionTokens', () => {
  it('should return 0 for empty array', () => {
    expect(estimateSessionTokens([])).toBe(0)
  })

  it('should sum entry tokens', () => {
    const entries = [userText('hello'), assistantText('world')]
    const total = estimateSessionTokens(entries)
    expect(total).toBe(estimateEntryTokens(entries[0]) + estimateEntryTokens(entries[1]))
  })
})

// ==================== getEffectiveWindow ====================

describe('getEffectiveWindow', () => {
  it('should subtract maxOutputTokens from maxContextTokens', () => {
    expect(getEffectiveWindow(config)).toBe(200_000 - 20_000)
  })

  it('should work with custom config', () => {
    expect(getEffectiveWindow({ ...config, maxContextTokens: 100_000, maxOutputTokens: 10_000 })).toBe(90_000)
  })
})

// ==================== getAutoCompactThreshold ====================

describe('getAutoCompactThreshold', () => {
  it('should return effectiveWindow - autoCompactBuffer by default', () => {
    expect(getAutoCompactThreshold(config)).toBe(180_000 - 13_000)
  })

  it('should respect COMPACT_PCT_OVERRIDE env var', () => {
    const original = process.env.COMPACT_PCT_OVERRIDE
    try {
      process.env.COMPACT_PCT_OVERRIDE = '50'
      // 50% of 180_000 = 90_000, but capped at effectiveWindow - buffer = 167_000
      const threshold = getAutoCompactThreshold(config)
      expect(threshold).toBe(90_000)
    } finally {
      if (original === undefined) delete process.env.COMPACT_PCT_OVERRIDE
      else process.env.COMPACT_PCT_OVERRIDE = original
    }
  })

  it('should ignore invalid COMPACT_PCT_OVERRIDE', () => {
    const original = process.env.COMPACT_PCT_OVERRIDE
    try {
      process.env.COMPACT_PCT_OVERRIDE = 'notanumber'
      expect(getAutoCompactThreshold(config)).toBe(180_000 - 13_000)
    } finally {
      if (original === undefined) delete process.env.COMPACT_PCT_OVERRIDE
      else process.env.COMPACT_PCT_OVERRIDE = original
    }
  })
})

// ==================== getActiveEntries ====================

describe('getActiveEntries', () => {
  it('should return all entries when no boundary', () => {
    const entries = [userText('a'), assistantText('b')]
    expect(getActiveEntries(entries)).toEqual(entries)
  })

  it('should return entries from last boundary onward', () => {
    const entries = [
      userText('old'),
      compactBoundary(),
      userText('new'),
      assistantText('reply'),
    ]
    const active = getActiveEntries(entries)
    expect(active).toHaveLength(3) // boundary + new + reply
    expect(active[0].type).toBe('system')
  })

  it('should use the last boundary when multiple exist', () => {
    const entries = [
      userText('very old'),
      compactBoundary(),
      userText('old'),
      compactBoundary(),
      userText('current'),
    ]
    const active = getActiveEntries(entries)
    expect(active).toHaveLength(2) // last boundary + current
  })

  it('should return empty-ish when boundary is last entry', () => {
    const entries = [userText('old'), compactBoundary()]
    const active = getActiveEntries(entries)
    expect(active).toHaveLength(1) // just the boundary
  })
})

// ==================== microcompact ====================

describe('microcompact', () => {
  it('should not modify entries with no tool results', () => {
    const entries = [userText('hi'), assistantText('hello')]
    const { entries: result, savedTokens } = microcompact(entries, config)
    expect(result).toEqual(entries)
    expect(savedTokens).toBe(0)
  })

  it('should keep recent N tool results intact', () => {
    const entries = [
      toolResultEntry('short'),
      toolResultEntry('also short'),
      toolResultEntry('recent one'),
    ]
    // Default microcompactKeepRecent = 3, so all 3 are kept
    const { entries: result, savedTokens } = microcompact(entries, config)
    expect(savedTokens).toBe(0)
  })

  it('should truncate old large tool results', () => {
    const largeContent = 'x'.repeat(1000)
    const entries = [
      toolResultEntry(largeContent, 'old1'),
      toolResultEntry(largeContent, 'old2'),
      toolResultEntry('recent1'),
      toolResultEntry('recent2'),
      toolResultEntry('recent3'),
    ]
    // Keep recent 3, truncate first 2
    const { entries: result, savedTokens } = microcompact(entries, config)
    expect(savedTokens).toBeGreaterThan(0)

    // First two should be truncated
    const firstContent = (result[0].message.content as ContentBlock[])[0]
    expect(firstContent.type).toBe('tool_result')
    if (firstContent.type === 'tool_result') {
      expect(firstContent.content).toContain('truncated')
    }

    // Last 3 should be intact
    const lastContent = (result[4].message.content as ContentBlock[])[0]
    if (lastContent.type === 'tool_result') {
      expect(lastContent.content).toBe('recent3')
    }
  })

  it('should not truncate small tool results even if old', () => {
    const entries = [
      toolResultEntry('tiny', 'old'),
      toolResultEntry('recent1'),
      toolResultEntry('recent2'),
      toolResultEntry('recent3'),
    ]
    const { savedTokens } = microcompact(entries, config)
    // 'tiny' is < 500 chars threshold, no truncation
    expect(savedTokens).toBe(0)
  })
})

// ==================== buildSummarizationPrompt ====================

describe('buildSummarizationPrompt', () => {
  it('should include conversation content', () => {
    const prompt = buildSummarizationPrompt([
      userText('what is the weather?'),
      assistantText('It is sunny.'),
    ])
    expect(prompt).toContain('[USER]: what is the weather?')
    expect(prompt).toContain('[ASSISTANT]: It is sunny.')
    expect(prompt).toContain('<conversation>')
    expect(prompt).toContain('</conversation>')
  })

  it('should skip system entries', () => {
    const prompt = buildSummarizationPrompt([
      userText('hi'),
      compactBoundary(),
      assistantText('hello'),
    ])
    expect(prompt).not.toContain('Conversation compacted')
  })

  it('should extract text blocks from content arrays', () => {
    const prompt = buildSummarizationPrompt([
      makeEntry({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'result text' },
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
          ],
        },
      }),
    ])
    expect(prompt).toContain('result text')
  })

  it('should include summarization instructions', () => {
    const prompt = buildSummarizationPrompt([userText('test')])
    expect(prompt).toContain('<summary>')
    expect(prompt).toContain('Primary Request')
  })
})

// ==================== createCompactBoundary ====================

describe('createCompactBoundary', () => {
  it('should create a system entry with correct structure', () => {
    const entry = createCompactBoundary('auto', 50000, 'sess1', 'parent-uuid')
    expect(entry.type).toBe('system')
    expect(entry.subtype).toBe('compact_boundary')
    expect(entry.compactMetadata).toEqual({ trigger: 'auto', preTokens: 50000 })
    expect(entry.sessionId).toBe('sess1')
    expect(entry.parentUuid).toBe('parent-uuid')
    expect(entry.provider).toBe('compaction')
    expect(entry.uuid).toBeTruthy()
    expect(entry.timestamp).toBeTruthy()
  })

  it('should accept manual trigger', () => {
    const entry = createCompactBoundary('manual', 1000, 's1', null)
    expect(entry.compactMetadata!.trigger).toBe('manual')
    expect(entry.parentUuid).toBeNull()
  })
})

// ==================== createSummaryEntry ====================

describe('createSummaryEntry', () => {
  it('should create a user entry with summary content', () => {
    const entry = createSummaryEntry('This is a summary.', 'sess1', 'parent-uuid')
    expect(entry.type).toBe('user')
    expect(entry.message.role).toBe('user')
    expect(typeof entry.message.content).toBe('string')
    expect(entry.message.content).toContain('This is a summary.')
    expect(entry.message.content).toContain('continued from a previous conversation')
    expect(entry.isCompactSummary).toBe(true)
    expect(entry.provider).toBe('compaction')
    expect(entry.sessionId).toBe('sess1')
    expect(entry.parentUuid).toBe('parent-uuid')
  })
})

// ==================== compactIfNeeded ====================

// A small config so tests don't need giant strings for most cases
const SMALL_CONFIG: CompactionConfig = {
  maxContextTokens: 1000,
  maxOutputTokens: 100,
  autoCompactBuffer: 100,
  microcompactKeepRecent: 1,
}
// threshold = 1000 - 100 - 100 = 800 tokens ≈ 2800 chars

describe('compactIfNeeded', () => {
  it('returns { compacted: false } when session is below threshold', async () => {
    const session = new MemorySessionStore('test-s1')
    await session.appendUser('short message')
    const summarize = vi.fn()
    const result = await compactIfNeeded(session, SMALL_CONFIG, summarize)
    expect(result).toEqual({ compacted: false, method: 'none' })
    expect(summarize).not.toHaveBeenCalled()
  })

  it('returns microcompact result when large old tool result saves enough tokens', async () => {
    const session = new MemorySessionStore('test-s2')
    // Two tool result entries — microcompactKeepRecent=1 truncates the old one
    const hugeContent = 'x'.repeat(72_000) // ~20571 tokens, well above MIN_MICROCOMPACT_SAVINGS=20000
    await session.appendUser([{ type: 'tool_result', tool_use_id: 't0', content: hugeContent }])
    await session.appendUser([{ type: 'tool_result', tool_use_id: 't1', content: 'small result' }])
    await session.appendUser('follow-up')
    const summarize = vi.fn()
    const tinyConfig: CompactionConfig = {
      maxContextTokens: 100,
      maxOutputTokens: 5,
      autoCompactBuffer: 5,
      microcompactKeepRecent: 1,
    }
    // threshold = 90 tokens; session is ~20573 tokens >> threshold; after microcompact ~4 tokens << threshold
    const result = await compactIfNeeded(session, tinyConfig, summarize)
    expect(result.compacted).toBe(true)
    expect(result.method).toBe('microcompact')
    expect(result.activeEntries).toBeDefined()
    expect(summarize).not.toHaveBeenCalled()
  })

  it('calls summarize and writes boundary+summary when microcompact is insufficient', async () => {
    const session = new MemorySessionStore('test-s3')
    // Fill with large user text that microcompact cannot truncate (no tool results)
    const largeText = 'w'.repeat(3000) // ~857 tokens > threshold of 800
    await session.appendUser(largeText)
    const summarize = vi.fn().mockResolvedValue('Here is the summary.')
    const result = await compactIfNeeded(session, SMALL_CONFIG, summarize)
    expect(result).toEqual({ compacted: true, method: 'full' })
    expect(summarize).toHaveBeenCalledOnce()
    // Boundary + summary should have been appended
    const all = await session.readAll()
    const boundary = all.find((e) => e.subtype === 'compact_boundary')
    const summary = all.find((e) => e.isCompactSummary === true)
    expect(boundary).toBeDefined()
    expect(summary).toBeDefined()
    expect(summary?.message.content).toContain('Here is the summary.')
  })

  it('propagates error when summarize throws', async () => {
    const session = new MemorySessionStore('test-s4')
    const largeText = 'e'.repeat(3000)
    await session.appendUser(largeText)
    const summarize = vi.fn().mockRejectedValue(new Error('LLM unavailable'))
    await expect(compactIfNeeded(session, SMALL_CONFIG, summarize)).rejects.toThrow('LLM unavailable')
  })
})

// ==================== forceCompact ====================

describe('forceCompact', () => {
  it('returns null for an empty session', async () => {
    const session = new MemorySessionStore('test-fc1')
    const summarize = vi.fn()
    const result = await forceCompact(session, summarize)
    expect(result).toBeNull()
    expect(summarize).not.toHaveBeenCalled()
  })

  it('compresses non-empty session and writes boundary+summary', async () => {
    const session = new MemorySessionStore('test-fc2')
    await session.appendUser('first message')
    await session.appendAssistant('assistant reply')
    const summarize = vi.fn().mockResolvedValue('Compact summary text.')
    const result = await forceCompact(session, summarize)
    expect(result).not.toBeNull()
    expect(result!.preTokens).toBeGreaterThan(0)
    expect(summarize).toHaveBeenCalledOnce()
    const all = await session.readAll()
    const boundary = all.find((e) => e.subtype === 'compact_boundary')
    const summary = all.find((e) => e.isCompactSummary === true)
    expect(boundary?.compactMetadata?.trigger).toBe('manual')
    expect(summary?.message.content).toContain('Compact summary text.')
  })

  it('propagates error when summarize throws', async () => {
    const session = new MemorySessionStore('test-fc3')
    await session.appendUser('a message')
    const summarize = vi.fn().mockRejectedValue(new Error('timeout'))
    await expect(forceCompact(session, summarize)).rejects.toThrow('timeout')
  })
})

/**
 * A. AgentCenter — Session Persistence Tests
 *
 * Verifies that all event types (text, tool_use, tool_result, media)
 * are correctly persisted to the session store with proper providerTag,
 * ContentBlock[] format, and media handling.
 *
 * Uses MemorySessionStore so assertions verify actual stored state
 * (via readAll()), not just API call recordings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContentBlock, SessionEntry } from '../../session.js'
import {
  FakeProvider,
  MemorySessionStore,
  makeAgentCenter,
  textEvent,
  toolUseEvent,
  toolResultEvent,
  doneEvent,
} from './helpers.js'

// ==================== Module Mocks ====================

vi.mock('../../compaction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../compaction.js')>()
  return {
    ...actual,
    compactIfNeeded: vi.fn().mockResolvedValue({ compacted: false, method: 'none' }),
  }
})

vi.mock('../../media-store.js', () => ({
  persistMedia: vi.fn().mockResolvedValue('2026-03-13/ace-aim-air.png'),
  resolveMediaPath: vi.fn((name: string) => `/mock/media/${name}`),
}))

vi.mock('@/ai-providers/utils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  logToolCall: vi.fn(),
}))

// ==================== Helpers ====================

function userEntries(entries: SessionEntry[]) {
  return entries.filter(e => e.type === 'user')
}

function assistantEntries(entries: SessionEntry[]) {
  return entries.filter(e => e.type === 'assistant')
}

function blocksOf(entry: SessionEntry): ContentBlock[] {
  return entry.message.content as ContentBlock[]
}

// ==================== Tests ====================

describe('AgentCenter — session persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('A1: text-only reply persists user + final assistant as ContentBlock[]', async () => {
    const provider = new FakeProvider([
      textEvent('hello'),
      doneEvent('hello'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('prompt', session)

    const entries = await session.readAll()
    const users = userEntries(entries)
    const assistants = assistantEntries(entries)

    expect(users).toHaveLength(1)
    expect(users[0].message.content).toBe('prompt')
    expect(users[0].provider).toBe('human')

    expect(assistants).toHaveLength(1)
    expect(blocksOf(assistants[0])).toEqual([{ type: 'text', text: 'hello' }])
    expect(assistants[0].provider).toBe('vercel-ai')
  })

  it('A2: tool loop persists intermediate tool_use/tool_result + final text', async () => {
    const provider = new FakeProvider([
      toolUseEvent('t1', 'get_weather', { city: 'Tokyo' }),
      toolResultEvent('t1', '72°F'),
      textEvent('The weather is 72°F'),
      doneEvent('The weather is 72°F'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('weather?', session)

    const entries = await session.readAll()
    const users = userEntries(entries)
    const assistants = assistantEntries(entries)

    // User prompt + tool_result = 2 user entries
    expect(users[0].message.content).toBe('weather?')
    expect(users[0].provider).toBe('human')

    const toolResultEntry = users.find(u =>
      Array.isArray(u.message.content) && (u.message.content as ContentBlock[]).some(b => b.type === 'tool_result'),
    )
    expect(toolResultEntry).toBeDefined()
    expect(blocksOf(toolResultEntry!)[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: '72°F',
    })

    // Intermediate tool_use + final text = 2 assistant entries
    const toolUseEntry = assistants.find(a =>
      blocksOf(a).some(b => b.type === 'tool_use'),
    )
    expect(toolUseEntry).toBeDefined()
    expect(blocksOf(toolUseEntry!)[0]).toEqual({
      type: 'tool_use',
      id: 't1',
      name: 'get_weather',
      input: { city: 'Tokyo' },
    })

    const finalEntry = assistants[assistants.length - 1]
    expect(blocksOf(finalEntry)).toEqual([{ type: 'text', text: 'The weather is 72°F' }])
  })

  it('A3: multi-turn tools produce correct flush ordering', async () => {
    const provider = new FakeProvider([
      toolUseEvent('t1', 'search', { q: 'a' }),
      toolResultEvent('t1', 'result-a'),
      toolUseEvent('t2', 'search', { q: 'b' }),
      toolResultEvent('t2', 'result-b'),
      textEvent('combined answer'),
      doneEvent('combined answer'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('search both', session)

    const entries = await session.readAll()

    const toolUseEntries = entries.filter(e =>
      e.type === 'assistant' && blocksOf(e).some(b => b.type === 'tool_use'),
    )
    expect(toolUseEntries).toHaveLength(2)
    expect((blocksOf(toolUseEntries[0])[0] as { name: string }).name).toBe('search')
    expect((blocksOf(toolUseEntries[1])[0] as { name: string }).name).toBe('search')

    const toolResultEntries = entries.filter(e =>
      e.type === 'user' && Array.isArray(e.message.content) && (e.message.content as ContentBlock[]).some(b => b.type === 'tool_result'),
    )
    expect(toolResultEntries).toHaveLength(2)
  })

  it('A4: media in done event persists image blocks in final write', async () => {
    const provider = new FakeProvider([
      textEvent('chart generated'),
      doneEvent('chart generated', [{ type: 'image', path: '/tmp/chart.png' }]),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('make a chart', session)

    const assistants = assistantEntries(await session.readAll())
    const finalEntry = assistants[assistants.length - 1]

    expect(blocksOf(finalEntry)).toEqual([
      { type: 'text', text: 'chart generated' },
      { type: 'image', url: '/api/media/2026-03-13/ace-aim-air.png' },
    ])
  })

  it('A5: media extracted from tool_result content appears in final persist', async () => {
    const toolResultContent = JSON.stringify({
      content: [{ type: 'text', text: 'MEDIA:/tmp/screenshot.png' }],
    })

    const provider = new FakeProvider([
      toolUseEvent('t1', 'screenshot', {}),
      toolResultEvent('t1', toolResultContent),
      textEvent('screenshot taken'),
      doneEvent('screenshot taken'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('take screenshot', session)

    const assistants = assistantEntries(await session.readAll())
    const finalBlocks = blocksOf(assistants[assistants.length - 1])

    expect(finalBlocks).toContainEqual({ type: 'text', text: 'screenshot taken' })
    expect(finalBlocks).toContainEqual({ type: 'image', url: '/api/media/2026-03-13/ace-aim-air.png' })
  })

  it('A6: providerTag correctly propagates for each provider type', async () => {
    for (const tag of ['vercel-ai', 'claude-code', 'agent-sdk'] as const) {
      vi.clearAllMocks()
      const provider = new FakeProvider(
        [textEvent('hi'), doneEvent('hi')],
        { providerTag: tag },
      )
      const ac = makeAgentCenter(provider)
      const session = new MemorySessionStore()

      await ac.askWithSession('test', session)

      const assistants = assistantEntries(await session.readAll())
      const finalEntry = assistants[assistants.length - 1]
      expect(finalEntry.provider).toBe(tag)
    }
  })

  it('A7: persistMedia failure silently skips image block', async () => {
    const { persistMedia } = await import('../../media-store.js')
    vi.mocked(persistMedia).mockRejectedValueOnce(new Error('ENOENT: no such file'))

    const provider = new FakeProvider([
      textEvent('image gone'),
      doneEvent('image gone', [{ type: 'image', path: '/tmp/deleted.png' }]),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('generate', session)

    const assistants = assistantEntries(await session.readAll())
    const finalBlocks = blocksOf(assistants[assistants.length - 1])

    expect(finalBlocks).toEqual([{ type: 'text', text: 'image gone' }])
  })

  it('A8: multiple media from tool_result + done event both appear in final', async () => {
    const { persistMedia } = await import('../../media-store.js')
    vi.mocked(persistMedia)
      .mockResolvedValueOnce('2026-03-13/tool-media-one.png')
      .mockResolvedValueOnce('2026-03-13/done-media-two.png')

    const toolResultContent = JSON.stringify({
      content: [{ type: 'text', text: 'MEDIA:/tmp/tool-screenshot.png' }],
    })
    const provider = new FakeProvider([
      toolUseEvent('t1', 'browser', {}),
      toolResultEvent('t1', toolResultContent),
      textEvent('done'),
      doneEvent('done', [{ type: 'image', path: '/tmp/chart.png' }]),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('browse and chart', session)

    const assistants = assistantEntries(await session.readAll())
    const finalBlocks = blocksOf(assistants[assistants.length - 1])

    expect(finalBlocks).toEqual([
      { type: 'text', text: 'done' },
      { type: 'image', url: '/api/media/2026-03-13/tool-media-one.png' },
      { type: 'image', url: '/api/media/2026-03-13/done-media-two.png' },
    ])
  })

  it('A9: tool_result with base64 image data gets stripped before session persist', async () => {
    const toolResultContent = JSON.stringify([
      { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo...' } },
      { type: 'text', text: 'Screenshot captured' },
    ])

    const provider = new FakeProvider([
      toolUseEvent('t1', 'screenshot', {}),
      toolResultEvent('t1', toolResultContent),
      textEvent('ok'),
      doneEvent('ok'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('screenshot', session)

    const users = userEntries(await session.readAll())
    const toolResultEntry = users.find(u =>
      Array.isArray(u.message.content) && (u.message.content as ContentBlock[]).some(b => b.type === 'tool_result'),
    )
    expect(toolResultEntry).toBeDefined()

    const toolResultBlock = blocksOf(toolResultEntry!).find(b => b.type === 'tool_result')!
    const parsed = JSON.parse((toolResultBlock as { content: string }).content)
    expect(parsed[0]).toEqual({ type: 'text', text: '[Image saved to disk — use Read tool to view the file]' })
    expect(parsed[1]).toEqual({ type: 'text', text: 'Screenshot captured' })
  })

  it('A10: empty text response persists correctly', async () => {
    const provider = new FakeProvider([
      doneEvent(''),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    const result = await ac.askWithSession('silent', session)

    expect(result.text).toBe('')
    const assistants = assistantEntries(await session.readAll())
    expect(blocksOf(assistants[assistants.length - 1])).toEqual([{ type: 'text', text: '' }])
  })

  it('A11: provider stream without done event throws', async () => {
    const provider = new FakeProvider([
      textEvent('cut off mid-'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await expect(ac.askWithSession('test', session)).rejects.toThrow(
      'provider stream ended without done event',
    )
  })

  it('A12: multiple consecutive text events persisted once via final result', async () => {
    const provider = new FakeProvider([
      textEvent('first '),
      textEvent('second '),
      textEvent('third'),
      doneEvent('first second third'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('multi-text', session)

    const assistants = assistantEntries(await session.readAll())

    // Only one assistant entry — the authoritative final text (no duplicate intermediate flush)
    expect(assistants).toHaveLength(1)
    expect(blocksOf(assistants[0])).toEqual([{ type: 'text', text: 'first second third' }])
  })

  it('A13: tool_use with complex nested input preserves structure', async () => {
    const complexInput = {
      orders: [
        { symbol: 'AAPL', qty: 10, side: 'buy', type: 'limit', price: 185.50 },
        { symbol: 'MSFT', qty: 5, side: 'sell', type: 'market' },
      ],
      options: { dryRun: true, timeInForce: 'day' },
    }

    const provider = new FakeProvider([
      toolUseEvent('t1', 'submit_orders', complexInput),
      toolResultEvent('t1', JSON.stringify({ submitted: 2 })),
      textEvent('Orders submitted'),
      doneEvent('Orders submitted'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('submit orders', session)

    const assistants = assistantEntries(await session.readAll())
    const toolUseEntry = assistants.find(a => blocksOf(a).some(b => b.type === 'tool_use'))
    expect(toolUseEntry).toBeDefined()
    const toolUseBlock = blocksOf(toolUseEntry!).find(b => b.type === 'tool_use')!
    expect((toolUseBlock as { input: unknown }).input).toEqual(complexInput)
  })

  it('A14: text between tool_use and tool_result is captured correctly', async () => {
    const provider = new FakeProvider([
      textEvent('Let me check...'),
      toolUseEvent('t1', 'lookup', { q: 'test' }),
      toolResultEvent('t1', 'found'),
      textEvent('Based on the result: '),
      textEvent('everything looks good.'),
      doneEvent('Based on the result: everything looks good.'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('check', session)

    const assistants = assistantEntries(await session.readAll())
    const firstFlush = assistants.find(a => {
      const blocks = blocksOf(a)
      return blocks.some(b => b.type === 'tool_use') && blocks.some(b => b.type === 'text')
    })
    expect(firstFlush).toBeDefined()
    const blocks = blocksOf(firstFlush!)
    expect(blocks[0]).toEqual({ type: 'text', text: 'Let me check...' })
    expect(blocks[1]).toMatchObject({ type: 'tool_use', name: 'lookup' })
  })

  it('A16: parallel tool calls in one step land in a single user message', async () => {
    // Simulates what Vercel AI SDK emits when the model calls multiple tools at once:
    // all tool_use events come first, then all tool_result events (one step).
    const provider = new FakeProvider([
      toolUseEvent('t1', 'get_price', { symbol: 'BTC' }),
      toolUseEvent('t2', 'get_price', { symbol: 'ETH' }),
      toolUseEvent('t3', 'get_price', { symbol: 'SOL' }),
      toolResultEvent('t1', '95000'),
      toolResultEvent('t2', '3200'),
      toolResultEvent('t3', '140'),
      textEvent('BTC $95k, ETH $3.2k, SOL $140'),
      doneEvent('BTC $95k, ETH $3.2k, SOL $140'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('prices?', session)

    const entries = await session.readAll()
    const toolResultEntries = userEntries(entries).filter(u =>
      Array.isArray(u.message.content) &&
      (u.message.content as ContentBlock[]).some(b => b.type === 'tool_result'),
    )

    // All 3 results must be in a single user message — not 3 separate ones.
    // This is required by Vercel AI SDK: toModelMessages() will throw
    // MissingToolResultsError if results are spread across multiple messages.
    expect(toolResultEntries).toHaveLength(1)
    const resultBlocks = blocksOf(toolResultEntries[0]).filter(b => b.type === 'tool_result')
    expect(resultBlocks).toHaveLength(3)
    expect(resultBlocks.map(b => (b as { tool_use_id: string }).tool_use_id)).toEqual(['t1', 't2', 't3'])
  })

  it('A17: media in tool_result content is extracted exactly once by AgentCenter when provider done.media is empty', async () => {
    const { persistMedia } = await import('../../media-store.js')
    vi.mocked(persistMedia).mockResolvedValueOnce('2026-03-14/screenshot.png')

    const toolResultContent = JSON.stringify({
      content: [{ type: 'text', text: 'MEDIA:/tmp/screenshot.png' }],
    })

    // Simulates fixed ClaudeCode/AgentSdk provider behavior:
    // - tool_result content contains MEDIA marker (raw content passed through)
    // - done event carries empty media (provider does NOT extract from tool_result)
    // AgentCenter is the sole extractor — must call persistMedia exactly once.
    const provider = new FakeProvider([
      toolUseEvent('t1', 'browser', {}),
      toolResultEvent('t1', toolResultContent),
      textEvent('screenshot taken'),
      doneEvent('screenshot taken'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('take screenshot', session)

    // persistMedia must be called exactly once — single extraction path
    expect(vi.mocked(persistMedia)).toHaveBeenCalledTimes(1)

    const assistants = assistantEntries(await session.readAll())
    const finalBlocks = blocksOf(assistants[assistants.length - 1])
    const imageBlocks = finalBlocks.filter(b => b.type === 'image')
    expect(imageBlocks).toHaveLength(1)
    expect(imageBlocks[0]).toEqual({ type: 'image', url: '/api/media/2026-03-14/screenshot.png' })
  })

  it('A15: providerTag carries through to intermediate writes too', async () => {
    const provider = new FakeProvider(
      [
        toolUseEvent('t1', 'calc', { x: 1 }),
        toolResultEvent('t1', '42'),
        textEvent('answer'),
        doneEvent('answer'),
      ],
      { providerTag: 'agent-sdk' },
    )
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    await ac.askWithSession('calc', session)

    const entries = await session.readAll()
    const assistants = assistantEntries(entries)
    for (const a of assistants) {
      expect(a.provider).toBe('agent-sdk')
    }

    const toolResultUsers = userEntries(entries).filter(u =>
      Array.isArray(u.message.content) && (u.message.content as ContentBlock[]).some(b => b.type === 'tool_result'),
    )
    for (const u of toolResultUsers) {
      expect(u.provider).toBe('agent-sdk')
    }
  })
})

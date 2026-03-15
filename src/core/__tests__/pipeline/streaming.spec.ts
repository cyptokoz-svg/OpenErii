/**
 * B. AgentCenter — Streaming Output Tests
 *
 * Verifies StreamableResult behavior: event iteration, mediaUrls in done event,
 * PromiseLike resolution, multi-consumer cursors, and error propagation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamableResult, type ProviderEvent } from '../../ai-provider-manager.js'
import {
  FakeProvider,
  MemorySessionStore,
  makeAgentCenter,
  collectEvents,
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

// ==================== Tests ====================

describe('AgentCenter — streaming output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('B1: StreamableResult yields all event types', async () => {
    const provider = new FakeProvider([
      textEvent('thinking...'),
      toolUseEvent('t1', 'calc', { expr: '1+1' }),
      toolResultEvent('t1', '2'),
      textEvent('The answer is 2'),
      doneEvent('The answer is 2'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    const stream = ac.askWithSession('calculate', session)
    const events = await collectEvents(stream)

    const types = events.map(e => e.type)
    expect(types).toContain('text')
    expect(types).toContain('tool_use')
    expect(types).toContain('tool_result')
    expect(types).toContain('done')
  })

  it('B2: done event includes mediaUrls', async () => {
    const provider = new FakeProvider([
      textEvent('image ready'),
      doneEvent('image ready', [{ type: 'image', path: '/tmp/img.png' }]),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    const stream = ac.askWithSession('gen image', session)
    const events = await collectEvents(stream)

    const done = events.find(e => e.type === 'done')
    expect(done).toBeDefined()
    expect(done!.type === 'done' && done!.result.mediaUrls).toEqual([
      '/api/media/2026-03-13/ace-aim-air.png',
    ])
  })

  it('B3: await returns ProviderResult with text, media, mediaUrls', async () => {
    const provider = new FakeProvider([
      textEvent('result'),
      doneEvent('result', [{ type: 'image', path: '/tmp/x.png' }]),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    const stream = ac.askWithSession('go', session)
    const result = await stream

    expect(result.text).toBe('result')
    expect(result.media).toEqual([{ type: 'image', path: '/tmp/x.png' }])
    expect(result.mediaUrls).toEqual(['/api/media/2026-03-13/ace-aim-air.png'])
  })

  it('B4: multiple consumers get independent event sequences', async () => {
    const events: ProviderEvent[] = [
      textEvent('a'),
      textEvent('b'),
      doneEvent('ab'),
    ]

    async function* gen() {
      for (const e of events) yield e
    }

    const stream = new StreamableResult(gen())

    const consumer1: ProviderEvent[] = []
    const consumer2: ProviderEvent[] = []

    const p1 = (async () => {
      for await (const e of stream) consumer1.push(e)
    })()
    const p2 = (async () => {
      for await (const e of stream) consumer2.push(e)
    })()

    await Promise.all([p1, p2])

    expect(consumer1.map(e => e.type)).toEqual(['text', 'text', 'done'])
    expect(consumer2.map(e => e.type)).toEqual(['text', 'text', 'done'])
  })

  it('B5: await after full iteration still resolves with same result', async () => {
    const provider = new FakeProvider([
      textEvent('hello'),
      doneEvent('hello'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    const stream = ac.askWithSession('test', session)

    const events = await collectEvents(stream)
    expect(events.length).toBeGreaterThan(0)

    const result = await stream
    expect(result.text).toBe('hello')
  })

  it('B6: stream error propagation — provider error rejects await', async () => {
    async function* failingGen(): AsyncGenerator<ProviderEvent> {
      yield textEvent('start')
      throw new Error('provider crashed')
    }

    const stream = new StreamableResult(failingGen())

    // Iteration may complete silently (due to _done being set in finally before
    // the iterator microtask resumes), but the PromiseLike (await) always rejects.
    const events: ProviderEvent[] = []
    for await (const e of stream) events.push(e)

    // Should have received the text event before the error
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('text')

    // Awaiting should reject with the provider error
    await expect(stream).rejects.toThrow('provider crashed')
  })

  it('B7: stream preserves event order across tool loops', async () => {
    const provider = new FakeProvider([
      textEvent('I will search'),
      toolUseEvent('t1', 'search', { q: 'price' }),
      toolResultEvent('t1', '$100'),
      textEvent('Found it: '),
      toolUseEvent('t2', 'format', { value: 100 }),
      toolResultEvent('t2', '$100.00'),
      textEvent('The price is $100.00'),
      doneEvent('The price is $100.00'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    const stream = ac.askWithSession('get price', session)
    const events = await collectEvents(stream)
    const types = events.map(e => e.type)

    expect(types).toEqual([
      'text', 'tool_use', 'tool_result',
      'text', 'tool_use', 'tool_result',
      'text', 'done',
    ])
  })

  it('B8: done event without media has empty mediaUrls', async () => {
    const provider = new FakeProvider([
      textEvent('no media'),
      doneEvent('no media'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    const stream = ac.askWithSession('plain', session)
    const events = await collectEvents(stream)

    const done = events.find(e => e.type === 'done')!
    expect(done.type === 'done' && done.result.mediaUrls).toEqual([])
    expect(done.type === 'done' && done.result.media).toEqual([])
  })
})

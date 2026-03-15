/**
 * Web UI streaming tests.
 *
 * Simulates the chat.ts POST handler flow: AgentCenter produces a
 * StreamableResult, which is iterated and forwarded to SSE clients.
 * Verifies that tool_use, tool_result, and intermediate text events
 * all reach the SSE clients in order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createChannel } from '../../../core/async-channel.js'
import {
  StreamableResult,
  type ProviderEvent,
} from '../../../core/ai-provider-manager.js'
import {
  FakeProvider,
  MemorySessionStore,
  makeAgentCenter,
  toolUseEvent,
  toolResultEvent,
  textEvent,
  doneEvent,
} from '../../../core/__tests__/pipeline/helpers.js'
import type { SSEClient } from '../routes/chat.js'

// ==================== Module Mocks ====================

vi.mock('../../../core/compaction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/compaction.js')>()
  return {
    ...actual,
    compactIfNeeded: vi.fn().mockResolvedValue({ compacted: false, method: 'none' }),
  }
})

vi.mock('../../../core/media-store.js', () => ({
  persistMedia: vi.fn().mockResolvedValue('2026-03-13/ace-aim-air.png'),
  resolveMediaPath: vi.fn((name: string) => `/mock/media/${name}`),
}))

vi.mock('@/ai-providers/utils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  logToolCall: vi.fn(),
}))

// ==================== Helpers ====================

/** Simulate the chat.ts POST handler streaming loop. */
async function simulateChatPost(
  stream: StreamableResult,
  clients: Map<string, SSEClient>,
) {
  for await (const event of stream) {
    if (event.type === 'done') continue
    const data = JSON.stringify({ type: 'stream', event })
    for (const client of clients.values()) {
      try { client.send(data) } catch { /* disconnected */ }
    }
  }
  return await stream
}

/** Create a capturing SSE client that records all sent data. */
function makeCapturingClient(): { client: SSEClient; sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    client: {
      id: 'test-client',
      send: (data: string) => { sent.push(data) },
    },
  }
}

// ==================== Tests ====================

describe('Web UI chat streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should push tool_use, tool_result, and text events to SSE client', async () => {
    const provider = new FakeProvider([
      toolUseEvent('t1', 'getQuote', { symbol: 'AAPL' }),
      toolResultEvent('t1', '{"price": 185}'),
      textEvent('AAPL is at $185'),
      doneEvent('AAPL is at $185'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()
    const stream = ac.askWithSession('check AAPL', session)

    const { client, sent } = makeCapturingClient()
    const clients = new Map([['c1', client]])

    const result = await simulateChatPost(stream, clients)

    // All 3 streaming events should reach SSE (done is skipped)
    expect(sent).toHaveLength(3)

    const parsed = sent.map(s => JSON.parse(s))
    expect(parsed[0]).toEqual({ type: 'stream', event: { type: 'tool_use', id: 't1', name: 'getQuote', input: { symbol: 'AAPL' } } })
    expect(parsed[1]).toEqual({ type: 'stream', event: { type: 'tool_result', tool_use_id: 't1', content: '{"price": 185}' } })
    expect(parsed[2]).toEqual({ type: 'stream', event: { type: 'text', text: 'AAPL is at $185' } })

    expect(result.text).toBe('AAPL is at $185')
  })

  it('should handle multiple tool loops with intermediate text', async () => {
    const provider = new FakeProvider([
      textEvent('Let me check...'),
      toolUseEvent('t1', 'getPortfolio', {}),
      toolResultEvent('t1', '[{pos: AAPL}]'),
      textEvent('Now calculating...'),
      toolUseEvent('t2', 'calculateIndicator', { formula: 'RSI' }),
      toolResultEvent('t2', '45.3'),
      textEvent('Based on analysis, RSI is 45.3'),
      doneEvent('Based on analysis, RSI is 45.3'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()
    const stream = ac.askWithSession('analyze portfolio', session)

    const { client, sent } = makeCapturingClient()
    const clients = new Map([['c1', client]])

    await simulateChatPost(stream, clients)

    // 7 events: text, tool_use, tool_result, text, tool_use, tool_result, text
    expect(sent).toHaveLength(7)

    const types = sent.map(s => JSON.parse(s).event.type)
    expect(types).toEqual([
      'text', 'tool_use', 'tool_result',
      'text', 'tool_use', 'tool_result',
      'text',
    ])
  })

  it('should push events to multiple SSE clients', async () => {
    const provider = new FakeProvider([
      toolUseEvent('t1', 'Read', { path: '/tmp' }),
      toolResultEvent('t1', 'contents'),
      textEvent('Done'),
      doneEvent('Done'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()
    const stream = ac.askWithSession('read file', session)

    const c1 = makeCapturingClient()
    const c2 = makeCapturingClient()
    const clients = new Map([['c1', c1.client], ['c2', c2.client]])

    await simulateChatPost(stream, clients)

    expect(c1.sent).toHaveLength(3)
    expect(c2.sent).toHaveLength(3)
    expect(c1.sent).toEqual(c2.sent)
  })

  it('should deliver events with no SSE clients without error', async () => {
    const provider = new FakeProvider([
      toolUseEvent('t1', 'Read', {}),
      toolResultEvent('t1', 'ok'),
      doneEvent('ok'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()
    const stream = ac.askWithSession('test', session)

    const emptyClients = new Map<string, SSEClient>()
    const result = await simulateChatPost(stream, emptyClients)

    expect(result.text).toBe('ok')
  })

  it('should work with AsyncChannel-based provider (simulates Claude Code CLI)', async () => {
    // Simulates the ClaudeCodeProvider pattern: callbacks push to channel
    const channel = createChannel<ProviderEvent>()

    // Simulate async CLI output arriving over time
    setTimeout(() => {
      channel.push({ type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '*.ts' } })
    }, 5)
    setTimeout(() => {
      channel.push({ type: 'tool_result', tool_use_id: 't1', content: 'file1.ts\nfile2.ts' })
    }, 10)
    setTimeout(() => {
      channel.push({ type: 'text', text: 'Found 2 files' })
    }, 15)
    setTimeout(() => {
      channel.push({ type: 'done', result: { text: 'Found 2 files', media: [] } })
      channel.close()
    }, 20)

    const sr = new StreamableResult(channel)

    const { client, sent } = makeCapturingClient()
    const clients = new Map([['c1', client]])

    await simulateChatPost(sr, clients)

    expect(sent).toHaveLength(3)

    const types = sent.map(s => JSON.parse(s).event.type)
    expect(types).toEqual(['tool_use', 'tool_result', 'text'])
  })

  it('should work when all events arrive synchronously (burst mode)', async () => {
    // Simulates a fast CLI where all events are already in the buffer
    const channel = createChannel<ProviderEvent>()

    // Push all events synchronously (same tick)
    channel.push({ type: 'tool_use', id: 't1', name: 'Read', input: {} })
    channel.push({ type: 'tool_result', tool_use_id: 't1', content: 'data' })
    channel.push({ type: 'text', text: 'result' })
    channel.push({ type: 'done', result: { text: 'result', media: [] } })
    channel.close()

    const sr = new StreamableResult(channel)

    const { client, sent } = makeCapturingClient()
    const clients = new Map([['c1', client]])

    await simulateChatPost(sr, clients)

    expect(sent).toHaveLength(3)

    const types = sent.map(s => JSON.parse(s).event.type)
    expect(types).toEqual(['tool_use', 'tool_result', 'text'])
  })

  it('should work with AgentCenter pipeline (full integration)', async () => {
    // Full integration: FakeProvider → AgentCenter._generate() → StreamableResult → SSE
    const provider = new FakeProvider([
      toolUseEvent('t1', 'getAccount', {}),
      toolResultEvent('t1', '{"cash": 100000}'),
      toolUseEvent('t2', 'getQuote', { aliceId: 'alpaca-AAPL' }),
      toolResultEvent('t2', '{"last": 255.71}'),
      textEvent('Account has $100k, AAPL at $255.71'),
      doneEvent('Account has $100k, AAPL at $255.71'),
    ])
    const ac = makeAgentCenter(provider)
    const session = new MemorySessionStore()

    const stream = ac.askWithSession('show account', session)

    const { client, sent } = makeCapturingClient()
    const clients = new Map([['c1', client]])

    const result = await simulateChatPost(stream, clients)

    // 5 events: tool_use, tool_result, tool_use, tool_result, text
    expect(sent).toHaveLength(5)

    const types = sent.map(s => JSON.parse(s).event.type)
    expect(types).toEqual([
      'tool_use', 'tool_result',
      'tool_use', 'tool_result',
      'text',
    ])

    expect(result.text).toBe('Account has $100k, AAPL at $255.71')
  })
})

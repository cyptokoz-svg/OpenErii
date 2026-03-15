/**
 * C. ConnectorCenter — Delivery Tests
 *
 * Verifies notify/notifyStream/broadcast routing, sendStream delegation,
 * fallback to send, interaction tracking, and error resilience.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamableResult, type ProviderEvent } from '../../ai-provider-manager.js'
import { ConnectorCenter } from '../../connector-center.js'
import { createEventLog } from '../../event-log.js'
import type { MediaAttachment } from '../../types.js'
import {
  MockConnector,
  textEvent,
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

describe('ConnectorCenter — delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('C1: notify() sends text with default kind=notification', async () => {
    const cc = new ConnectorCenter()
    const connector = new MockConnector({ channel: 'web' })
    cc.register(connector)

    await cc.notify('hello')

    expect(connector.calls).toHaveLength(1)
    expect(connector.calls[0].method).toBe('send')
    expect(connector.calls[0].payload).toEqual({
      kind: 'notification',
      text: 'hello',
      media: undefined,
      source: undefined,
    })
  })

  it('C2: notify() with media passes MediaAttachment[] through', async () => {
    const cc = new ConnectorCenter()
    const connector = new MockConnector({ channel: 'web' })
    cc.register(connector)

    const media: MediaAttachment[] = [{ type: 'image', path: '/tmp/chart.png' }]
    await cc.notify('check this', { media, source: 'heartbeat' })

    const payload = connector.calls[0].payload!
    expect(payload.media).toEqual(media)
    expect(payload.source).toBe('heartbeat')
  })

  it('C3: notify() with no connector returns delivered=false', async () => {
    const cc = new ConnectorCenter()
    const result = await cc.notify('nobody home')
    expect(result.delivered).toBe(false)
  })

  it('C4: notifyStream() delegates to sendStream when available', async () => {
    const cc = new ConnectorCenter()
    const connector = new MockConnector({ channel: 'web' })
    cc.register(connector)

    async function* gen(): AsyncGenerator<ProviderEvent> {
      yield textEvent('streaming...')
      yield doneEvent('streaming...')
    }
    const stream = new StreamableResult(gen())

    await cc.notifyStream(stream, { source: 'cron' })

    expect(connector.calls).toHaveLength(1)
    expect(connector.calls[0].method).toBe('sendStream')
    expect(connector.calls[0].meta).toEqual({ kind: 'notification', source: 'cron' })
    // No send calls — only sendStream
    expect(connector.calls.filter(c => c.method === 'send')).toHaveLength(0)
  })

  it('C5: notifyStream() drains and falls back to send when no sendStream', async () => {
    const cc = new ConnectorCenter()
    const connector = new MockConnector({ channel: 'telegram', sendStream: false })
    cc.register(connector)

    async function* gen(): AsyncGenerator<ProviderEvent> {
      yield textEvent('fallback')
      yield doneEvent('fallback')
    }
    const stream = new StreamableResult(gen())

    await cc.notifyStream(stream, { kind: 'message', source: 'manual' })

    expect(connector.calls).toHaveLength(1)
    expect(connector.calls[0].method).toBe('send')
    expect(connector.calls[0].payload!.text).toBe('fallback')
    expect(connector.calls[0].payload!.kind).toBe('message')
  })

  it('C6: broadcast() only sends to push-capable connectors', async () => {
    const cc = new ConnectorCenter()
    const pushable = new MockConnector({ channel: 'web', push: true })
    const pullOnly = new MockConnector({ channel: 'mcp', push: false })
    cc.register(pushable)
    cc.register(pullOnly)

    await cc.broadcast('announcement')

    expect(pushable.calls).toHaveLength(1)
    expect(pullOnly.calls).toHaveLength(0)
  })

  it('C7: broadcast() continues despite individual send failures', async () => {
    const cc = new ConnectorCenter()

    const failing = new MockConnector({ channel: 'telegram', push: true })
    // Override send to simulate a network error
    const originalSend = failing.send.bind(failing)
    let callCount = 0
    failing.send = async (payload) => {
      callCount++
      if (callCount === 1) throw new Error('network error')
      return originalSend(payload)
    }

    const working = new MockConnector({ channel: 'web', push: true })
    cc.register(failing)
    cc.register(working)

    const results = await cc.broadcast('test')

    expect(results).toHaveLength(2)
    const failResult = results.find(r => r.channel === 'telegram')
    const okResult = results.find(r => r.channel === 'web')
    expect(failResult!.delivered).toBe(false)
    expect(okResult!.delivered).toBe(true)
  })

  it('C8: resolveTarget defaults to first registered when no interaction', async () => {
    const cc = new ConnectorCenter()
    const web = new MockConnector({ channel: 'web' })
    const telegram = new MockConnector({ channel: 'telegram' })
    cc.register(web)
    cc.register(telegram)

    await cc.notify('first')
    expect(web.calls).toHaveLength(1)
    expect(telegram.calls).toHaveLength(0)
  })

  it('C9: resolveTarget follows lastInteraction via EventLog', async () => {
    const eventLog = await createEventLog({ logPath: `/tmp/test-pipeline-c9-${Date.now()}.jsonl` })
    try {
      const cc = new ConnectorCenter(eventLog)

      const web = new MockConnector({ channel: 'web' })
      const telegram = new MockConnector({ channel: 'telegram' })
      cc.register(web)
      cc.register(telegram)

      // Simulate a message received on telegram
      await eventLog.append('message.received', { channel: 'telegram', to: 'chat123', prompt: 'hi' })

      await cc.notify('reply')
      // Should route to telegram because of last interaction
      expect(telegram.calls).toHaveLength(1)
      expect(web.calls).toHaveLength(0)
      expect(telegram.calls[0].payload!.text).toBe('reply')
    } finally {
      await eventLog._resetForTest()
    }
  })

  it('C10: notifyStream drains stream without hanging when no connector', async () => {
    const cc = new ConnectorCenter()

    let drained = false
    async function* gen(): AsyncGenerator<ProviderEvent> {
      yield textEvent('orphan')
      yield doneEvent('orphan')
      drained = true
    }
    const stream = new StreamableResult(gen())

    const result = await cc.notifyStream(stream)
    expect(result.delivered).toBe(false)
    await stream
    expect(drained).toBe(true)
  })

  it('C11: notify with explicit kind=message overrides default', async () => {
    const cc = new ConnectorCenter()
    const connector = new MockConnector({ channel: 'web' })
    cc.register(connector)

    await cc.notify('user message', { kind: 'message', source: 'manual' })

    expect(connector.calls[0].payload!.kind).toBe('message')
    expect(connector.calls[0].payload!.source).toBe('manual')
  })

  it('C12: unregister callback removes connector', async () => {
    const cc = new ConnectorCenter()
    const connector = new MockConnector({ channel: 'web' })
    const unregister = cc.register(connector)

    await cc.notify('before')
    expect(connector.calls).toHaveLength(1)

    unregister()

    const result = await cc.notify('after')
    expect(result.delivered).toBe(false)
    expect(connector.calls).toHaveLength(1)
  })

  it('C13: re-register replaces existing connector for same channel', async () => {
    const cc = new ConnectorCenter()
    const old = new MockConnector({ channel: 'web' })
    const replacement = new MockConnector({ channel: 'web' })

    cc.register(old)
    cc.register(replacement)

    await cc.notify('test')

    expect(old.calls).toHaveLength(0)
    expect(replacement.calls).toHaveLength(1)
  })

  it('C14: broadcast with media and source passes all fields correctly', async () => {
    const cc = new ConnectorCenter()
    const web = new MockConnector({ channel: 'web', push: true })
    const telegram = new MockConnector({ channel: 'telegram', push: true })
    cc.register(web)
    cc.register(telegram)

    const media: MediaAttachment[] = [
      { type: 'image', path: '/tmp/alert.png' },
      { type: 'image', path: '/tmp/chart.png' },
    ]
    await cc.broadcast('alert!', { media, source: 'cron', kind: 'notification' })

    for (const conn of [web, telegram]) {
      expect(conn.calls).toHaveLength(1)
      const payload = conn.calls[0].payload!
      expect(payload.text).toBe('alert!')
      expect(payload.media).toEqual(media)
      expect(payload.source).toBe('cron')
      expect(payload.kind).toBe('notification')
    }
  })

  it('C15: notifyStream with kind=message passes through to sendStream meta', async () => {
    const cc = new ConnectorCenter()
    const connector = new MockConnector({ channel: 'web' })
    cc.register(connector)

    async function* gen(): AsyncGenerator<ProviderEvent> {
      yield textEvent('msg')
      yield doneEvent('msg')
    }
    const stream = new StreamableResult(gen())

    await cc.notifyStream(stream, { kind: 'message', source: 'manual' })

    expect(connector.calls[0].meta).toEqual({ kind: 'message', source: 'manual' })
  })
})

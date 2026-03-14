import { describe, it, expect, beforeEach } from 'vitest'
import { Scorecard } from './scorecard'
import type { AtlasConfig } from './types'

const mockConfig: AtlasConfig = {
  enabled: true,
  model_tiers: { default: 'haiku' },
  max_concurrency: 5,
  departments: [{ id: 'test', name: 'test', enabled: true, layers: ['L1'], agents_config: 'agents.json', timeframes: ['1d'] }],
}

describe('Scorecard', () => {
  let sc: Scorecard

  beforeEach(() => {
    sc = new Scorecard('test', mockConfig)
  })

  it('records a signal', () => {
    sc.recordSignal('agent-a', 'BULLISH', 80, ['GC'], '2026-03-14')
    const scores = sc.getAllScores()
    expect(scores).toHaveLength(1)
    expect(scores[0].agent).toBe('agent-a')
    expect(scores[0].total_signals).toBe(1)
  })

  it('deduplicates signals on same date', () => {
    sc.recordSignal('agent-a', 'BULLISH', 80, ['GC'], '2026-03-14')
    sc.recordSignal('agent-a', 'BEARISH', 60, ['GC'], '2026-03-14')
    const scores = sc.getAllScores()
    expect(scores[0].total_signals).toBe(1)
  })

  it('tracks multiple agents', () => {
    sc.recordSignal('agent-a', 'BULLISH', 80, ['GC'], '2026-03-14')
    sc.recordSignal('agent-b', 'BEARISH', 60, ['SI'], '2026-03-14')
    const scores = sc.getAllScores()
    expect(scores).toHaveLength(2)
  })

  it('returns default weight 1.0', () => {
    const weights = sc.getAllWeights()
    expect(Object.keys(weights)).toHaveLength(0)
  })

  it('computes avg conviction', () => {
    sc.recordSignal('agent-a', 'BULLISH', 80, [], '2026-03-14')
    sc.recordSignal('agent-a', 'BULLISH', 60, [], '2026-03-15')
    const scores = sc.getAllScores()
    expect(scores[0].avg_conviction).toBe(70)
  })

  it('getSummary filters by agent name', () => {
    sc.recordSignal('agent-a', 'BULLISH', 80, [], '2026-03-14')
    sc.recordSignal('agent-b', 'BEARISH', 60, [], '2026-03-14')
    const result = sc.getSummary('agent-a')
    expect(Array.isArray(result)).toBe(false)
    expect((result as { agent: string }).agent).toBe('agent-a')
  })
})

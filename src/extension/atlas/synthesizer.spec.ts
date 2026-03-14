import { describe, it, expect } from 'vitest'
import { synthesizeLayer } from './synthesizer'
import type { Envelope } from './types'

function makeEnvelope(direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL', conviction: number, weight = 1.0): Envelope {
  return {
    agent: `agent-${Math.random().toString(36).slice(2, 6)}`,
    display_name: 'Test Agent',
    layer: 'L1',
    signal: { direction, conviction, targets: [], positions: [] },
    reasoning: { summary: 'test', key_factors: [], data_used: [], caveats: '' },
    knowledge_updates: [],
    weight,
    timestamp: new Date().toISOString(),
  }
}

describe('synthesizeLayer', () => {
  it('returns BULLISH when all agents are bullish', () => {
    const envelopes = [
      makeEnvelope('BULLISH', 80, 1.0),
      makeEnvelope('BULLISH', 70, 1.0),
      makeEnvelope('BULLISH', 90, 1.0),
    ]
    const result = synthesizeLayer('L1', envelopes)
    expect(result.direction).toBe('BULLISH')
    // agreement_ratio is a percentage (0-100)
    expect(result.agreement_ratio).toBe(100)
    expect(result.dissent).toHaveLength(0)
  })

  it('returns BEARISH when majority is bearish', () => {
    const envelopes = [
      makeEnvelope('BEARISH', 80, 1.5),
      makeEnvelope('BEARISH', 70, 1.0),
      makeEnvelope('BULLISH', 50, 0.5),
    ]
    const result = synthesizeLayer('L2', envelopes)
    expect(result.direction).toBe('BEARISH')
    expect(result.dissent.length).toBeGreaterThan(0)
  })

  it('weights affect outcome', () => {
    const envelopes = [
      makeEnvelope('BULLISH', 90, 3.0),
      makeEnvelope('BEARISH', 50, 0.3),
      makeEnvelope('BEARISH', 40, 0.3),
    ]
    const result = synthesizeLayer('L1', envelopes)
    expect(result.direction).toBe('BULLISH')
  })

  it('returns NEUTRAL for empty envelopes', () => {
    const result = synthesizeLayer('L1', [])
    expect(result.direction).toBe('NEUTRAL')
    expect(result.conviction).toBe(0)
  })

  it('conviction is weighted average', () => {
    const envelopes = [
      makeEnvelope('BULLISH', 100, 1.0),
      makeEnvelope('BULLISH', 50, 1.0),
    ]
    const result = synthesizeLayer('L1', envelopes)
    expect(result.conviction).toBeGreaterThan(60)
    expect(result.conviction).toBeLessThan(90)
  })
})

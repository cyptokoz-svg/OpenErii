import { describe, it, expect } from 'vitest'
import { parseAgentOutput, buildEnvelope } from './envelope'

describe('envelope', () => {
  describe('parseAgentOutput', () => {
    it('parses valid JSON output', () => {
      const raw = JSON.stringify({
        signal: { direction: 'BULLISH', conviction: 75, targets: [], positions: [] },
        reasoning: { summary: 'test summary', key_factors: ['f1'], data_used: ['d1'], caveats: 'none' },
        knowledge_updates: [],
      })
      const result = parseAgentOutput(raw)
      expect(result.signal.direction).toBe('BULLISH')
      expect(result.signal.conviction).toBe(75)
      expect(result.reasoning.summary).toBe('test summary')
    })

    it('strips markdown code fences', () => {
      const raw = '```json\n' + JSON.stringify({
        signal: { direction: 'bearish', conviction: 50, targets: [], positions: [] },
        reasoning: { summary: 'x', key_factors: [], data_used: [], caveats: '' },
        knowledge_updates: [],
      }) + '\n```'
      const result = parseAgentOutput(raw)
      expect(result.signal.direction).toBe('BEARISH')
    })

    it('normalizes direction to uppercase', () => {
      const raw = JSON.stringify({
        signal: { direction: 'bullish', conviction: 60, targets: [], positions: [] },
        reasoning: { summary: 'x', key_factors: [], data_used: [], caveats: '' },
        knowledge_updates: [],
      })
      const result = parseAgentOutput(raw)
      expect(result.signal.direction).toBe('BULLISH')
    })

    it('clamps conviction to 0-100', () => {
      const raw = JSON.stringify({
        signal: { direction: 'NEUTRAL', conviction: 150, targets: [], positions: [] },
        reasoning: { summary: 'x', key_factors: [], data_used: [], caveats: '' },
        knowledge_updates: [],
      })
      const result = parseAgentOutput(raw)
      expect(result.signal.conviction).toBe(100)
    })

    it('throws for invalid JSON', () => {
      expect(() => parseAgentOutput('not json')).toThrow()
    })

    it('throws for missing signal', () => {
      const raw = JSON.stringify({ reasoning: { summary: 'x' } })
      expect(() => parseAgentOutput(raw)).toThrow()
    })
  })

  describe('buildEnvelope', () => {
    it('wraps parsed output with agent metadata', () => {
      const parsed = {
        signal: { direction: 'BULLISH' as const, conviction: 80, targets: [] as string[], positions: [] },
        reasoning: { summary: 'test', key_factors: [], data_used: [], caveats: '' },
        knowledge_updates: [],
      }
      const env = buildEnvelope('macro-fed', 'Fed Watcher', 'L1', parsed, 1.5)
      expect(env.agent).toBe('macro-fed')
      expect(env.display_name).toBe('Fed Watcher')
      expect(env.layer).toBe('L1')
      expect(env.weight).toBe(1.5)
      expect(env.signal.direction).toBe('BULLISH')
      expect(env.timestamp).toBeTruthy()
    })
  })
})

/**
 * Atlas Synthesizer — Layer synthesis via weighted voting
 *
 * Ported from ATLAS-Commodity's LayerSynthesizer.
 * Aggregates multiple agent envelopes into a single layer-level signal.
 */

import type { Envelope, LayerSynthesis, Layer, Direction } from './types.js'

// ==================== Weighted Voting ====================

interface VoteAccumulator {
  bullish: number
  bearish: number
  neutral: number
  total_weight: number
  weighted_conviction: number
}

function accumulate(envelopes: Envelope[]): VoteAccumulator {
  const acc: VoteAccumulator = {
    bullish: 0,
    bearish: 0,
    neutral: 0,
    total_weight: 0,
    weighted_conviction: 0,
  }

  for (const env of envelopes) {
    const w = env.weight
    acc.total_weight += w

    switch (env.signal.direction) {
      case 'BULLISH':
        acc.bullish += w
        acc.weighted_conviction += env.signal.conviction * w
        break
      case 'BEARISH':
        acc.bearish += w
        acc.weighted_conviction -= env.signal.conviction * w
        break
      case 'NEUTRAL':
        acc.neutral += w
        break
    }
  }

  return acc
}

function resolveDirection(acc: VoteAccumulator): Direction {
  if (acc.bullish > acc.bearish && acc.bullish > acc.neutral) return 'BULLISH'
  if (acc.bearish > acc.bullish && acc.bearish > acc.neutral) return 'BEARISH'
  return 'NEUTRAL'
}

function resolveConviction(acc: VoteAccumulator, direction: Direction): number {
  if (acc.total_weight === 0) return 0

  const raw = Math.abs(acc.weighted_conviction) / acc.total_weight
  return Math.max(0, Math.min(100, Math.round(raw)))
}

function computeAgreement(envelopes: Envelope[], direction: Direction): number {
  if (envelopes.length === 0) return 0
  const agreeing = envelopes.filter((e) => e.signal.direction === direction).length
  return Math.round((agreeing / envelopes.length) * 100)
}

function collectDissent(envelopes: Envelope[], direction: Direction): string[] {
  return envelopes
    .filter((e) => e.signal.direction !== direction && e.signal.direction !== 'NEUTRAL')
    .map((e) => `${e.display_name}: ${e.signal.direction} (conviction ${e.signal.conviction}) — ${e.reasoning.summary}`)
}

function buildSummary(
  layer: Layer,
  direction: Direction,
  conviction: number,
  agreement: number,
  envelopes: Envelope[],
): string {
  const total = envelopes.length
  const agreeing = envelopes.filter((e) => e.signal.direction === direction).length
  return `${layer} ${direction} conviction ${conviction} (${agreeing}/${total} agents agree, ${agreement}% agreement)`
}

// ==================== Public API ====================

/**
 * Synthesize a layer's envelopes into a single LayerSynthesis.
 * Uses weighted voting based on Darwinian weights.
 */
export function synthesizeLayer(layer: Layer, envelopes: Envelope[]): LayerSynthesis {
  if (envelopes.length === 0) {
    return {
      layer,
      direction: 'NEUTRAL',
      conviction: 0,
      agreement_ratio: 0,
      envelopes: [],
      dissent: [],
      summary: `${layer}: no agents ran`,
    }
  }

  const acc = accumulate(envelopes)
  const direction = resolveDirection(acc)
  const conviction = resolveConviction(acc, direction)
  const agreement = computeAgreement(envelopes, direction)
  const dissent = collectDissent(envelopes, direction)
  const summary = buildSummary(layer, direction, conviction, agreement, envelopes)

  return {
    layer,
    direction,
    conviction,
    agreement_ratio: agreement,
    envelopes,
    dissent,
    summary,
  }
}

/**
 * Format layer synthesis as context string for downstream agents.
 * Used to pass L1 regime to L2, L2 signals to L3, etc.
 */
export function formatSynthesisContext(synthesis: LayerSynthesis): string {
  const parts: string[] = [
    `## ${synthesis.layer} Synthesis`,
    `Direction: ${synthesis.direction}`,
    `Conviction: ${synthesis.conviction}`,
    `Agreement: ${synthesis.agreement_ratio}%`,
    '',
    '### Agent Signals:',
  ]

  for (const env of synthesis.envelopes) {
    parts.push(
      `- **${env.display_name}**: ${env.signal.direction} (conviction ${env.signal.conviction}) — ${env.reasoning.summary}`,
    )
  }

  if (synthesis.dissent.length > 0) {
    parts.push('', '### Dissenting Views:')
    for (const d of synthesis.dissent) {
      parts.push(`- ⚠️ ${d}`)
    }
  }

  return parts.join('\n')
}

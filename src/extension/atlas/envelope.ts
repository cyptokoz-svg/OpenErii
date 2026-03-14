/**
 * Atlas Envelope — Zod schemas for agent communication protocol
 *
 * Ported from ATLAS-Commodity's Pydantic v2 envelope.py.
 * All agent outputs are validated through these schemas.
 */

import { z } from 'zod'

// ==================== Knowledge Update ====================

export const KnowledgeUpdateSchema = z.object({
  file: z.string().min(1),
  type: z.enum(['insight', 'event', 'lesson', 'pattern', 'seasonal']).default('insight'),
  content: z.string().min(1),
})

// ==================== Position ====================

export const PositionSchema = z.object({
  ticker: z.string().min(1),
  name: z.string().default(''),
  direction: z.enum(['long', 'short']).default('long'),
  size_pct: z.number().min(0).max(100).default(0),
  entry_price: z.number().nullable().default(null),
  entry_zone: z.array(z.number()).default([]),
  stop_loss: z.number().nullable().default(null),
  take_profit: z.array(z.number()).default([]),
  rationale: z.string().default(''),
}).passthrough()

// ==================== Signal ====================

export const SignalSchema = z.object({
  direction: z.preprocess(
    (v) => {
      const s = String(v).toUpperCase().trim()
      if (['BULLISH', 'BEARISH', 'NEUTRAL'].includes(s)) return s
      return 'NEUTRAL'
    },
    z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  ),
  conviction: z.preprocess(
    (v) => {
      const n = Number(v)
      if (isNaN(n)) return 0
      return Math.max(0, Math.min(100, Math.round(n)))
    },
    z.number().int().min(0).max(100),
  ),
  targets: z.preprocess(
    (v) => {
      if (!Array.isArray(v)) return v ? [String(v)] : []
      return v.map(String)
    },
    z.array(z.string()),
  ),
  positions: z.preprocess(
    (v) => {
      if (!Array.isArray(v)) return []
      return v.filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' &&
          item !== null &&
          'ticker' in item &&
          'direction' in item,
      )
    },
    z.array(PositionSchema).default([]),
  ),
})

// ==================== Reasoning ====================

export const ReasoningSchema = z.object({
  summary: z.string().default(''),
  key_factors: z.array(z.string()).default([]),
  data_used: z.array(z.string()).default([]),
  caveats: z.string().default(''),
})

// ==================== Agent Output ====================

/** Raw LLM output schema — what the agent returns as JSON */
export const AgentOutputSchema = z.object({
  signal: SignalSchema,
  reasoning: ReasoningSchema,
  knowledge_updates: z.array(KnowledgeUpdateSchema).default([]),
})

// ==================== Full Envelope ====================

/** Complete envelope with metadata added by runner */
export const EnvelopeSchema = z.object({
  agent: z.string(),
  display_name: z.string(),
  layer: z.enum(['L1', 'L2', 'L3', 'L4']),
  signal: SignalSchema,
  reasoning: ReasoningSchema,
  knowledge_updates: z.array(KnowledgeUpdateSchema).default([]),
  weight: z.number().default(1.0),
  timestamp: z.string(),
})

// ==================== Type exports ====================

export type AgentOutput = z.infer<typeof AgentOutputSchema>
export type EnvelopeData = z.infer<typeof EnvelopeSchema>

// ==================== Helpers ====================

/**
 * Parse raw LLM JSON output into a validated AgentOutput.
 * Tolerant of LLM formatting errors — normalizes direction, clamps conviction, etc.
 */
export function parseAgentOutput(raw: string): AgentOutput {
  // Strip markdown code fences if present
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }

  const parsed = JSON.parse(cleaned)
  return AgentOutputSchema.parse(parsed)
}

/**
 * Build a complete envelope from agent output + metadata.
 */
export function buildEnvelope(
  agentName: string,
  displayName: string,
  layer: 'L1' | 'L2' | 'L3' | 'L4',
  output: AgentOutput,
  weight: number = 1.0,
): EnvelopeData {
  return EnvelopeSchema.parse({
    agent: agentName,
    display_name: displayName,
    layer,
    signal: output.signal,
    reasoning: output.reasoning,
    knowledge_updates: output.knowledge_updates,
    weight,
    timestamp: new Date().toISOString(),
  })
}

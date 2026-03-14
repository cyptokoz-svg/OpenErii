/**
 * Atlas Runner — Agent execution engine
 *
 * Ported from ATLAS-Commodity's runner.py.
 * Loads prompt → assembles context (data + knowledge + upstream) → calls LLM → parses envelope.
 */

import type { AgentConfig, Envelope, LayerSynthesis, KnowledgeUpdate } from './types.js'
import { parseAgentOutput, buildEnvelope } from './envelope.js'
import { loadPrompt, resolveModel } from './config.js'
import type { AtlasConfig } from './types.js'
import { KnowledgeGraph } from './knowledge.js'
import { formatSynthesisContext } from './synthesizer.js'

// ==================== Output Schema Templates ====================

const STANDARD_OUTPUT_SCHEMA = `
## Output Format
Respond with strict JSON:
{
  "signal": {
    "direction": "BULLISH or BEARISH or NEUTRAL",
    "conviction": 1-100,
    "targets": ["relevant tickers"]
  },
  "reasoning": {
    "summary": "One sentence summary",
    "key_factors": ["factor1", "factor2"],
    "data_used": ["data sources used"],
    "caveats": "Key risks to watch"
  },
  "knowledge_updates": [
    {
      "file": "filename.md",
      "type": "insight | event | lesson | pattern | seasonal",
      "content": "New finding with [[concept]] links"
    }
  ]
}`.trim()

const L4_OUTPUT_SCHEMA = `
## Ticker Reference
CL=F:WTI  BZ=F:Brent  NG=F:NatGas  GC=F:Gold  SI=F:Silver
HG=F:Copper  ZW=F:Wheat  ZC=F:Corn  ZS=F:Soybean
KC=F:Coffee  SB=F:Sugar  LE=F:LiveCattle  HE=F:LeanHogs

## Output Format
Respond with strict JSON:
{
  "signal": {
    "direction": "BULLISH or BEARISH or NEUTRAL",
    "conviction": 1-100,
    "targets": ["CL=F"],
    "positions": [
      {
        "ticker": "CL=F",
        "name": "WTI Crude",
        "direction": "long or short",
        "size_pct": 5.0,
        "entry_price": 82.50,
        "entry_zone": [80.0, 83.5],
        "stop_loss": 77.0,
        "take_profit": [88.0, 93.0],
        "rationale": "Brief reason"
      }
    ]
  },
  "reasoning": {
    "summary": "Final decision summary",
    "key_factors": ["factor1", "factor2"],
    "data_used": ["data sources"],
    "caveats": "Key risks"
  },
  "knowledge_updates": []
}`.trim()

// ==================== Types ====================

/** Function that calls the LLM and returns text response. */
export type LLMCallFn = (prompt: string, model: string) => Promise<string>

/** Function that fetches data for an agent. */
export type DataFetchFn = (agent: AgentConfig, departmentId: string) => Promise<string>

export interface RunnerConfig {
  atlasConfig: AtlasConfig
  departmentId: string
  knowledgeGraph: KnowledgeGraph
  llmCall: LLMCallFn
  dataFetch: DataFetchFn
}

// ==================== Runner ====================

export class AgentRunner {
  private config: AtlasConfig
  private departmentId: string
  private kg: KnowledgeGraph
  private llmCall: LLMCallFn
  private dataFetch: DataFetchFn

  constructor(opts: RunnerConfig) {
    this.config = opts.atlasConfig
    this.departmentId = opts.departmentId
    this.kg = opts.knowledgeGraph
    this.llmCall = opts.llmCall
    this.dataFetch = opts.dataFetch
  }

  /**
   * Run a single agent: load prompt → build context → call LLM → parse output → write knowledge.
   */
  async run(
    agent: AgentConfig,
    weight: number,
    upstreamContext?: LayerSynthesis[],
  ): Promise<Envelope> {
    const startTime = Date.now()

    // 1. Load prompt
    const prompt = await loadPrompt(this.departmentId, agent.prompt_file)
    if (!prompt) {
      return this.buildFallbackEnvelope(agent, weight, 'Prompt file not found')
    }

    // 2. Fetch data
    let dataContext = ''
    try {
      dataContext = await this.dataFetch(agent, this.departmentId)
    } catch (err) {
      console.warn(`atlas: data fetch failed for ${agent.name}:`, err)
    }

    // 3. Knowledge context
    let knowledgeContext = ''
    if (agent.knowledge_links.length > 0) {
      try {
        const notes = await this.kg.readNotesWithLinks(agent.knowledge_links, 8, 2, 4)
        knowledgeContext = this.kg.formatContext(notes)
      } catch (err) {
        console.warn(`atlas: knowledge read failed for ${agent.name}:`, err)
      }
    }

    // 4. Upstream context
    let upstreamStr = ''
    if (upstreamContext && upstreamContext.length > 0) {
      upstreamStr = upstreamContext.map(formatSynthesisContext).join('\n\n')
    }

    // 5. Assemble full prompt
    const outputSchema = agent.layer === 'L4' ? L4_OUTPUT_SCHEMA : STANDARD_OUTPUT_SCHEMA
    const fullPrompt = assemblePrompt(prompt, dataContext, knowledgeContext, upstreamStr, outputSchema)

    // 6. Call LLM
    const model = resolveModel(this.config, agent.model_tier)
    let rawResponse: string
    try {
      rawResponse = await this.llmCall(fullPrompt, model)
    } catch (err) {
      console.warn(`atlas: LLM call failed for ${agent.name}:`, err)
      return this.buildFallbackEnvelope(agent, weight, `LLM error: ${err}`)
    }

    // 7. Parse output
    let output
    try {
      output = parseAgentOutput(rawResponse)
    } catch (err) {
      console.warn(`atlas: parse failed for ${agent.name}:`, err)
      return this.buildFallbackEnvelope(agent, weight, `Parse error: ${err}`)
    }

    // 8. Write knowledge updates
    if (output.knowledge_updates.length > 0) {
      try {
        await this.kg.writeUpdatesFromEnvelope(agent.name, output.knowledge_updates as KnowledgeUpdate[])
      } catch (err) {
        console.warn(`atlas: knowledge write failed for ${agent.name}:`, err)
      }
    }

    // 9. Build envelope
    const elapsed = Date.now() - startTime
    console.log(`atlas: ${agent.display_name} completed in ${elapsed}ms`)

    return buildEnvelope(agent.name, agent.display_name, agent.layer, output, weight) as Envelope
  }

  private buildFallbackEnvelope(agent: AgentConfig, weight: number, reason: string): Envelope {
    return {
      agent: agent.name,
      display_name: agent.display_name,
      layer: agent.layer,
      signal: { direction: 'NEUTRAL', conviction: 0, targets: [], positions: [] },
      reasoning: {
        summary: reason,
        key_factors: [],
        data_used: [],
        caveats: 'Agent failed to produce valid output',
      },
      knowledge_updates: [],
      weight,
      timestamp: new Date().toISOString(),
    }
  }
}

// ==================== Prompt Assembly ====================

function assemblePrompt(
  agentPrompt: string,
  dataContext: string,
  knowledgeContext: string,
  upstreamContext: string,
  outputSchema: string,
): string {
  const parts: string[] = [agentPrompt]

  if (knowledgeContext) {
    parts.push('\n\n## Knowledge Graph Notes\n' + knowledgeContext)
  }

  if (upstreamContext) {
    parts.push('\n\n## Upstream Analysis\n' + upstreamContext)
  }

  if (dataContext) {
    parts.push('\n\n## Current Market Data\n' + dataContext)
  }

  parts.push('\n\n' + outputSchema)

  return parts.join('')
}

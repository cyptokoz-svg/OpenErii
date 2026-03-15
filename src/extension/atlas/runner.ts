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
## 输出格式
重要：你的全部回复必须是一个JSON对象。不要在JSON前后添加任何文字、解释或评论。不要以"我"、"基于"、"I"或任何其他文字开头。所有文本字段请用中文填写。只输出以下JSON结构：
{
  "signal": {
    "direction": "BULLISH 或 BEARISH 或 NEUTRAL",
    "conviction": 1-100,
    "targets": ["相关标的代码"]
  },
  "reasoning": {
    "summary": "一句话中文总结",
    "key_factors": ["因素1", "因素2"],
    "data_used": ["使用的数据源"],
    "caveats": "需要关注的关键风险"
  },
  "knowledge_updates": [
    {
      "file": "filename.md",
      "type": "insight | event | lesson | pattern | seasonal",
      "content": "用中文描述新发现，包含[[概念]]链接"
    }
  ]
}`.trim()

const L4_OUTPUT_SCHEMA = `
## 标的代码参考
CL=F:WTI原油  BZ=F:布伦特  NG=F:天然气  GC=F:黄金  SI=F:白银
HG=F:铜  ZW=F:小麦  ZC=F:玉米  ZS=F:大豆
KC=F:咖啡  SB=F:糖  LE=F:活牛  HE=F:瘦肉猪

## 输出格式
重要：你的全部回复必须是一个JSON对象。不要在JSON前后添加任何文字、解释或评论。不要以"我"、"基于"、"I"或任何其他文字开头。所有文本字段请用中文填写。只输出以下JSON结构：
{
  "signal": {
    "direction": "BULLISH 或 BEARISH 或 NEUTRAL",
    "conviction": 1-100,
    "targets": ["CL=F"],
    "positions": [
      {
        "ticker": "CL=F",
        "name": "WTI原油",
        "direction": "long 或 short",
        "size_pct": 5.0,
        "entry_price": 82.50,
        "entry_zone": [80.0, 83.5],
        "stop_loss": 77.0,
        "take_profit": [88.0, 93.0],
        "rationale": "简要中文理由"
      }
    ]
  },
  "reasoning": {
    "summary": "最终决策中文总结",
    "key_factors": ["因素1", "因素2"],
    "data_used": ["数据源"],
    "caveats": "关键风险"
  },
  "knowledge_updates": []
}`.trim()

// ==================== Types ====================

/** Function that calls the LLM and returns text response. */
export type LLMCallFn = (prompt: string, model: string, abortSignal?: AbortSignal) => Promise<string>

/** Function that fetches data for an agent. */
export type DataFetchFn = (agent: AgentConfig, departmentId: string) => Promise<string>

export interface RunnerConfig {
  atlasConfig: AtlasConfig
  departmentId: string
  knowledgeGraph: KnowledgeGraph
  llmCall: LLMCallFn
  dataFetch: DataFetchFn
  /** Override prompt directory (backtest isolation) */
  promptDir?: string
}

// ==================== Runner ====================

export class AgentRunner {
  private config: AtlasConfig
  private departmentId: string
  private kg: KnowledgeGraph
  private llmCall: LLMCallFn
  private dataFetch: DataFetchFn
  private promptDir?: string

  constructor(opts: RunnerConfig) {
    this.config = opts.atlasConfig
    this.departmentId = opts.departmentId
    this.kg = opts.knowledgeGraph
    this.llmCall = opts.llmCall
    this.dataFetch = opts.dataFetch
    this.promptDir = opts.promptDir
  }

  /**
   * Run a single agent: load prompt → build context → call LLM → parse output → write knowledge.
   */
  async run(
    agent: AgentConfig,
    weight: number,
    upstreamContext?: LayerSynthesis[],
    abortSignal?: AbortSignal,
  ): Promise<Envelope> {
    const startTime = Date.now()

    // 1. Load prompt (use promptDir override if set, e.g. during backtest)
    const prompt = this.promptDir
      ? await loadPrompt(this.promptDir, agent.prompt_file, true)
      : await loadPrompt(this.departmentId, agent.prompt_file)
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
      rawResponse = await this.llmCall(fullPrompt, model, abortSignal)
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

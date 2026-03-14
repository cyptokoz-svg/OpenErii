/**
 * Atlas Pipeline — L1→L2→L3→L4 orchestration
 *
 * Ported from ATLAS-Commodity's pipeline.py.
 * Runs agents per layer with concurrency control,
 * synthesizes results, and produces a final AtlasReport.
 */

import type {
  AgentConfig,
  AtlasConfig,
  AtlasReport,
  AtlasRunOpts,
  DepartmentConfig,
  Envelope,
  Layer,
  LayerSynthesis,
  PipelineCallbacks,
} from './types.js'
import { LAYERS } from './types.js'
import { loadDepartmentAgents } from './config.js'
import { AgentRunner, type LLMCallFn, type DataFetchFn } from './runner.js'
import { synthesizeLayer } from './synthesizer.js'
import { KnowledgeGraph } from './knowledge.js'
import { Scorecard } from './scorecard.js'

// ==================== Types ====================

export interface PipelineConfig {
  atlasConfig: AtlasConfig
  llmCall: LLMCallFn
  dataFetch: DataFetchFn
  shouldRunAgent: (agent: AgentConfig, departmentId: string) => Promise<boolean>
  callbacks?: PipelineCallbacks
}

// ==================== Pipeline ====================

export class AtlasPipeline {
  private config: AtlasConfig
  private llmCall: LLMCallFn
  private dataFetch: DataFetchFn
  private shouldRunAgent: (agent: AgentConfig, departmentId: string) => Promise<boolean>
  private callbacks: PipelineCallbacks

  // Per-department state
  private scorecards: Map<string, Scorecard> = new Map()
  private knowledgeGraphs: Map<string, KnowledgeGraph> = new Map()
  private lastRunTimestamps: Map<string, string> = new Map()

  constructor(config: PipelineConfig) {
    this.config = config.atlasConfig
    this.llmCall = config.llmCall
    this.dataFetch = config.dataFetch
    this.shouldRunAgent = config.shouldRunAgent
    this.callbacks = config.callbacks ?? {}
  }

  /** Get or create scorecard for a department. */
  getScorecard(departmentId: string): Scorecard {
    let sc = this.scorecards.get(departmentId)
    if (!sc) {
      sc = new Scorecard(departmentId, this.config)
      this.scorecards.set(departmentId, sc)
    }
    return sc
  }

  /** Get or create knowledge graph for a department. */
  getKnowledgeGraph(departmentId: string): KnowledgeGraph {
    let kg = this.knowledgeGraphs.get(departmentId)
    if (!kg) {
      const { getKnowledgeVaultPath } = require('./config.js')
      kg = new KnowledgeGraph(getKnowledgeVaultPath(departmentId))
      this.knowledgeGraphs.set(departmentId, kg)
    }
    return kg
  }

  // ==================== Main Run ====================

  async run(opts: AtlasRunOpts): Promise<AtlasReport> {
    const startTime = Date.now()
    const { department, agents, kg, scorecard, weights, runner } = await this.preparePipeline(opts)

    const { layerResults, allEnvelopes, skippedAgents, totalCalls, skippedCalls } =
      await this.executeLayers(agents, runner, weights, department.id, opts.skip_layers)

    const report = await this.buildReport(
      opts.department, layerResults, allEnvelopes, skippedAgents,
      totalCalls, skippedCalls, scorecard,
    )

    this.lastRunTimestamps.set(opts.department, report.timestamp)
    await this.callbacks.onReportComplete?.(report)

    const elapsed = Date.now() - startTime
    console.log(`atlas: ${opts.department} pipeline completed in ${elapsed}ms (${totalCalls - skippedCalls} LLM calls)`)

    return report
  }

  /** Validate opts, load department agents, init knowledge graph and scorecard. */
  private async preparePipeline(opts: AtlasRunOpts) {
    const department = this.config.departments.find((d) => d.id === opts.department)
    if (!department) throw new Error(`atlas: department "${opts.department}" not found`)
    if (!department.enabled) throw new Error(`atlas: department "${opts.department}" is disabled`)

    const agents = await loadDepartmentAgents(department)
    if (agents.length === 0) throw new Error(`atlas: no enabled agents in "${opts.department}"`)

    const kg = this.getKnowledgeGraph(department.id)
    await kg.init()

    const scorecard = this.getScorecard(department.id)
    await scorecard.load()
    const weights = scorecard.getAllWeights()

    const runner = new AgentRunner({
      atlasConfig: this.config,
      departmentId: department.id,
      knowledgeGraph: kg,
      llmCall: this.llmCall,
      dataFetch: this.dataFetch,
    })

    return { department, agents, kg, scorecard, weights, runner }
  }

  /** Execute L1→L4 in sequence, each layer's agents run concurrently (except L4). */
  private async executeLayers(
    agents: AgentConfig[],
    runner: AgentRunner,
    weights: Record<string, number>,
    departmentId: string,
    skipLayersList?: Layer[],
  ) {
    const skipLayers = new Set(skipLayersList ?? [])
    const layerResults: Partial<Record<Layer, LayerSynthesis>> = {}
    const allEnvelopes: Envelope[] = []
    const skippedAgents: string[] = []
    let totalCalls = 0
    let skippedCalls = 0
    const upstreamContext: LayerSynthesis[] = []

    for (const layer of LAYERS) {
      if (skipLayers.has(layer)) continue
      const layerAgents = agents.filter((a) => a.layer === layer)
      if (layerAgents.length === 0) continue

      const envelopes = await this.runLayer(
        layer, layerAgents, runner, weights, departmentId, upstreamContext, skippedAgents,
      )

      totalCalls += layerAgents.length
      skippedCalls += layerAgents.length - envelopes.length + skippedAgents.length
      allEnvelopes.push(...envelopes)

      const synthesis = synthesizeLayer(layer, envelopes)
      layerResults[layer] = synthesis
      upstreamContext.push(synthesis)
      await this.callbacks.onLayerComplete?.(synthesis)
    }

    return { layerResults, allEnvelopes, skippedAgents, totalCalls, skippedCalls }
  }

  /** Assemble final report from layer results + scorecard data. */
  private async buildReport(
    departmentId: string,
    layerResults: Partial<Record<Layer, LayerSynthesis>>,
    allEnvelopes: Envelope[],
    skippedAgents: string[],
    totalCalls: number,
    skippedCalls: number,
    scorecard: Scorecard,
  ): Promise<AtlasReport> {
    // Record signals
    for (const env of allEnvelopes) {
      scorecard.recordSignal(
        env.agent, env.signal.direction, env.signal.conviction,
        env.signal.targets, new Date().toISOString().slice(0, 10),
      )
    }
    await scorecard.save()

    const agentScores = scorecard.getAllScores()
    const sorted = [...agentScores].sort((a, b) => b.weight - a.weight)
    const l4 = layerResults.L4
    const finalSignal = l4 ?? layerResults.L3 ?? layerResults.L2 ?? layerResults.L1

    const positions = l4?.envelopes
      .flatMap((e) => e.signal.positions)
      .filter((p) => p.size_pct > 0) ?? []

    return {
      department: departmentId,
      timestamp: new Date().toISOString(),
      direction: finalSignal?.direction ?? 'NEUTRAL',
      conviction: finalSignal?.conviction ?? 0,
      positions,
      summary: finalSignal?.summary ?? 'No analysis produced',
      layers: { l1: layerResults.L1, l2: layerResults.L2, l3: layerResults.L3, l4: layerResults.L4 },
      confidence: {
        layer_agreement: this.computeLayerAgreement(layerResults),
        historical_accuracy: scorecard.getOverallAccuracy(),
        top_agent: sorted[0]?.agent ?? 'unknown',
        worst_agent: sorted[sorted.length - 1]?.agent ?? 'unknown',
      },
      skipped_agents: skippedAgents,
      cost_estimate: { total_calls: totalCalls, skipped_calls: skippedCalls },
    }
  }

  /** Get last run timestamp for a department. */
  getLastRunTimestamp(departmentId: string): string | undefined {
    return this.lastRunTimestamps.get(departmentId)
  }

  // ==================== Layer Execution ====================

  private async runLayer(
    layer: Layer,
    agents: AgentConfig[],
    runner: AgentRunner,
    weights: Record<string, number>,
    departmentId: string,
    upstreamContext: LayerSynthesis[],
    skippedAgents: string[],
  ): Promise<Envelope[]> {
    const maxConcurrency = this.config.max_concurrency
    const envelopes: Envelope[] = []

    // Determine which agents to run
    const toRun: AgentConfig[] = []
    for (const agent of agents) {
      const shouldRun = await this.shouldRunAgent(agent, departmentId)
      if (shouldRun) {
        toRun.push(agent)
      } else {
        skippedAgents.push(agent.name)
      }
    }

    // L4 runs sequentially (CRO → PM → Devil's Advocate → CIO)
    if (layer === 'L4') {
      for (const agent of toRun) {
        const weight = weights[agent.name] ?? 1.0
        const envelope = await runner.run(agent, weight, upstreamContext)
        envelopes.push(envelope)
        await this.callbacks.onAgentComplete?.(agent, envelope)
      }
      return envelopes
    }

    // L1/L2/L3 run concurrently with concurrency limit
    const chunks = chunkArray(toRun, maxConcurrency)
    for (const chunk of chunks) {
      const results = await Promise.all(
        chunk.map(async (agent) => {
          const weight = weights[agent.name] ?? 1.0
          const envelope = await runner.run(agent, weight, upstreamContext)
          await this.callbacks.onAgentComplete?.(agent, envelope)
          return envelope
        }),
      )
      envelopes.push(...results)
    }

    return envelopes
  }

  // ==================== Helpers ====================

  private computeLayerAgreement(
    results: Partial<Record<Layer, LayerSynthesis>>,
  ): number {
    const layers = Object.values(results).filter(Boolean) as LayerSynthesis[]
    if (layers.length <= 1) return 100

    const directions = layers.map((l) => l.direction)
    const majority = directions.sort(
      (a, b) =>
        directions.filter((d) => d === b).length -
        directions.filter((d) => d === a).length,
    )[0]

    const agreeing = directions.filter((d) => d === majority).length
    return Math.round((agreeing / directions.length) * 100)
  }
}

// ==================== Utils ====================

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

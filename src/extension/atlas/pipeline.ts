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
import { loadDepartmentAgents, getKnowledgeVaultPath } from './config.js'
import { AgentRunner, type LLMCallFn, type DataFetchFn } from './runner.js'
import { synthesizeLayer } from './synthesizer.js'
import { KnowledgeGraph } from './knowledge.js'
import { Scorecard } from './scorecard.js'
import { FreshnessTracker } from './freshness.js'

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
  private freshnessTrackers: Map<string, FreshnessTracker> = new Map()
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
      kg = new KnowledgeGraph(getKnowledgeVaultPath(departmentId))
      this.knowledgeGraphs.set(departmentId, kg)
    }
    return kg
  }

  /** Get or create freshness tracker for a department. */
  getFreshnessTracker(departmentId: string): FreshnessTracker {
    let ft = this.freshnessTrackers.get(departmentId)
    if (!ft) {
      ft = new FreshnessTracker(departmentId)
      this.freshnessTrackers.set(departmentId, ft)
    }
    return ft
  }

  // ==================== Main Run ====================

  async run(opts: AtlasRunOpts): Promise<AtlasReport> {
    const startTime = Date.now()
    const { department, agents, kg, scorecard, weights, runner, freshness } = await this.preparePipeline(opts)

    const { layerResults, allEnvelopes, skippedAgents, totalCalls, skippedCalls } =
      await this.executeLayers(agents, runner, weights, department.id, opts.skip_layers, freshness)

    const report = await this.buildReport(
      opts.department, layerResults, allEnvelopes, skippedAgents,
      totalCalls, skippedCalls, scorecard,
    )

    this.lastRunTimestamps.set(opts.department, report.timestamp)

    // Knowledge Graph GC: trim stale notes to prevent vault bloat
    try {
      const gcResult = await kg.gc()
      if (gcResult.trimmed > 0) {
        console.log(`atlas: KG GC — trimmed ${gcResult.trimmed} stale entries, archived ${gcResult.archived}`)
      }
    } catch (err) {
      console.warn('atlas: KG GC failed:', err)
    }

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

    const freshness = this.getFreshnessTracker(department.id)
    await freshness.init()

    const runner = new AgentRunner({
      atlasConfig: this.config,
      departmentId: department.id,
      knowledgeGraph: kg,
      llmCall: this.llmCall,
      dataFetch: this.dataFetch,
    })

    return { department, agents, kg, scorecard, weights, runner, freshness }
  }

  /**
   * Execute L1→L4 with IO-overlapping prefetch.
   *
   * While L(N) agents are running LLM calls, we prefetch data for L(N+1)
   * agents in parallel. This hides data-fetch latency behind LLM wait time.
   *
   * Flow:
   *   prefetch L1 data → run L1 LLM (while prefetching L2 data)
   *                     → run L2 LLM (while prefetching L3 data)
   *                     → run L3 LLM → run L4 LLM
   */
  private async executeLayers(
    agents: AgentConfig[],
    runner: AgentRunner,
    weights: Record<string, number>,
    departmentId: string,
    skipLayersList?: Layer[],
    freshness?: FreshnessTracker,
  ) {
    const skipLayers = new Set(skipLayersList ?? [])
    const layerResults: Partial<Record<Layer, LayerSynthesis>> = {}
    const allEnvelopes: Envelope[] = []
    const skippedAgents: string[] = []
    let totalCalls = 0
    let skippedCalls = 0
    const upstreamContext: LayerSynthesis[] = []

    // Data cache: prefetched data stored here for runner to use
    const dataCache = new Map<string, string>()

    // Get active layers in order
    const activeLayers = LAYERS.filter((l) => !skipLayers.has(l))
    const layerAgentsMap = new Map<Layer, AgentConfig[]>()
    for (const layer of activeLayers) {
      const la = agents.filter((a) => a.layer === layer)
      if (la.length > 0) layerAgentsMap.set(layer, la)
    }
    const layersToRun = activeLayers.filter((l) => layerAgentsMap.has(l))

    // Prefetch data for a set of agents (non-blocking)
    const prefetchData = async (layerAgents: AgentConfig[]): Promise<void> => {
      await Promise.all(
        layerAgents.map(async (agent) => {
          const key = `${departmentId}:${agent.name}`
          if (dataCache.has(key)) return
          try {
            const data = await this.dataFetch(agent, departmentId)
            dataCache.set(key, data)
          } catch (err) {
            console.warn(`atlas: prefetch failed for ${agent.name}:`, err)
            dataCache.set(key, `⚠️ Data prefetch error: ${err}`)
          }
        }),
      )
    }

    // Create a data fetch function that reads from cache first
    const cachedDataFetch: DataFetchFn = async (agent, deptId) => {
      const key = `${deptId}:${agent.name}`
      if (dataCache.has(key)) return dataCache.get(key)!
      // Fallback to live fetch if not cached
      return this.dataFetch(agent, deptId)
    }

    // Create a runner that uses cached data
    const cachedRunner = new AgentRunner({
      atlasConfig: this.config,
      departmentId,
      knowledgeGraph: this.getKnowledgeGraph(departmentId),
      llmCall: this.llmCall,
      dataFetch: cachedDataFetch,
    })

    // Prefetch first layer's data before starting
    if (layersToRun.length > 0) {
      const firstLayerAgents = layerAgentsMap.get(layersToRun[0])!
      await prefetchData(firstLayerAgents)
    }

    for (let i = 0; i < layersToRun.length; i++) {
      const layer = layersToRun[i]
      const layerAgents = layerAgentsMap.get(layer)!

      // Start prefetching NEXT layer's data while current layer runs LLM
      let prefetchPromise: Promise<void> | undefined
      if (i + 1 < layersToRun.length) {
        const nextLayerAgents = layerAgentsMap.get(layersToRun[i + 1])!
        prefetchPromise = prefetchData(nextLayerAgents)
      }

      // Run current layer (with envelope caching + L4 staged injection)
      const skippedBefore = skippedAgents.length
      const envelopes = await this.runLayer(
        layer, layerAgents, cachedRunner, weights, departmentId, upstreamContext, skippedAgents, freshness,
      )

      totalCalls += layerAgents.length
      const newlySkipped = skippedAgents.length - skippedBefore
      skippedCalls += newlySkipped
      allEnvelopes.push(...envelopes)

      const synthesis = synthesizeLayer(layer, envelopes)
      layerResults[layer] = synthesis
      upstreamContext.push(synthesis)
      await this.callbacks.onLayerComplete?.(synthesis, departmentId)

      // Ensure prefetch completed before moving to next layer
      if (prefetchPromise) await prefetchPromise
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
    freshness?: FreshnessTracker,
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

    /**
     * L4 runs sequentially with STAGED CONTEXT INJECTION:
     *   CRO runs with base context (regime + L3 signals)
     *   PM  runs with base context + CRO output
     *   Devil's Advocate runs with base context + CRO + PM output
     *   CIO runs with base context + CRO + PM + Devil output
     *
     * Each subsequent agent sees all prior L4 outputs → better decisions.
     */
    if (layer === 'L4') {
      const l4Envelopes: Envelope[] = []
      for (const agent of toRun) {
        const weight = weights[agent.name] ?? 1.0
        // Build staged context: upstream (L1-L3) + all prior L4 envelopes
        const stagedContext = [...upstreamContext]
        if (l4Envelopes.length > 0) {
          // Inject prior L4 outputs as a synthetic synthesis
          const l4Prior: LayerSynthesis = {
            layer: 'L4',
            direction: l4Envelopes[l4Envelopes.length - 1].signal.direction,
            conviction: l4Envelopes[l4Envelopes.length - 1].signal.conviction,
            agreement_ratio: 100,
            envelopes: l4Envelopes,
            dissent: [],
            summary: l4Envelopes.map((e) =>
              `[${e.display_name}] ${e.reasoning.summary}`
            ).join(' | '),
          }
          stagedContext.push(l4Prior)
        }
        const envelope = await runner.run(agent, weight, stagedContext)
        l4Envelopes.push(envelope)
        envelopes.push(envelope)
        // Cache L4 envelopes too
        if (freshness) await freshness.saveEnvelope(agent.name, envelope)
        await this.callbacks.onAgentComplete?.(agent, envelope, departmentId)
      }
      return envelopes
    }

    // L1/L2/L3 run concurrently with concurrency limit + envelope caching
    const chunks = chunkArray(toRun, maxConcurrency)
    for (const chunk of chunks) {
      const results = await Promise.all(
        chunk.map(async (agent) => {
          const weight = weights[agent.name] ?? 1.0

          // Check freshness: can we serve cached envelope?
          if (freshness) {
            const needsRerun = freshness.shouldAgentRerun(
              agent.name, agent.data_sources, {},
            )
            if (!needsRerun) {
              const cached = await freshness.loadEnvelope(agent.name)
              if (cached) {
                await this.callbacks.onAgentComplete?.(agent, cached, departmentId)
                return cached
              }
            }
          }

          const envelope = await runner.run(agent, weight, upstreamContext)

          // Cache the envelope for next run
          if (freshness) await freshness.saveEnvelope(agent.name, envelope)

          await this.callbacks.onAgentComplete?.(agent, envelope, departmentId)
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

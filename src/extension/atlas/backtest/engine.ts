/**
 * Walk-Forward Backtest Engine
 *
 * Replays department history day by day:
 *   1. Set simulated date → fetch historical data
 *   2. Run L1→L4 pipeline → generate signals
 *   3. Score 5+ day old signals with actual returns
 *   4. Update Darwinian weights
 *   5. (Optional) Trigger AutoResearch evolution
 *   6. Record equity curve + checkpoint state
 *
 * Uses existing AtlasPipeline with injected HistoricalDataBridge.
 */

import type { BacktestConfig, BacktestState, BacktestResult, DayResult } from './types.js'
import type { AtlasConfig, AgentConfig, SignalRecord, EvolutionEntry } from '../types.js'
import { AtlasPipeline, type PipelineConfig } from '../pipeline.js'
import { HistoricalDataBridge, type HistoricalBridgeDeps } from './historical-bridge.js'
import { GdeltFetcher } from './gdelt.js'
import { Scorecard } from '../scorecard.js'
import { KnowledgeGraph } from '../knowledge.js'
import { AutoResearch } from '../autoresearch.js'
import { loadDepartmentAgents, getDepartmentDataDir } from '../config.js'
import { computePortfolioMetrics, computeEquityCurve, computeAgentAttribution } from './metrics.js'
import {
  saveState, loadState, appendDayResult, loadDayResults,
  saveResult, loadResult, generateRunId,
} from './state.js'
import type { LLMCallFn } from '../runner.js'
import type { DataBridgeDeps } from '../data-bridge.js'
import { resolve } from 'path'
import { readFile, writeFile, mkdir, readdir, cp } from 'fs/promises'

// ==================== Types ====================

export interface WalkForwardDeps {
  atlasConfig: AtlasConfig
  llmCall: LLMCallFn
  dataBridgeDeps: DataBridgeDeps
  /** Callback for progress updates (SSE push) */
  onProgress?: (state: BacktestState) => void
  /** Callback for each completed day */
  onDayComplete?: (day: DayResult) => void
}

// ==================== Engine ====================

export class WalkForwardEngine {
  private deps: WalkForwardDeps
  private abortController: AbortController | null = null

  constructor(deps: WalkForwardDeps) {
    this.deps = deps
  }

  // ==================== Main Entry ====================

  /**
   * Start a new backtest run or resume an existing one.
   */
  async run(config: BacktestConfig, opts?: { resumeId?: string; runId?: string }): Promise<BacktestResult> {
    const { atlasConfig, llmCall, dataBridgeDeps } = this.deps
    this.abortController = new AbortController()

    // Merge model tiers: backtest overrides take precedence
    const effectiveConfig = { ...atlasConfig }
    if (config.model_tiers) {
      effectiveConfig.model_tiers = { ...atlasConfig.model_tiers, ...config.model_tiers }
    }

    // Calculate trading days
    const allDays = this.tradingDays(config.startDate, config.endDate)
    if (!config.step || config.step <= 0) throw new Error('step must be > 0')
    const stepDays = allDays.filter((_, i) => i % config.step === 0)
    if (stepDays.length === 0) throw new Error('No trading days in date range')

    // Load or create state
    let state: BacktestState
    let completedDays: DayResult[] = []
    const resumeId = opts?.resumeId
    const runId = resumeId ?? opts?.runId ?? generateRunId()

    if (resumeId) {
      const existing = await loadState(config.department, resumeId)
      if (!existing) throw new Error(`Backtest run ${resumeId} not found`)
      state = existing
      completedDays = await loadDayResults(config.department, resumeId)
    } else {
      state = {
        id: runId,
        config,
        status: 'preparing',
        currentDate: config.startDate,
        progress: 0,
        days_completed: 0,
        days_total: stepDays.length,
        started_at: new Date().toISOString(),
        elapsed_ms: 0,
      }
    }

    // Setup isolated backtest state directory
    const backtestStateDir = resolve('data/atlas', config.department, 'backtest/runs', runId)
    await mkdir(backtestStateDir, { recursive: true })

    // Load department agents first (needed for prompt copy and symbol extraction)
    const dept = effectiveConfig.departments.find((d) => d.id === config.department)
    if (!dept) throw new Error(`Department ${config.department} not found`)
    const agents = await loadDepartmentAgents(dept)

    // Copy prompts to isolated directory (so evolution doesn't pollute production)
    const prodDataDir = getDepartmentDataDir(config.department)
    const promptDir = resolve(backtestStateDir, 'prompts_mirror')
    await this.copyPrompts(prodDataDir, promptDir, agents)

    // Seed from previous run if specified
    if (config.seedRunId && !resumeId) {
      const seedDir = resolve('data/atlas', config.department, 'backtest/runs', config.seedRunId)
      await this.seedFromRun(seedDir, backtestStateDir, promptDir)
      console.log(`backtest: seeded from previous run ${config.seedRunId}`)
    }

    // Create isolated scorecard (separate from production)
    const scorecard = new Scorecard(config.department, effectiveConfig)
    // Override scorecard paths to backtest dir
    ;(scorecard as any).weightsFile = resolve(backtestStateDir, 'weights.json')
    ;(scorecard as any).scoresFile = resolve(backtestStateDir, 'scores.json')
    await scorecard.load()

    // Create isolated knowledge graph (or null if disabled)
    let knowledgeGraph: KnowledgeGraph | undefined
    if (!config.disable_knowledge) {
      const kgPath = resolve(backtestStateDir, 'knowledge')
      knowledgeGraph = new KnowledgeGraph(kgPath, 30, [])
      await knowledgeGraph.init()
    }

    // Setup GDELT fetcher
    const gdelt = new GdeltFetcher(config.department, config.gdelt_keywords, config.bigquery_project)

    // Extract all symbols used by agents
    const allSymbols = agents
      .flatMap((a) => a.data_sources)
      .filter((ds) => ds.type === 'price')
      .flatMap((ds) => ds.symbols ?? [])

    // Setup historical data bridge (with NewsRouter for layer-aware news routing)
    const historicalBridge = new HistoricalDataBridge({
      fetchPrice: dataBridgeDeps.fetchPrice,
      fetchMacro: dataBridgeDeps.fetchMacro,
      clients: dataBridgeDeps.clients ?? {},
      gdelt,
      llmCall,
    })

    // Pre-download phase
    state.status = 'downloading'
    await saveState(config.department, state)
    this.deps.onProgress?.(state)

    // Download GDELT news (this can take a while)
    console.log(`backtest: downloading GDELT news for ${config.startDate} → ${config.endDate}`)
    await gdelt.download(config.startDate, config.endDate, (done, total) => {
      state.progress = Math.round((done / total) * 10) // 0-10% for download
      this.deps.onProgress?.(state)
    })

    // Pre-load price data
    console.log(`backtest: preloading ${allSymbols.length} price symbols`)
    await historicalBridge.preloadPrices(allSymbols)

    // Setup pipeline with historical data + isolated prompt directory
    const pipelineConfig: PipelineConfig = {
      atlasConfig: effectiveConfig,
      llmCall,
      dataFetch: async (agent: AgentConfig, deptId: string) => {
        return historicalBridge.fetchForAgent(agent, deptId)
      },
      shouldRunAgent: async () => true, // Always run in backtest
      fetchReturn: async (ticker: string, date: string, days: number) => {
        return historicalBridge.getForwardReturn(ticker, date, days)
      },
      promptDir,
    }

    // Override pipeline internals to use isolated state
    const pipeline = new AtlasPipeline(pipelineConfig)
    // Inject isolated scorecard
    ;(pipeline as any).scorecards.set(config.department, scorecard)
    if (knowledgeGraph) {
      ;(pipeline as any).knowledgeGraphs.set(config.department, knowledgeGraph)
    }
    // Disable freshness tracking in backtest
    ;(pipeline as any).freshnessTrackers.set(config.department, {
      init: async () => {},
      shouldAgentRerunWithData: () => true,
      loadEnvelope: async () => null,
      saveEnvelope: async () => {},
      markAgentDataSeen: () => {},
      persistState: async () => {},
    })

    // AutoResearch (optional)
    let autoResearch: AutoResearch | undefined
    const evolutionLog: EvolutionEntry[] = []
    if (!config.disable_evolution) {
      autoResearch = new AutoResearch(config.department, effectiveConfig, scorecard, llmCall, {
        logFile: resolve(backtestStateDir, 'evolution_log.json'),
        promptDir,
      })
      await autoResearch.load()
    }

    // Weight history tracking
    const weightHistory: Array<{ date: string; weights: Record<string, number> }> = []

    // ==================== Main Simulation Loop ====================

    state.status = 'running'
    const startIdx = resumeId ? completedDays.length : 0
    const startTime = Date.now()
    const resumedElapsed = state.elapsed_ms ?? 0
    let prevScoredTotal = 0

    console.log(`backtest: starting walk-forward from ${stepDays[startIdx]} (${stepDays.length - startIdx} days remaining)`)

    for (let i = startIdx; i < stepDays.length; i++) {
      if (this.abortController.signal.aborted) {
        state.status = 'paused'
        break
      }

      const date = stepDays[i]
      historicalBridge.simulatedDate = date

      try {
        // Run pipeline for this day (pass dateOverride so signals are recorded with simulated date)
        const report = await pipeline.run({
          department: config.department,
          skip_layers: config.skip_layers,
          abortSignal: this.abortController.signal,
          dateOverride: date,
        })

        // Collect day result
        const weights = scorecard.getAllWeights()
        const dayResult: DayResult = {
          date,
          direction: report.direction,
          conviction: report.conviction,
          signals_generated: report.cost_estimate.total_calls - report.cost_estimate.skipped_calls,
          signals_scored: (() => {
            const total = scorecard.getAllScores().reduce((sum, s) => sum + s.scored_signals, 0)
            const delta = total - prevScoredTotal
            prevScoredTotal = total
            return delta
          })(),
          weight_snapshot: { ...weights },
          positions: report.positions.map((p) => ({
            ticker: p.ticker,
            direction: p.direction,
            size_pct: p.size_pct,
          })),
        }

        // Track weights
        weightHistory.push({ date, weights: { ...weights } })

        // Try evolution every simulation day (same as live)
        if (autoResearch) autoResearch.setReferenceDate(date)
        if (autoResearch && i > 0) {
          try {
            const evoResult = await autoResearch.runOnce()
            if (evoResult.action === 'started' || evoResult.action === 'evaluated') {
              dayResult.evolution_triggered = evoResult.agent
              const log = autoResearch.getLog()
              evolutionLog.length = 0
              evolutionLog.push(...log)
            }
          } catch (err) {
            console.warn(`backtest: evolution failed on ${date}:`, err)
          }
        }

        // Save day result
        completedDays.push(dayResult)
        await appendDayResult(config.department, runId, dayResult)

        // Update state
        state.currentDate = date
        state.days_completed = i + 1
        state.progress = 10 + Math.round(((i + 1) / stepDays.length) * 90)
        state.elapsed_ms = Date.now() - startTime + resumedElapsed
        await saveState(config.department, state)

        this.deps.onProgress?.(state)
        this.deps.onDayComplete?.(dayResult)

        console.log(`backtest: ${date} done (${i + 1}/${stepDays.length}) — ${report.direction} conv=${report.conviction}`)
      } catch (err) {
        console.error(`backtest: error on ${date}:`, err)
        state.status = 'failed'
        state.error = String(err)
        await saveState(config.department, state)
        throw err
      }
    }

    // ==================== Finalize ====================

    if (state.status === 'running') {
      state.status = 'completed'
    }
    state.progress = state.status === 'completed' ? 100 : state.progress
    state.elapsed_ms = Date.now() - startTime + resumedElapsed
    await saveState(config.department, state)

    // Collect all signals from scorecard
    const allSignals: SignalRecord[] = []
    const scores = scorecard.getAllScores()
    // Read scores.json directly for full signal records
    try {
      const raw = await readFile(resolve(backtestStateDir, 'scores.json'), 'utf-8')
      const signalData = JSON.parse(raw) as Record<string, SignalRecord[]>
      for (const records of Object.values(signalData)) {
        allSignals.push(...records)
      }
    } catch {
      // No signals recorded
    }

    // Compute final metrics
    const metrics = computePortfolioMetrics(allSignals, config.initialCapital)
    const equityCurve = computeEquityCurve(completedDays, allSignals, config.initialCapital)
    const agentAttribution = computeAgentAttribution(allSignals, weightHistory, evolutionLog)

    const result: BacktestResult = {
      id: runId,
      config,
      status: state.status,
      equity_curve: equityCurve,
      metrics,
      agent_attribution: agentAttribution,
      weight_history: weightHistory,
      evolution_log: evolutionLog,
      days: completedDays,
      started_at: state.started_at,
      completed_at: new Date().toISOString(),
      elapsed_ms: state.elapsed_ms,
    }

    await saveResult(config.department, result)

    console.log(`backtest: completed — ${metrics.total_return_pct}% return, Sharpe=${metrics.sharpe_ratio}, ${metrics.scored_signals} scored signals`)

    return result
  }

  // ==================== Control ====================

  pause(): void {
    this.abortController?.abort()
  }

  // ==================== Promote to Production ====================

  /**
   * Copy a completed backtest's evolved state to production.
   * - weights.json → production weights
   * - Evolved prompts → production prompt files
   * - knowledge/ → production knowledge vault
   */
  static async promote(departmentId: string, runId: string): Promise<{
    promoted: string[]
    warnings: string[]
  }> {
    const backtestDir = resolve('data/atlas', departmentId, 'backtest/runs', runId)
    const prodDir = getDepartmentDataDir(departmentId)
    const promoted: string[] = []
    const warnings: string[] = []

    // Check result exists and is completed
    const result = await loadResult(departmentId, runId)
    if (!result) throw new Error(`Backtest run ${runId} not found`)
    if (result.status !== 'completed' && result.status !== 'paused') {
      throw new Error(`Cannot promote run with status "${result.status}"`)
    }

    // 1. Promote weights
    const btWeights = resolve(backtestDir, 'weights.json')
    const prodWeights = resolve(prodDir, 'state', 'weights.json')
    try {
      const data = await readFile(btWeights, 'utf-8')
      await mkdir(resolve(prodDir, 'state'), { recursive: true })
      await writeFile(prodWeights, data)
      promoted.push('weights.json')
    } catch {
      warnings.push('No weights to promote')
    }

    // 2. Promote evolved prompts — copy contents of prompts_mirror/ into prodDir/
    //    (NOT the directory itself, so prompts_mirror/prompts/x.md → prodDir/prompts/x.md)
    const btPromptDir = resolve(backtestDir, 'prompts_mirror')
    try {
      const entries = await readdir(btPromptDir)
      for (const entry of entries) {
        const src = resolve(btPromptDir, entry)
        const dst = resolve(prodDir, entry)
        await cp(src, dst, { recursive: true, force: true })
      }
      promoted.push('prompts/')
    } catch {
      warnings.push('No evolved prompts to promote')
    }

    // 3. Promote knowledge graph
    const btKg = resolve(backtestDir, 'knowledge')
    const prodKg = resolve(prodDir, 'knowledge')
    try {
      await cp(btKg, prodKg, { recursive: true, force: true })
      promoted.push('knowledge/')
    } catch {
      warnings.push('No knowledge to promote')
    }

    return { promoted, warnings }
  }

  // ==================== Helpers ====================

  /** Copy production prompts into isolated backtest directory */
  private async copyPrompts(
    prodDir: string,
    promptDir: string,
    agents: AgentConfig[],
  ): Promise<void> {
    await mkdir(promptDir, { recursive: true })
    for (const agent of agents) {
      const srcPath = resolve(prodDir, agent.prompt_file)
      const dstPath = resolve(promptDir, agent.prompt_file)
      try {
        await mkdir(resolve(dstPath, '..'), { recursive: true })
        const content = await readFile(srcPath, 'utf-8')
        await writeFile(dstPath, content)
      } catch {
        console.warn(`backtest: prompt not found for ${agent.name}: ${srcPath}`)
      }
    }
  }

  /** Copy evolved state from a seed run into the new run directory */
  private async seedFromRun(
    seedDir: string,
    targetDir: string,
    promptDir: string,
  ): Promise<void> {
    // Copy weights
    try {
      const weights = await readFile(resolve(seedDir, 'weights.json'), 'utf-8')
      await writeFile(resolve(targetDir, 'weights.json'), weights)
    } catch { /* no weights in seed */ }

    // Copy evolved prompts (overwrite the fresh copies)
    const seedPrompts = resolve(seedDir, 'prompts_mirror')
    try {
      await cp(seedPrompts, promptDir, { recursive: true, force: true })
    } catch { /* no prompts in seed */ }

    // Copy knowledge
    const seedKg = resolve(seedDir, 'knowledge')
    const targetKg = resolve(targetDir, 'knowledge')
    try {
      await cp(seedKg, targetKg, { recursive: true, force: true })
    } catch { /* no knowledge in seed */ }

    // Copy evolution log
    try {
      const evoLog = await readFile(resolve(seedDir, 'evolution_log.json'), 'utf-8')
      await writeFile(resolve(targetDir, 'evolution_log.json'), evoLog)
    } catch { /* no evolution log */ }
  }

  private tradingDays(startDate: string, endDate: string): string[] {
    const days: string[] = []
    const current = new Date(startDate)
    const end = new Date(endDate)

    while (current <= end) {
      const dow = current.getDay()
      if (dow !== 0 && dow !== 6) {
        days.push(current.toISOString().slice(0, 10))
      }
      current.setDate(current.getDate() + 1)
    }

    return days
  }
}

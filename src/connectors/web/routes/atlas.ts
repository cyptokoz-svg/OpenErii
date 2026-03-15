/**
 * Atlas API Routes — Backend endpoints for the Atlas Research UI
 *
 * Provides REST endpoints for departments, scorecard, knowledge stats,
 * and analysis trigger. Real-time agent messages flow through SSE.
 */

import { Hono } from 'hono'
import type { AtlasPipeline } from '../../../extension/atlas/pipeline.js'
import type { AtlasConfig } from '../../../extension/atlas/types.js'
import { loadAtlasConfig, loadDepartmentAgents, saveAtlasConfig } from '../../../extension/atlas/config.js'
import { WalkForwardEngine, type WalkForwardDeps, type BacktestConfig } from '../../../extension/atlas/backtest/index.js'
import { loadState, loadResult, listRuns, generateRunId } from '../../../extension/atlas/backtest/state.js'

export interface AtlasRoutesDeps {
  getPipeline: () => AtlasPipeline | null
  getConfig: () => AtlasConfig | null
  /** Dependencies for backtest engine (optional — backtest disabled if missing) */
  getBacktestDeps?: () => WalkForwardDeps | null
}

/** Per-department run state */
interface RunState {
  status: 'running' | 'completed' | 'failed' | 'stopped'
  startedAt: string
  completedAt?: string
  error?: string
  abortController: AbortController
}

/** Auto-clean completed run states after this many ms */
const RUN_STATE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export function createAtlasRoutes(deps: AtlasRoutesDeps) {
  const app = new Hono()

  // Track running state per department
  const runStates = new Map<string, RunState>()

  /** Schedule cleanup of a finished run state */
  const scheduleCleanup = (departmentId: string) => {
    setTimeout(() => {
      const s = runStates.get(departmentId)
      if (s && s.status !== 'running') {
        runStates.delete(departmentId)
      }
    }, RUN_STATE_TTL_MS)
  }

  /** GET /api/atlas/status — Atlas enabled status + department list + run state */
  app.get('/status', async (c) => {
    // Try deps first, fall back to loading from disk
    let config = deps.getConfig()
    if (!config) {
      try {
        config = await loadAtlasConfig()
      } catch (err) {
        console.warn('atlas: failed to load config:', err)
        return c.json({ enabled: false, departments: [] })
      }
    }

    const pipeline = deps.getPipeline()
    return c.json({
      enabled: config.enabled,
      departments: config.departments.map((d) => {
        const rs = runStates.get(d.id)
        return {
          id: d.id,
          name: d.name,
          enabled: d.enabled,
          timeframes: d.timeframes,
          last_run: pipeline?.getLastRunTimestamp(d.id) ?? null,
          run_status: rs?.status ?? 'idle',
          run_started_at: rs?.startedAt ?? null,
        }
      }),
    })
  })

  /** GET /api/atlas/agents/:department — List all agents in a department */
  app.get('/agents/:department', async (c) => {
    let config = deps.getConfig()
    if (!config) {
      try { config = await loadAtlasConfig() } catch { return c.json({ agents: [] }) }
    }
    const departmentId = c.req.param('department')
    const dept = config.departments.find((d) => d.id === departmentId)
    if (!dept) return c.json({ error: 'Department not found' }, 404)

    try {
      const agents = await loadDepartmentAgents(dept)
      return c.json({
        agents: agents.map((a) => ({
          name: a.name,
          display_name: a.display_name,
          layer: a.layer,
          style: a.style,
          enabled: a.enabled,
          knowledge_links: a.knowledge_links,
          data_sources: a.data_sources.map((ds) => ({ provider: ds.provider, type: ds.type, symbols: ds.symbols })),
        })),
      })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  /** GET /api/atlas/scorecard/:department — Agent performance data */
  app.get('/scorecard/:department', async (c) => {
    const pipeline = deps.getPipeline()
    if (!pipeline) return c.json({ error: 'Atlas pipeline not initialized' }, 503)
    const departmentId = c.req.param('department')
    try {
      const scorecard = pipeline.getScorecard(departmentId)
      await scorecard.load()
      return c.json({ agents: scorecard.getAllScores() })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  /** GET /api/atlas/knowledge/:department/stats — Knowledge graph stats */
  app.get('/knowledge/:department/stats', async (c) => {
    const pipeline = deps.getPipeline()
    if (!pipeline) return c.json({ error: 'Atlas pipeline not initialized' }, 503)
    const departmentId = c.req.param('department')
    try {
      const kg = pipeline.getKnowledgeGraph(departmentId)
      const stats = await kg.stats()
      return c.json(stats)
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  /** GET /api/atlas/config — Full atlas config (model_tiers, etc.) */
  app.get('/config', async (c) => {
    try {
      const config = await loadAtlasConfig()
      return c.json({
        model_tiers: config.model_tiers,
        max_concurrency: config.max_concurrency,
        obsidian_vault_path: config.obsidian_vault_path ?? '',
      })
    } catch {
      return c.json({ model_tiers: { default: 'haiku' }, max_concurrency: 5 })
    }
  })

  /** PUT /api/atlas/config — Update atlas config (model_tiers, etc.) */
  app.put('/config', async (c) => {
    try {
      const body = await c.req.json() as {
        model_tiers?: Record<string, string>
        max_concurrency?: number
        obsidian_vault_path?: string
      }
      const patch: Record<string, unknown> = {}
      if (body.model_tiers !== undefined) patch.model_tiers = body.model_tiers
      if (body.max_concurrency !== undefined) patch.max_concurrency = body.max_concurrency
      if (body.obsidian_vault_path !== undefined) patch.obsidian_vault_path = body.obsidian_vault_path || undefined
      const updated = await saveAtlasConfig(patch)
      return c.json({
        model_tiers: updated.model_tiers,
        max_concurrency: updated.max_concurrency,
        obsidian_vault_path: updated.obsidian_vault_path ?? '',
      })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  /** POST /api/atlas/run — Trigger analysis (async, results stream via SSE) */
  app.post('/run', async (c) => {
    const pipeline = deps.getPipeline()
    if (!pipeline) return c.json({ error: 'Atlas pipeline not initialized' }, 503)
    const body = await c.req.json() as { department: string; focus?: string }
    if (!body.department) return c.json({ error: 'department required' }, 400)

    // Prevent duplicate runs
    const existing = runStates.get(body.department)
    if (existing?.status === 'running') {
      return c.json({ error: 'Analysis already running for this department' }, 409)
    }

    const abortController = new AbortController()
    const state: RunState = {
      status: 'running',
      startedAt: new Date().toISOString(),
      abortController,
    }
    runStates.set(body.department, state)

    // Run async — results stream to research channel via callbacks
    pipeline.run({
      department: body.department,
      focus: body.focus,
      abortSignal: abortController.signal,
    }).then(() => {
      // Only update if not manually stopped (stop endpoint sets status first)
      if (state.status === 'running') {
        state.status = 'completed'
        state.completedAt = new Date().toISOString()
      }
      scheduleCleanup(body.department)
    }).catch((err) => {
      if (state.status !== 'stopped') {
        if (abortController.signal.aborted) {
          state.status = 'stopped'
        } else {
          state.status = 'failed'
          state.error = String(err)
        }
      }
      state.completedAt = new Date().toISOString()
      scheduleCleanup(body.department)
      console.error('atlas: pipeline run failed:', err)
    })

    return c.json({ status: 'started', department: body.department })
  })

  /** POST /api/atlas/stop — Stop a running analysis */
  app.post('/stop', async (c) => {
    const body = await c.req.json() as { department: string }
    if (!body.department) return c.json({ error: 'department required' }, 400)

    const state = runStates.get(body.department)
    if (!state || state.status !== 'running') {
      return c.json({ error: 'No running analysis for this department' }, 404)
    }

    state.abortController.abort()
    state.status = 'stopped'
    state.completedAt = new Date().toISOString()
    return c.json({ status: 'stopped', department: body.department })
  })

  // ==================== Backtest Endpoints ====================

  // Track active backtest engines
  const backtestEngines = new Map<string, WalkForwardEngine>()

  /** POST /api/atlas/backtest/run — Start a walk-forward backtest */
  app.post('/backtest/run', async (c) => {
    const btDeps = deps.getBacktestDeps?.()
    if (!btDeps) return c.json({ error: 'Backtest dependencies not available' }, 503)

    const body = await c.req.json() as BacktestConfig
    if (!body.department || !body.startDate || !body.endDate) {
      return c.json({ error: 'department, startDate, endDate required' }, 400)
    }

    // Defaults
    const config: BacktestConfig = {
      department: body.department,
      startDate: body.startDate,
      endDate: body.endDate,
      step: body.step ?? 5,
      skip_layers: body.skip_layers,
      disable_knowledge: body.disable_knowledge,
      disable_evolution: body.disable_evolution ?? false,
      initialCapital: body.initialCapital ?? 100000,
      model_tiers: body.model_tiers,
      gdelt_keywords: body.gdelt_keywords,
      seedRunId: body.seedRunId,
      bigquery_project: body.bigquery_project,
    }

    const engine = new WalkForwardEngine(btDeps)
    const key = `${config.department}-backtest`
    backtestEngines.set(key, engine)

    // Generate run ID upfront so we can return it immediately
    const runId = generateRunId()

    // Run async
    engine.run(config, { runId }).then(() => {
      backtestEngines.delete(key)
    }).catch((err) => {
      console.error('atlas: backtest failed:', err)
      backtestEngines.delete(key)
    })

    return c.json({ status: 'started', department: config.department, runId })
  })

  /** POST /api/atlas/backtest/pause/:department — Pause a running backtest */
  app.post('/backtest/pause/:department', async (c) => {
    const dept = c.req.param('department')
    const engine = backtestEngines.get(`${dept}-backtest`)
    if (!engine) return c.json({ error: 'No running backtest' }, 404)
    engine.pause()
    return c.json({ status: 'paused' })
  })

  /** GET /api/atlas/backtest/status/:department/:id — Get backtest status */
  app.get('/backtest/status/:department/:id', async (c) => {
    const dept = c.req.param('department')
    const id = c.req.param('id')
    const state = await loadState(dept, id)
    if (!state) return c.json({ error: 'Backtest not found' }, 404)
    return c.json(state)
  })

  /** GET /api/atlas/backtest/result/:department/:id — Get backtest result */
  app.get('/backtest/result/:department/:id', async (c) => {
    const dept = c.req.param('department')
    const id = c.req.param('id')
    const result = await loadResult(dept, id)
    if (!result) return c.json({ error: 'Result not found' }, 404)
    return c.json(result)
  })

  /** GET /api/atlas/backtest/list/:department — List all backtest runs */
  app.get('/backtest/list/:department', async (c) => {
    const dept = c.req.param('department')
    const runs = await listRuns(dept)
    return c.json({ runs })
  })

  /** POST /api/atlas/backtest/promote/:department/:id — Promote backtest state to production */
  app.post('/backtest/promote/:department/:id', async (c) => {
    const dept = c.req.param('department')
    const id = c.req.param('id')
    try {
      const result = await WalkForwardEngine.promote(dept, id)
      return c.json({ status: 'promoted', ...result })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  return app
}

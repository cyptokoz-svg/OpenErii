/**
 * Atlas API Routes — Backend endpoints for the Atlas Research UI
 *
 * Provides REST endpoints for departments, scorecard, knowledge stats,
 * and analysis trigger. Real-time agent messages flow through SSE.
 */

import { Hono } from 'hono'
import type { AtlasPipeline } from '../../../extension/atlas/pipeline.js'
import type { AtlasConfig } from '../../../extension/atlas/types.js'
import { loadAtlasConfig, loadDepartmentAgents } from '../../../extension/atlas/config.js'

export interface AtlasRoutesDeps {
  getPipeline: () => AtlasPipeline | null
  getConfig: () => AtlasConfig | null
}

export function createAtlasRoutes(deps: AtlasRoutesDeps) {
  const app = new Hono()

  /** GET /api/atlas/status — Atlas enabled status + department list */
  app.get('/status', async (c) => {
    // Try deps first, fall back to loading from disk
    let config = deps.getConfig()
    if (!config) {
      try {
        config = await loadAtlasConfig()
      } catch {
        return c.json({ enabled: false, departments: [] })
      }
    }

    const pipeline = deps.getPipeline()
    return c.json({
      enabled: config.enabled,
      departments: config.departments.map((d) => ({
        id: d.id,
        name: d.name,
        enabled: d.enabled,
        timeframes: d.timeframes,
        last_run: pipeline?.getLastRunTimestamp(d.id) ?? null,
      })),
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

  /** POST /api/atlas/run — Trigger analysis (async, results stream via SSE) */
  app.post('/run', async (c) => {
    const pipeline = deps.getPipeline()
    if (!pipeline) return c.json({ error: 'Atlas pipeline not initialized' }, 503)
    const body = await c.req.json() as { department: string; focus?: string }
    if (!body.department) return c.json({ error: 'department required' }, 400)

    // Run async — results stream to research channel via callbacks
    pipeline.run({
      department: body.department,
      focus: body.focus,
    }).catch((err) => {
      console.error('atlas: pipeline run failed:', err)
    })

    return c.json({ status: 'started', department: body.department })
  })

  return app
}

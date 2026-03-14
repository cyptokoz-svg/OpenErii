/**
 * Atlas API Routes — Backend endpoints for the Atlas Research UI
 *
 * Provides REST endpoints for departments, scorecard, knowledge stats,
 * and analysis trigger. Real-time agent messages flow through SSE.
 */

import { Hono } from 'hono'
import type { AtlasPipeline } from '../../../extension/atlas/pipeline.js'
import type { AtlasConfig } from '../../../extension/atlas/types.js'

export interface AtlasRoutesDeps {
  pipeline: AtlasPipeline | null
  config: AtlasConfig | null
}

export function createAtlasRoutes(deps: AtlasRoutesDeps) {
  const app = new Hono()

  /** GET /api/atlas/status — Atlas enabled status + department list */
  app.get('/status', (c) => {
    if (!deps.config) {
      return c.json({ enabled: false, departments: [] })
    }
    return c.json({
      enabled: deps.config.enabled,
      departments: deps.config.departments.map((d) => ({
        id: d.id,
        name: d.name,
        enabled: d.enabled,
        timeframes: d.timeframes,
        last_run: deps.pipeline?.getLastRunTimestamp(d.id) ?? null,
      })),
    })
  })

  /** GET /api/atlas/scorecard/:department — Agent performance data */
  app.get('/scorecard/:department', async (c) => {
    if (!deps.pipeline) return c.json({ error: 'Atlas not initialized' }, 503)
    const departmentId = c.req.param('department')
    try {
      const scorecard = deps.pipeline.getScorecard(departmentId)
      await scorecard.load()
      return c.json({ agents: scorecard.getAllScores() })
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  /** GET /api/atlas/knowledge/:department/stats — Knowledge graph stats */
  app.get('/knowledge/:department/stats', async (c) => {
    if (!deps.pipeline) return c.json({ error: 'Atlas not initialized' }, 503)
    const departmentId = c.req.param('department')
    try {
      const kg = deps.pipeline.getKnowledgeGraph(departmentId)
      const stats = await kg.stats()
      return c.json(stats)
    } catch (err) {
      return c.json({ error: String(err) }, 400)
    }
  })

  /** POST /api/atlas/run — Trigger analysis (async, results stream via SSE) */
  app.post('/run', async (c) => {
    if (!deps.pipeline) return c.json({ error: 'Atlas not initialized' }, 503)
    const body = await c.req.json() as { department: string; focus?: string }
    if (!body.department) return c.json({ error: 'department required' }, 400)

    // Run async — results stream to research channel via callbacks
    deps.pipeline.run({
      department: body.department,
      focus: body.focus,
    }).catch((err) => {
      console.error('atlas: pipeline run failed:', err)
    })

    return c.json({ status: 'started', department: body.department })
  })

  return app
}

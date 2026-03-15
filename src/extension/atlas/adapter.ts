/**
 * Atlas Adapter — Tool definitions for Alice's ToolCenter
 *
 * Exposes the Atlas research engine as Vercel AI SDK tools.
 * Alice can call these tools during conversation to trigger analysis.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { AtlasPipeline } from './pipeline.js'
import type { AutoResearch } from './autoresearch.js'
import type { AtlasConfig, DepartmentConfig } from './types.js'
import type { WalkForwardDeps } from './backtest/index.js'

// ==================== Tool Factory ====================

export interface AtlasToolsDeps {
  pipeline: AtlasPipeline
  config: AtlasConfig
  getAutoResearch: (departmentId: string) => AutoResearch
  /** Optional: backtest engine deps */
  getBacktestDeps?: () => WalkForwardDeps | null
}

export function createAtlasTools(deps: AtlasToolsDeps) {
  const { pipeline, config } = deps

  return {
    /**
     * Run full L1→L4 analysis for a department.
     * Each agent's analysis is streamed to the Research channel in real-time.
     */
    atlasAnalysis: tool({
      description:
        'Run the Atlas research team analysis (L1 macro → L2 sector → L3 strategy → L4 decision). ' +
        'Returns a trading signal with positions, conviction, and reasoning. ' +
        'Each agent posts their analysis to the Research channel as they complete. ' +
        'Use this when the user asks for market analysis or trading recommendations.',
      inputSchema: z.object({
        department: z.string().describe('Department ID, e.g. "commodity", "crypto", "equity"'),
        focus: z.string().optional().describe('Focus area, e.g. "crude oil", "gold"'),
      }),
      execute: async ({ department, focus }) => {
        const report = await pipeline.run({ department, focus })
        return {
          department: report.department,
          direction: report.direction,
          conviction: report.conviction,
          positions: report.positions,
          summary: report.summary,
          l1: report.layers.l1?.summary,
          l2: report.layers.l2?.summary,
          l3: report.layers.l3?.summary,
          l4: report.layers.l4?.summary,
          layer_agreement: report.confidence.layer_agreement,
          accuracy: report.confidence.historical_accuracy,
          skipped: report.skipped_agents.length,
          llm_calls: report.cost_estimate.total_calls - report.cost_estimate.skipped_calls,
        }
      },
    }),

    /**
     * View agent performance and Darwinian weights.
     */
    atlasScorecard: tool({
      description:
        'View Atlas agent performance metrics — Sharpe ratio, win rate, Darwinian weights. ' +
        'Use this to check which agents are performing well or poorly.',
      inputSchema: z.object({
        department: z.string().describe('Department ID'),
        agent: z.string().optional().describe('Specific agent name, omit for all'),
      }),
      execute: async ({ department, agent }) => {
        const scorecard = pipeline.getScorecard(department)
        await scorecard.load()
        return scorecard.getSummary(agent)
      },
    }),

    /**
     * Search the knowledge graph.
     */
    atlasKnowledge: tool({
      description:
        'Search the Atlas knowledge graph (Obsidian vault) for accumulated market insights, ' +
        'patterns, events, and lessons learned by the research team.',
      inputSchema: z.object({
        department: z.string().describe('Department ID'),
        query: z.string().describe('Search keywords'),
        max_results: z.number().int().min(1).max(20).optional().describe('Max notes to return'),
      }),
      execute: async ({ department, query, max_results }) => {
        const kg = pipeline.getKnowledgeGraph(department)
        const tags = query.split(/[\s,]+/).filter(Boolean)
        const notes = await kg.readNotesWithLinks(tags, max_results ?? 10)
        return {
          count: notes.length,
          notes: notes.map((n) => ({
            file: n.file,
            source: n.source,
            stale: n.stale,
            content: n.content.slice(0, 500),
          })),
        }
      },
    }),

    /**
     * Trigger AutoResearch self-evolution.
     */
    atlasEvolve: tool({
      description:
        'Trigger Atlas AutoResearch — finds the worst-performing agent, generates an improved prompt, ' +
        'and starts an A/B test. After 5 days, the improvement is kept or reverted.',
      inputSchema: z.object({
        department: z.string().describe('Department ID'),
      }),
      execute: async ({ department }) => {
        const ar = deps.getAutoResearch(department)
        return await ar.runOnce()
      },
    }),

    /**
     * List all departments and their status.
     */
    atlasDepartments: tool({
      description:
        'List all Atlas research departments, their status, and last run time.',
      inputSchema: z.object({}),
      execute: async () => {
        return config.departments.map((d: DepartmentConfig) => ({
          id: d.id,
          name: d.name,
          enabled: d.enabled,
          timeframes: d.timeframes,
          last_run: pipeline.getLastRunTimestamp(d.id) ?? 'never',
        }))
      },
    }),

    /**
     * Run a walk-forward backtest on a department.
     */
    atlasBacktest: tool({
      description:
        'Run a walk-forward historical simulation on an Atlas department. ' +
        'Replays history day by day: run pipeline → generate signals → score → update weights → evolve agents. ' +
        'This bootstraps the department\'s Darwinian improvement cycle from historical data.',
      inputSchema: z.object({
        department: z.string().describe('Department ID, e.g. "commodity"'),
        startDate: z.string().describe('Start date YYYY-MM-DD, e.g. "2022-01-03"'),
        endDate: z.string().describe('End date YYYY-MM-DD, e.g. "2026-03-14"'),
        step: z.number().int().min(1).max(30).optional().describe('Run every N trading days (default: 5)'),
        disable_evolution: z.boolean().optional().describe('Disable agent evolution (default: false)'),
      }),
      execute: async ({ department, startDate, endDate, step, disable_evolution }) => {
        const btDeps = deps.getBacktestDeps?.()
        if (!btDeps) return { error: 'Backtest dependencies not available' }

        const { WalkForwardEngine } = await import('./backtest/index.js')
        const engine = new WalkForwardEngine(btDeps)

        try {
          const result = await engine.run({
            department,
            startDate,
            endDate,
            step: step ?? 5,
            disable_evolution: disable_evolution ?? false,
            initialCapital: 100000,
          })

          return {
            status: result.status,
            total_return: `${result.metrics.total_return_pct}%`,
            max_drawdown: `${result.metrics.max_drawdown_pct}%`,
            sharpe: result.metrics.sharpe_ratio,
            win_rate: `${result.metrics.win_rate_pct}%`,
            total_signals: result.metrics.total_signals,
            scored_signals: result.metrics.scored_signals,
            elapsed: `${Math.round(result.elapsed_ms / 1000)}s`,
            top_agents: result.agent_attribution.slice(0, 5).map((a) => ({
              agent: a.agent,
              sharpe: a.sharpe,
              win_rate: `${a.win_rate_pct}%`,
              weight: `${a.weight_start.toFixed(2)} → ${a.weight_end.toFixed(2)}`,
              evolved: a.evolved,
            })),
            evolution_events: result.evolution_log.length,
          }
        } catch (err) {
          return { error: String(err) }
        }
      },
    }),
  }
}

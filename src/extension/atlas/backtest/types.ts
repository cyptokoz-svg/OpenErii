/**
 * Atlas Backtest — Walk-Forward Historical Simulation Types
 *
 * The department replays history day by day: run pipeline → generate signals →
 * score past signals → update Darwinian weights → trigger evolution.
 * This bootstraps the department's iterative improvement cycle.
 */

import type { AtlasReport, EvolutionEntry, Layer } from '../types.js'

// ==================== Config ====================

export interface BacktestConfig {
  department: string
  startDate: string             // 'YYYY-MM-DD'
  endDate: string               // 'YYYY-MM-DD'
  step: number                  // Run pipeline every N trading days (default: 5)
  skip_layers?: Layer[]         // Skip layers to save LLM calls
  disable_knowledge?: boolean   // Disable knowledge graph writes
  disable_evolution?: boolean   // Disable AutoResearch evolution
  initialCapital: number        // Initial capital for PnL calculation
  /** Optional model tier overrides for backtest (uses atlas.json model_tiers if not set) */
  model_tiers?: Record<string, string>
  /** GDELT query keywords for historical news */
  gdelt_keywords?: string
  /** Seed from a previous run — inherit evolved weights, prompts, and knowledge */
  seedRunId?: string
  /** Google Cloud project ID for BigQuery GDELT access (dates > 3 months) */
  bigquery_project?: string
}

// ==================== State (checkpoint/resume) ====================

export type BacktestStatus = 'preparing' | 'downloading' | 'running' | 'paused' | 'completed' | 'failed'

export interface BacktestState {
  id: string
  config: BacktestConfig
  status: BacktestStatus
  currentDate: string           // Current simulated date
  progress: number              // 0-100
  days_completed: number
  days_total: number
  started_at: string
  elapsed_ms: number
  error?: string
}

// ==================== Day Result ====================

export interface DayResult {
  date: string
  direction: string
  conviction: number
  signals_generated: number
  signals_scored: number
  weight_snapshot: Record<string, number>
  evolution_triggered?: string
  positions: Array<{
    ticker: string
    direction: string
    size_pct: number
  }>
}

// ==================== Metrics ====================

export interface PortfolioMetrics {
  total_return_pct: number
  max_drawdown_pct: number
  sharpe_ratio: number
  sortino_ratio: number
  win_rate_pct: number
  profit_factor: number
  total_signals: number
  scored_signals: number
  avg_holding_days: number
}

export interface AgentAttribution {
  agent: string
  signals: number
  win_rate_pct: number
  total_pnl_pct: number
  avg_conviction: number
  sharpe: number
  weight_start: number
  weight_end: number
  evolved: boolean
}

// ==================== Result ====================

export interface BacktestResult {
  id: string
  config: BacktestConfig
  status: BacktestStatus
  equity_curve: Array<{ date: string; equity: number }>
  metrics: PortfolioMetrics
  agent_attribution: AgentAttribution[]
  weight_history: Array<{ date: string; weights: Record<string, number> }>
  evolution_log: EvolutionEntry[]
  days: DayResult[]
  started_at: string
  completed_at: string
  elapsed_ms: number
}

// ==================== GDELT ====================

export interface GdeltArticle {
  title: string
  url: string
  source: string
  language: string
  seendate: string
  tone: number
}

export interface GdeltDayCache {
  date: string
  articles: GdeltArticle[]
  fetched_at: string
  /** Data source: 'doc_api' (recent), 'bigquery' (historical), 'unavailable' */
  source?: string
}

// ==================== Data Download ====================

export interface DownloadProgress {
  type: 'prices' | 'macro' | 'news'
  symbol?: string
  done: number
  total: number
}

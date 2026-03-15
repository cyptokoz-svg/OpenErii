import { headers } from './client'

export interface AtlasDepartment {
  id: string
  name: string
  enabled: boolean
  timeframes: string[]
  last_run: string | null
  run_status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped'
  run_started_at: string | null
}

export interface AtlasStatus {
  enabled: boolean
  departments: AtlasDepartment[]
}

export interface AgentScoreItem {
  agent: string
  department: string
  weight: number
  sharpe: number
  win_rate: number
  total_signals: number
  scored_signals: number
  avg_conviction: number
  last_signal_date: string
}

export interface AtlasAgent {
  name: string
  display_name: string
  layer: string
  style: string
  enabled: boolean
  knowledge_links: string[]
  data_sources: { provider: string; type: string; symbols: string[] }[]
}

export interface KnowledgeStats {
  total_notes: number
  total_size_kb: number
  stale_notes: number
  categories: string[]
}

export const atlasApi = {
  async getStatus(): Promise<AtlasStatus> {
    const res = await fetch('/api/atlas/status')
    if (!res.ok) throw new Error('Failed to load atlas status')
    return res.json()
  },

  async getAgents(department: string): Promise<{ agents: AtlasAgent[] }> {
    const res = await fetch(`/api/atlas/agents/${encodeURIComponent(department)}`)
    if (!res.ok) throw new Error('Failed to load agents')
    return res.json()
  },

  async getScorecard(department: string): Promise<{ agents: AgentScoreItem[] }> {
    const res = await fetch(`/api/atlas/scorecard/${encodeURIComponent(department)}`)
    if (!res.ok) throw new Error('Failed to load scorecard')
    return res.json()
  },

  async getKnowledgeStats(department: string): Promise<KnowledgeStats> {
    const res = await fetch(`/api/atlas/knowledge/${encodeURIComponent(department)}/stats`)
    if (!res.ok) throw new Error('Failed to load knowledge stats')
    return res.json()
  },

  async runAnalysis(department: string, focus?: string): Promise<{ status: string }> {
    const res = await fetch('/api/atlas/run', {
      method: 'POST',
      headers,
      body: JSON.stringify({ department, focus }),
    })
    if (!res.ok) throw new Error('Failed to start analysis')
    return res.json()
  },

  async getConfig(): Promise<{ model_tiers: Record<string, string>; max_concurrency: number; obsidian_vault_path: string }> {
    const res = await fetch('/api/atlas/config')
    if (!res.ok) throw new Error('Failed to load atlas config')
    return res.json()
  },

  async updateConfig(patch: { model_tiers?: Record<string, string>; max_concurrency?: number; obsidian_vault_path?: string }): Promise<{ model_tiers: Record<string, string>; obsidian_vault_path: string }> {
    const res = await fetch('/api/atlas/config', {
      method: 'PUT',
      headers,
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error('Failed to update atlas config')
    return res.json()
  },

  async stopAnalysis(department: string): Promise<{ status: string }> {
    const res = await fetch('/api/atlas/stop', {
      method: 'POST',
      headers,
      body: JSON.stringify({ department }),
    })
    if (!res.ok) throw new Error('Failed to stop analysis')
    return res.json()
  },

  // ==================== Backtest ====================

  async backtestRun(config: BacktestRunConfig): Promise<{ status: string; runId: string }> {
    const res = await fetch('/api/atlas/backtest/run', {
      method: 'POST',
      headers,
      body: JSON.stringify(config),
    })
    if (!res.ok) throw new Error('Failed to start backtest')
    return res.json()
  },

  async backtestPause(department: string): Promise<{ status: string }> {
    const res = await fetch(`/api/atlas/backtest/pause/${encodeURIComponent(department)}`, {
      method: 'POST',
      headers,
    })
    if (!res.ok) throw new Error('Failed to pause backtest')
    return res.json()
  },

  async backtestStatus(department: string, id: string): Promise<BacktestStateResponse> {
    const res = await fetch(`/api/atlas/backtest/status/${encodeURIComponent(department)}/${encodeURIComponent(id)}`)
    if (!res.ok) throw new Error('Failed to load backtest status')
    return res.json()
  },

  async backtestResult(department: string, id: string): Promise<BacktestResultResponse> {
    const res = await fetch(`/api/atlas/backtest/result/${encodeURIComponent(department)}/${encodeURIComponent(id)}`)
    if (!res.ok) throw new Error('Failed to load backtest result')
    return res.json()
  },

  async backtestList(department: string): Promise<{ runs: BacktestRunSummary[] }> {
    const res = await fetch(`/api/atlas/backtest/list/${encodeURIComponent(department)}`)
    if (!res.ok) throw new Error('Failed to list backtests')
    return res.json()
  },

  async backtestPromote(department: string, id: string): Promise<{ status: string; promoted: string[]; warnings: string[] }> {
    const res = await fetch(`/api/atlas/backtest/promote/${encodeURIComponent(department)}/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Promote failed' }))
      throw new Error(err.error || 'Promote failed')
    }
    return res.json()
  },
}

// ==================== Backtest Types ====================

export interface BacktestRunConfig {
  department: string
  startDate: string
  endDate: string
  step?: number
  skip_layers?: string[]
  disable_knowledge?: boolean
  disable_evolution?: boolean
  initialCapital?: number
  model_tiers?: Record<string, string>
  gdelt_keywords?: string
  /** Seed from a previous backtest run — inherit evolved weights, prompts, knowledge */
  seedRunId?: string
  /** Google Cloud project ID for BigQuery GDELT access (dates > 3 months) */
  bigquery_project?: string
}

export interface BacktestStateResponse {
  id: string
  config: BacktestRunConfig
  status: string
  currentDate: string
  progress: number
  days_completed: number
  days_total: number
  started_at: string
  elapsed_ms: number
  error?: string
}

export interface BacktestResultResponse {
  id: string
  config: BacktestRunConfig
  status: string
  equity_curve: Array<{ date: string; equity: number }>
  metrics: {
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
  agent_attribution: Array<{
    agent: string
    signals: number
    win_rate_pct: number
    total_pnl_pct: number
    avg_conviction: number
    sharpe: number
    weight_start: number
    weight_end: number
    evolved: boolean
  }>
  weight_history: Array<{ date: string; weights: Record<string, number> }>
  evolution_log: Array<{
    agent: string
    status: string
    sharpe_before: number
    sharpe_after?: number
    started_at: string
  }>
  days: Array<{
    date: string
    direction: string
    conviction: number
    signals_generated: number
    signals_scored: number
    evolution_triggered?: string
  }>
  started_at: string
  completed_at: string
  elapsed_ms: number
}

export interface BacktestRunSummary {
  id: string
  department: string
  status: string
  startDate: string
  endDate: string
  progress: number
  started_at: string
}

import { headers } from './client'

export interface AtlasDepartment {
  id: string
  name: string
  enabled: boolean
  timeframes: string[]
  last_run: string | null
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
}

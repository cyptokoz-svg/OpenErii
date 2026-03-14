/**
 * Atlas Research Extension — Shared Types
 *
 * Core type definitions for the multi-department research team engine.
 * All types are pure data — no runtime logic here.
 */

// ==================== Layers ====================

export type Layer = 'L1' | 'L2' | 'L3' | 'L4'

export const LAYERS: Layer[] = ['L1', 'L2', 'L3', 'L4']

// ==================== Signal ====================

export type Direction = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

export interface Position {
  ticker: string
  name: string
  direction: 'long' | 'short'
  size_pct: number
  entry_price: number | null
  entry_zone: number[]
  stop_loss: number | null
  take_profit: number[]
  rationale: string
}

export interface Signal {
  direction: Direction
  conviction: number
  targets: string[]
  positions: Position[]
}

// ==================== Reasoning ====================

export interface Reasoning {
  summary: string
  key_factors: string[]
  data_used: string[]
  caveats: string
}

// ==================== Knowledge ====================

export type KnowledgeUpdateType = 'insight' | 'event' | 'lesson' | 'pattern' | 'seasonal'

export interface KnowledgeUpdate {
  file: string
  type: KnowledgeUpdateType
  content: string
}

// ==================== Envelope ====================

export interface Envelope {
  agent: string
  display_name: string
  layer: Layer
  signal: Signal
  reasoning: Reasoning
  knowledge_updates: KnowledgeUpdate[]
  weight: number
  timestamp: string
}

// ==================== Agent Config ====================

export interface DataSourceConfig {
  provider: string
  query: string
  symbols?: string[]
  type: 'price' | 'news' | 'macro'
}

export interface AgentConfig {
  name: string
  display_name: string
  layer: Layer
  model_tier: string
  style: string
  prompt_file: string
  knowledge_links: string[]
  data_sources: DataSourceConfig[]
  rule_based?: boolean
  chat_enabled?: boolean
  enabled: boolean
}

// ==================== Department ====================

export interface DepartmentConfig {
  id: string
  name: string
  enabled: boolean
  layers: Layer[]
  agents_config: string
  timeframes: string[]
}

// ==================== Atlas Config ====================

export interface AtlasConfig {
  enabled: boolean
  model_tiers: Record<string, string>
  max_concurrency: number
  departments: DepartmentConfig[]
}

// ==================== Layer Synthesis ====================

export interface LayerSynthesis {
  layer: Layer
  direction: Direction
  conviction: number
  agreement_ratio: number
  envelopes: Envelope[]
  dissent: string[]
  summary: string
}

// ==================== Run Result ====================

export interface AtlasRunOpts {
  department: string
  focus?: string
  skip_layers?: Layer[]
  source_channel?: string
}

export interface AtlasReport {
  department: string
  timestamp: string
  direction: Direction
  conviction: number
  positions: Position[]
  summary: string
  layers: {
    l1?: LayerSynthesis
    l2?: LayerSynthesis
    l3?: LayerSynthesis
    l4?: LayerSynthesis
  }
  confidence: {
    layer_agreement: number
    historical_accuracy: number
    top_agent: string
    worst_agent: string
  }
  skipped_agents: string[]
  cost_estimate: {
    total_calls: number
    skipped_calls: number
  }
}

// ==================== Scorecard ====================

export interface SignalRecord {
  agent: string
  department: string
  direction: Direction
  conviction: number
  targets: string[]
  date: string
  forward_return?: number
  forward_days?: number
  scored?: boolean
}

export interface AgentScore {
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

// ==================== AutoResearch ====================

export interface EvolutionEntry {
  agent: string
  department: string
  old_prompt_hash: string
  new_prompt_hash: string
  reason: string
  started_at: string
  status: 'testing' | 'kept' | 'reverted'
  sharpe_before: number
  sharpe_after?: number
  completed_at?: string
}

// ==================== Pipeline Callbacks ====================

export interface PipelineCallbacks {
  onAgentComplete?: (agent: AgentConfig, envelope: Envelope) => void | Promise<void>
  onLayerComplete?: (synthesis: LayerSynthesis) => void | Promise<void>
  onReportComplete?: (report: AtlasReport) => void | Promise<void>
}

/**
 * AtlasAgentMessage — Renders an individual agent's analysis in the research channel.
 *
 * Shows agent name, layer badge, direction arrow, conviction bar,
 * reasoning chain, positions, and knowledge updates inline.
 */

import { type FC } from 'react'

// ==================== Types ====================

export interface AtlasAgentData {
  type: 'atlas-agent'
  agent: string
  layer: string
  direction: string
  conviction: number
  reasoning: {
    summary: string
    key_factors: string[]
    data_used: string[]
    caveats: string
  }
  positions?: Array<{
    ticker: string
    direction: string
    size_pct: number
    entry_price?: number | null
    stop_loss?: number | null
    take_profit?: number[]
    rationale?: string
  }>
  knowledge_updates?: Array<{
    file: string
    type: string
    content: string
  }>
  timestamp: string
}

export interface AtlasLayerData {
  type: 'atlas-layer'
  layer: string
  direction: string
  conviction: number
  agreement: number
  summary: string
  timestamp: string
}

export interface AtlasReportData {
  type: 'atlas-report'
  department: string
  direction: string
  conviction: number
  positions: Array<{
    ticker: string
    direction: string
    size_pct: number
    entry_price?: number | null
    stop_loss?: number | null
    take_profit?: number[]
  }>
  summary: string
  timestamp: string
}

// ==================== Direction Helpers ====================

const dirColor = (dir: string) => {
  switch (dir?.toUpperCase()) {
    case 'BULLISH': return 'text-green-400'
    case 'BEARISH': return 'text-red-400'
    default: return 'text-yellow-400'
  }
}

const dirIcon = (dir: string) => {
  switch (dir?.toUpperCase()) {
    case 'BULLISH': return '▲'
    case 'BEARISH': return '▼'
    default: return '●'
  }
}

const layerBadge = (layer: string) => {
  const colors: Record<string, string> = {
    L1: 'bg-blue-500/20 text-blue-400',
    L2: 'bg-purple-500/20 text-purple-400',
    L3: 'bg-orange-500/20 text-orange-400',
    L4: 'bg-red-500/20 text-red-400',
  }
  return colors[layer] ?? 'bg-gray-500/20 text-gray-400'
}

// ==================== Components ====================

/** Single agent's analysis message */
export const AtlasAgentMessage: FC<{ data: AtlasAgentData }> = ({ data }) => {
  const time = new Date(data.timestamp).toLocaleTimeString()

  return (
    <div className="border border-border rounded-lg p-4 mb-3 bg-bg-secondary">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${layerBadge(data.layer)}`}>
          {data.layer}
        </span>
        <span className="font-semibold text-sm text-text">{data.agent}</span>
        <span className={`text-sm font-bold ${dirColor(data.direction)}`}>
          {dirIcon(data.direction)} {data.direction}
        </span>
        <span className="text-xs text-text-muted ml-auto">{time}</span>
      </div>

      {/* Conviction bar */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs text-text-muted">Conviction</span>
        <div className="flex-1 h-1.5 bg-bg rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${
              data.conviction > 70 ? 'bg-green-500' :
              data.conviction > 40 ? 'bg-yellow-500' : 'bg-red-500'
            }`}
            style={{ width: `${data.conviction}%` }}
          />
        </div>
        <span className="text-xs font-mono text-text-muted">{data.conviction}%</span>
      </div>

      {/* Reasoning */}
      {data.reasoning && (
        <div className="text-sm text-text-secondary mb-3">
          <p className="mb-1">{data.reasoning.summary}</p>
          {data.reasoning.key_factors?.length > 0 && (
            <div className="ml-2 mb-1">
              {data.reasoning.key_factors.map((f, i) => (
                <div key={i} className="text-xs text-text-muted">• {f}</div>
              ))}
            </div>
          )}
          {data.reasoning.caveats && (
            <div className="ml-2">
              <span className="text-xs text-red-400">⚠ </span>
              <span className="text-xs text-text-muted">{data.reasoning.caveats}</span>
            </div>
          )}
        </div>
      )}

      {/* Positions */}
      {data.positions && data.positions.length > 0 && (
        <div className="mb-2">
          <div className="text-xs text-text-muted mb-1">Positions:</div>
          <div className="flex flex-wrap gap-2">
            {data.positions.map((p, i) => (
              <span key={i} className={`text-xs px-2 py-0.5 rounded border border-border ${dirColor(p.direction)}`}>
                {p.ticker} {p.direction} {p.size_pct}%
                {p.entry_price ? ` @${p.entry_price}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Knowledge updates */}
      {data.knowledge_updates && data.knowledge_updates.length > 0 && (
        <div className="border-t border-border pt-2 mt-2">
          <div className="text-xs text-text-muted mb-1">📝 Knowledge Updates:</div>
          {data.knowledge_updates.map((ku, i) => (
            <div key={i} className="text-xs text-text-secondary ml-2 mb-1">
              <span className="text-purple-400">[{ku.type}]</span> {ku.file}: {ku.content.slice(0, 120)}
              {ku.content.length > 120 ? '...' : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Layer synthesis summary */
export const AtlasLayerMessage: FC<{ data: AtlasLayerData }> = ({ data }) => {
  const time = new Date(data.timestamp).toLocaleTimeString()
  return (
    <div className="border-l-4 border-accent pl-3 py-2 mb-3">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${layerBadge(data.layer)}`}>
          {data.layer} Complete
        </span>
        <span className={`text-sm font-bold ${dirColor(data.direction)}`}>
          {dirIcon(data.direction)} {data.direction}
        </span>
        <span className="text-xs text-text-muted">
          Conviction: {data.conviction}% · Agreement: {Math.round(data.agreement * 100)}%
        </span>
        <span className="text-xs text-text-muted ml-auto">{time}</span>
      </div>
      <p className="text-sm text-text-secondary mt-1">{data.summary}</p>
    </div>
  )
}

/** Final report card */
export const AtlasReportMessage: FC<{ data: AtlasReportData }> = ({ data }) => {
  const time = new Date(data.timestamp).toLocaleTimeString()
  return (
    <div className="border-2 border-accent rounded-lg p-4 mb-3 bg-bg-secondary">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-bold text-accent">📊 Final Report</span>
        <span className="text-xs text-text-muted capitalize">{data.department}</span>
        <span className={`text-sm font-bold ${dirColor(data.direction)}`}>
          {dirIcon(data.direction)} {data.direction}
        </span>
        <span className="text-sm font-mono">{data.conviction}%</span>
        <span className="text-xs text-text-muted ml-auto">{time}</span>
      </div>
      <p className="text-sm text-text-secondary mb-3">{data.summary}</p>
      {data.positions?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.positions.map((p, i) => (
            <div key={i} className={`text-xs px-3 py-1.5 rounded border border-border ${dirColor(p.direction)}`}>
              <div className="font-semibold">{p.ticker}</div>
              <div>{p.direction} {p.size_pct}%</div>
              {p.entry_price && <div>Entry: {p.entry_price} SL: {p.stop_loss ?? '-'} TP: {p.take_profit?.join(', ') ?? '-'}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

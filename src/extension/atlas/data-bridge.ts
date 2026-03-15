/**
 * Atlas Data Bridge — Universal data layer for Atlas agents
 *
 * Connects all of Alice's data clients (equity, crypto, currency, economy, commodity, news)
 * to Atlas agents. Agents declare data_sources in their config; the bridge routes each source
 * to the correct client and method, formats the result as markdown context.
 *
 * Generic SDK sources use a transparent passthrough: type → client, method → client[method](params).
 */

import type { AgentConfig, DataSourceType } from './types.js'
import type { NewsCollectorStore } from '../news-collector/store.js'
import type { NewsRouter, TaggedNewsItem } from './news-router.js'

// ==================== Types ====================

/** Any SDK client that follows the duck-typed Record<string,unknown> → Record<string,unknown>[] pattern. */
export type GenericClient = Record<string, (params: Record<string, unknown>) => Promise<Record<string, unknown>[]>>

export interface DataBridgeDeps {
  /** Fetch OHLCV price data for a symbol. */
  fetchPrice: (symbol: string, interval: string) => Promise<PriceBar[]>
  /** Fetch macro indicator value (legacy). */
  fetchMacro: (provider: string, query: string, symbols: string[]) => Promise<MacroDataPoint[]>
  /** News collector store for deduped news. */
  newsStore: NewsCollectorStore
  /** All SDK clients keyed by DataSourceType. */
  clients: Partial<Record<DataSourceType, GenericClient>>
  /** Optional NewsRouter for layer-aware news filtering. */
  newsRouter?: NewsRouter
}

export interface PriceBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface MacroDataPoint {
  symbol: string
  date: string
  value: number
  label?: string
}

// ==================== Data Bridge ====================

export class DataBridge {
  private deps: DataBridgeDeps
  private timeframes: string[]
  private lastRunTimestamps: Map<string, Date> = new Map()

  constructor(deps: DataBridgeDeps, timeframes: string[] = ['15m', '4h', '1d']) {
    this.deps = deps
    this.timeframes = timeframes
  }

  /**
   * Check if an agent should run based on data freshness.
   * Price-based agents always run. News-only agents skip if no new news.
   */
  async shouldRun(agent: AgentConfig, departmentId: string): Promise<boolean> {
    const sources = agent.data_sources

    // No data sources (e.g. L4 decision layer — runs on upstream context only) → always run
    if (sources.length === 0) return true

    // Has price or generic SDK data source → always run
    if (sources.some((s) => s.type === 'price' || s.method)) return true

    // Pure news agent → only run if new news since last run
    if (sources.length > 0 && sources.every((s) => s.type === 'news')) {
      const lastRun = this.lastRunTimestamps.get(`${departmentId}:${agent.name}`)
      if (!lastRun) return true
      return this.hasNewNews(lastRun)
    }

    // Macro / generic agent → run
    return true
  }

  /**
   * Fetch all data for an agent and format as context string.
   */
  async fetchForAgent(agent: AgentConfig, departmentId: string): Promise<string> {
    const parts: string[] = []

    for (const source of agent.data_sources) {
      try {
        switch (source.type) {
          case 'price':
            parts.push(await this.fetchPriceContext(source.symbols ?? [], agent.name))
            break
          case 'news':
            parts.push(await this.fetchNewsContext(departmentId, agent))
            break
          case 'macro':
            parts.push(await this.fetchMacroContext(source.provider, source.query, source.symbols ?? []))
            break
          // Generic SDK client passthrough
          case 'equity':
          case 'economy':
          case 'crypto':
          case 'commodity':
          case 'currency':
            parts.push(await this.fetchGenericContext(source.type, source.method, source.params, source.symbols))
            break
        }
      } catch (err) {
        parts.push(`⚠️ Data fetch error (${source.type}/${source.method ?? source.query}): ${err}`)
      }
    }

    // Mark agent as run (only for agents that actually fetch data — L4 has no sources)
    if (agent.data_sources.length > 0) {
      this.lastRunTimestamps.set(`${departmentId}:${agent.name}`, new Date())
    }

    return parts.filter(Boolean).join('\n\n')
  }

  // ==================== Price Data ====================

  private async fetchPriceContext(symbols: string[], _agentName: string): Promise<string> {
    if (symbols.length === 0) return ''

    const lines: string[] = ['### Price Data']

    for (const symbol of symbols) {
      for (const tf of this.timeframes) {
        try {
          const bars = await this.deps.fetchPrice(symbol, tf)
          if (bars.length === 0) continue

          const latest = bars[bars.length - 1]
          const prev = bars.length > 1 ? bars[bars.length - 2] : latest
          const change = ((latest.close - prev.close) / prev.close * 100).toFixed(2)
          const high20 = Math.max(...bars.slice(-20).map((b) => b.high))
          const low20 = Math.min(...bars.slice(-20).map((b) => b.low))

          // Round volume to reduce hash churn (e.g. 1234567 → 1.23M)
          const vol = latest.volume >= 1e6 ? (latest.volume / 1e6).toFixed(1) + 'M'
            : latest.volume >= 1e3 ? (latest.volume / 1e3).toFixed(0) + 'K'
            : String(latest.volume)
          lines.push(
            `**${symbol} (${tf})**: Close=${latest.close.toFixed(2)} Change=${change}% ` +
            `High20=${high20.toFixed(2)} Low20=${low20.toFixed(2)} Vol=${vol}`,
          )
        } catch {
          lines.push(`**${symbol} (${tf})**: data unavailable`)
        }
      }
    }

    return lines.join('\n')
  }

  // ==================== News Data ====================

  private async fetchNewsContext(departmentId: string, agent: AgentConfig): Promise<string> {
    const lastRun = this.lastRunTimestamps.get(`${departmentId}:${agent.name}`)
    const startTime = lastRun ?? new Date(Date.now() - 24 * 60 * 60 * 1000)
    const endTime = new Date()

    const news = await this.deps.newsStore.getNews(startTime, endTime)
    if (news.length === 0) return '### News\nNo new news since last analysis.'

    // If NewsRouter available, route by agent layer + desk name
    const router = this.deps.newsRouter
    if (router) {
      return this.fetchRoutedNews(news, agent, router)
    }

    // Fallback: flat list (no routing)
    const lines: string[] = ['### Recent News']
    for (const item of news.slice(0, 20)) {
      const time = new Date(item.time).toISOString().slice(0, 16)
      lines.push(`- [${time}] ${item.title}`)
      if (item.content.length > 200) {
        lines.push(`  ${item.content.slice(0, 200)}...`)
      } else {
        lines.push(`  ${item.content}`)
      }
    }

    return lines.join('\n')
  }

  /** Route news through NewsRouter: L1 gets all, L2 gets desk-specific, L3 gets risk/events */
  private async fetchRoutedNews(
    rawNews: Array<{ title: string; content: string; time: Date; metadata: Record<string, string | null> }>,
    agent: AgentConfig,
    router: NewsRouter,
  ): Promise<string> {
    // Tag all news items
    const tagged = await router.tagFromCollector(
      rawNews.map((n) => ({
        title: n.title,
        content: n.content,
        metadata: n.metadata,
        pubTs: n.time.getTime(),
      })),
    )

    // Route by layer
    const routing = router.splitByLayer(tagged)
    const { NewsRouter: NR } = await import('./news-router.js')

    let items: TaggedNewsItem[]
    let label: string

    switch (agent.layer) {
      case 'L1':
        // L1 macro agents get ALL news
        items = routing.L1
        label = 'All News (L1 macro overview)'
        break
      case 'L2':
        // L2 desk agents get only their desk's news
        items = routing.L2[agent.name] ?? []
        label = `Desk News for ${agent.display_name}`
        break
      case 'L3':
        // L3 strategy agents already have L1+L2 synthesis as upstream context.
        // Only pass breaking/event news that might trigger strategy signals.
        items = routing.L3
        label = 'Breaking & Event News (L3)'
        break
      default:
        // L4 agents typically don't request news
        items = []
        label = 'News'
    }

    if (items.length === 0) return `### ${label}\nNo relevant news.`
    return NR.toText(label, items, 15)
  }

  // ==================== Macro Data (legacy) ====================

  private async fetchMacroContext(
    provider: string,
    query: string,
    symbols: string[],
  ): Promise<string> {
    if (symbols.length === 0) return ''

    const data = await this.deps.fetchMacro(provider, query, symbols)
    if (data.length === 0) return `### Macro (${provider})\nNo data available.`

    const lines: string[] = [`### Macro Data (${provider})`]
    for (const point of data) {
      const label = point.label ? ` (${point.label})` : ''
      lines.push(`- ${point.symbol}${label}: ${point.value} [${point.date}]`)
    }

    return lines.join('\n')
  }

  // ==================== Generic SDK Client ====================

  private async fetchGenericContext(
    type: DataSourceType,
    method?: string,
    params?: Record<string, unknown>,
    symbols?: string[],
  ): Promise<string> {
    if (!method) return `### ${type}\n⚠️ No method specified.`

    const client = this.deps.clients[type]
    if (!client) return `### ${type}\n⚠️ ${type} client not available.`

    const fn = client[method]
    if (typeof fn !== 'function') return `### ${type}\n⚠️ Unknown method: ${method}`

    // If symbols provided and no symbol in params, call per-symbol
    const mergedParams = { ...params }

    if (symbols && symbols.length > 0 && !mergedParams.symbol) {
      const allRows: Record<string, unknown>[] = []
      for (const sym of symbols) {
        try {
          const rows = await fn.call(client, { ...mergedParams, symbol: sym })
          if (!Array.isArray(rows)) continue
          for (const row of rows) {
            allRows.push({ _symbol: sym, ...row })
          }
        } catch (err) {
          allRows.push({ _symbol: sym, _error: String(err) })
        }
      }
      return this.formatGenericData(type, method, allRows)
    }

    const data = await fn.call(client, mergedParams)
    return this.formatGenericData(type, method, data)
  }

  /**
   * Format generic SDK response as readable markdown context for LLM agents.
   * Keeps it concise — limits rows and truncates wide objects.
   */
  private formatGenericData(type: string, method: string, data: Record<string, unknown>[]): string {
    if (!data || data.length === 0) return `### ${type}.${method}\nNo data returned.`

    const lines: string[] = [`### ${type}.${method} (${data.length} rows)`]

    // For large datasets, take head + tail
    const maxRows = 30
    const rows = data.length > maxRows
      ? [...data.slice(0, maxRows - 5), { _truncated: `... ${data.length - maxRows + 5} more rows ...` }, ...data.slice(-5)]
      : data

    for (const row of rows) {
      // Compact key=value format, skip nulls
      const entries = Object.entries(row)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => {
          const val = typeof v === 'number' ? formatNumber(v) : String(v).slice(0, 80)
          return `${k}=${val}`
        })
      lines.push(`- ${entries.join(' | ')}`)
    }

    return lines.join('\n')
  }

  // ==================== Helpers ====================

  private async hasNewNews(since: Date): Promise<boolean> {
    const news = await this.deps.newsStore.getNews(since, new Date())
    return news.length > 0
  }
}

/** Format numbers with reasonable precision. */
function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n)
  if (Math.abs(n) >= 1000) return n.toFixed(2)
  if (Math.abs(n) >= 1) return n.toFixed(4)
  return n.toPrecision(4)
}

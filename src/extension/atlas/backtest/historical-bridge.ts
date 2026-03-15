/**
 * Historical Data Bridge — Date-truncated data layer for backtesting
 *
 * Replaces the live DataBridge during walk-forward simulation.
 * All data queries return only information available up to the simulated date.
 *
 * - Price OHLCV: fetched via live fetchPrice, then truncated to simulatedDate
 * - FRED/macro: fetched via live fetchMacro, then truncated
 * - News: served from GDELT cache (pre-downloaded)
 * - SDK generic: passed through (historical where available)
 */

import type { AgentConfig, DataSourceType } from '../types.js'
import type { DataBridgeDeps, PriceBar, MacroDataPoint, GenericClient } from '../data-bridge.js'
import { GdeltFetcher } from './gdelt.js'
import { NewsRouter, type TaggedNewsItem, type LayerRouting } from '../news-router.js'
import type { LLMCallFn } from '../runner.js'

// ==================== Types ====================

export interface HistoricalBridgeDeps {
  /** Live price fetcher — will be truncated to simulatedDate */
  fetchPrice: (symbol: string, interval: string) => Promise<PriceBar[]>
  /** Live macro fetcher — will be truncated */
  fetchMacro: (provider: string, query: string, symbols: string[]) => Promise<MacroDataPoint[]>
  /** SDK clients for generic data */
  clients: Partial<Record<DataSourceType, GenericClient>>
  /** GDELT fetcher for historical news */
  gdelt: GdeltFetcher
  /** LLM call for NewsRouter AI fallback tagging */
  llmCall?: LLMCallFn
}

// ==================== Historical Bridge ====================

export class HistoricalDataBridge {
  private deps: HistoricalBridgeDeps
  private timeframes: string[]
  private newsRouter: NewsRouter

  /** The simulated "today" — set by the engine before each day's pipeline run */
  simulatedDate: string = ''

  /** Cache for price data (symbol → full history) to avoid refetching */
  private priceCache: Map<string, PriceBar[]> = new Map()

  /** Cache for tagged news routing (per simulated date) — avoids re-tagging same articles 25x */
  private newsRoutingCache: { date: string; routing: LayerRouting } | null = null

  constructor(deps: HistoricalBridgeDeps, timeframes: string[] = ['1d']) {
    this.deps = deps
    // For backtest, we only use daily data to reduce API calls
    this.timeframes = timeframes
    // NewsRouter with AI fallback for classification
    this.newsRouter = new NewsRouter({
      llmCall: deps.llmCall,
      aiEnabled: !!deps.llmCall,
      aiLimit: 20,
    })
  }

  /**
   * Pre-cache price data for symbols used by agents.
   * Call once before the simulation loop starts.
   */
  async preloadPrices(symbols: string[]): Promise<void> {
    const unique = [...new Set(symbols)]
    for (const symbol of unique) {
      if (this.priceCache.has(symbol)) continue
      try {
        const bars = await this.deps.fetchPrice(symbol, '1d')
        this.priceCache.set(symbol, bars)
      } catch (err) {
        console.warn(`backtest: failed to preload ${symbol}:`, err)
        this.priceCache.set(symbol, [])
      }
    }
  }

  /**
   * Fetch data for an agent, truncated to simulatedDate.
   * Drop-in replacement for DataBridge.fetchForAgent().
   */
  async fetchForAgent(agent: AgentConfig, _departmentId: string): Promise<string> {
    const parts: string[] = []

    for (const source of agent.data_sources) {
      try {
        switch (source.type) {
          case 'price':
            parts.push(await this.fetchPriceContext(source.symbols ?? []))
            break
          case 'news':
            parts.push(await this.fetchNewsContext(agent))
            break
          case 'macro':
            parts.push(await this.fetchMacroContext(source.provider, source.query, source.symbols ?? []))
            break
          case 'equity':
          case 'economy':
          case 'crypto':
          case 'commodity':
          case 'currency':
            parts.push(await this.fetchGenericContext(source.type, source.method, source.params, source.symbols))
            break
        }
      } catch (err) {
        parts.push(`Data unavailable (${source.type}): ${err}`)
      }
    }

    return parts.filter(Boolean).join('\n\n')
  }

  /**
   * Get forward return for a ticker from a given date.
   * Used by Scorecard to score past signals during backtest.
   */
  async getForwardReturn(ticker: string, date: string, days: number): Promise<number | null> {
    const bars = this.priceCache.get(ticker)
    if (!bars || bars.length < 2) return null

    const signalIdx = bars.findIndex((b) => b.date >= date)
    if (signalIdx < 0) return null

    const futureIdx = signalIdx + days
    if (futureIdx >= bars.length) return null

    // Prevent look-ahead bias: exit bar must not exceed simulatedDate
    if (this.simulatedDate && bars[futureIdx].date > this.simulatedDate) return null

    const entryPrice = bars[signalIdx].close
    const exitPrice = bars[futureIdx].close
    if (entryPrice === 0) return null

    return (exitPrice - entryPrice) / entryPrice
  }

  /**
   * shouldRun always returns true in backtest mode — every agent runs every day.
   */
  async shouldRun(_agent: AgentConfig, _departmentId: string): Promise<boolean> {
    return true
  }

  // ==================== Private ====================

  private async fetchPriceContext(symbols: string[]): Promise<string> {
    if (symbols.length === 0) return ''

    const lines: string[] = ['### Price Data']

    for (const symbol of symbols) {
      const allBars = this.priceCache.get(symbol) ?? []
      // Truncate to simulatedDate
      const bars = allBars.filter((b) => b.date <= this.simulatedDate)
      if (bars.length === 0) {
        lines.push(`**${symbol}**: no data available before ${this.simulatedDate}`)
        continue
      }

      const latest = bars[bars.length - 1]
      const prev = bars.length > 1 ? bars[bars.length - 2] : latest
      const change = ((latest.close - prev.close) / prev.close * 100).toFixed(2)
      const recent20 = bars.slice(-20)
      const high20 = Math.max(...recent20.map((b) => b.high))
      const low20 = Math.min(...recent20.map((b) => b.low))

      const vol = latest.volume >= 1e6 ? (latest.volume / 1e6).toFixed(1) + 'M'
        : latest.volume >= 1e3 ? (latest.volume / 1e3).toFixed(0) + 'K'
        : String(latest.volume)

      lines.push(
        `**${symbol} (1d)**: Close=${latest.close.toFixed(2)} Change=${change}% ` +
        `High20=${high20.toFixed(2)} Low20=${low20.toFixed(2)} Vol=${vol}`,
      )
    }

    return lines.join('\n')
  }

  private async fetchNewsContext(agent: AgentConfig): Promise<string> {
    // Use cached routing if same simulated date (avoids re-tagging same articles 25x per day)
    let routing: LayerRouting
    if (this.newsRoutingCache && this.newsRoutingCache.date === this.simulatedDate) {
      routing = this.newsRoutingCache.routing
    } else {
      // Get raw articles from GDELT cache
      const rawArticles = await this.deps.gdelt.getArticlesUpTo(this.simulatedDate)
      if (rawArticles.length === 0) {
        return '### Historical News\nNo news data available.'
      }

      // Tag articles through NewsRouter (rule-based + AI fallback)
      const tagged = await this.newsRouter.tagBatch(
        rawArticles.map((a) => ({
          title: a.title,
          summary: '', // GDELT articles don't have summaries
          source: a.source,
          publishedAt: a.date,
          origin: 'gdelt',
          sourceHint: '',
        })),
      )

      // Route by agent layer — same logic as live DataBridge
      routing = this.newsRouter.splitByLayer(tagged)
      this.newsRoutingCache = { date: this.simulatedDate, routing }
    }

    let items: TaggedNewsItem[]
    let label: string

    switch (agent.layer) {
      case 'L1':
        items = routing.L1
        label = `All News (L1 macro overview, up to ${this.simulatedDate})`
        break
      case 'L2':
        items = routing.L2[agent.name] ?? []
        label = `Desk News for ${agent.display_name} (up to ${this.simulatedDate})`
        break
      case 'L3':
        items = routing.L3
        label = `Breaking & Event News (L3, up to ${this.simulatedDate})`
        break
      default:
        items = []
        label = 'News'
    }

    if (items.length === 0) return `### ${label}\nNo relevant news.`
    return NewsRouter.toText(label, items, 15)
  }

  private async fetchMacroContext(
    provider: string,
    query: string,
    symbols: string[],
  ): Promise<string> {
    if (symbols.length === 0) return ''

    try {
      const data = await this.deps.fetchMacro(provider, query, symbols)
      // Truncate to simulatedDate
      const filtered = data.filter((d) => d.date <= this.simulatedDate)
      if (filtered.length === 0) return `### Macro (${provider})\nNo data before ${this.simulatedDate}.`

      const lines: string[] = [`### Macro Data (${provider})`]
      // Take last few data points
      for (const point of filtered.slice(-10)) {
        const label = point.label ? ` (${point.label})` : ''
        lines.push(`- ${point.symbol}${label}: ${point.value} [${point.date}]`)
      }
      return lines.join('\n')
    } catch {
      return `### Macro (${provider})\nData unavailable.`
    }
  }

  private async fetchGenericContext(
    type: DataSourceType,
    method?: string,
    params?: Record<string, unknown>,
    symbols?: string[],
  ): Promise<string> {
    if (!method) return ''
    const client = this.deps.clients[type]
    if (!client) return `### ${type}\n${type} client not available.`

    const fn = client[method]
    if (typeof fn !== 'function') return `### ${type}\nUnknown method: ${method}`

    try {
      if (symbols && symbols.length > 0) {
        const lines: string[] = [`### ${type}.${method}`]
        for (const sym of symbols) {
          const rows = await fn.call(client, { ...params, symbol: sym })
          for (const row of rows.slice(0, 5)) {
            const entries = Object.entries(row)
              .filter(([, v]) => v != null)
              .map(([k, v]) => `${k}=${v}`)
            lines.push(`- ${sym}: ${entries.join(' | ')}`)
          }
        }
        return lines.join('\n')
      }
      const data = await fn.call(client, params ?? {})
      return `### ${type}.${method}\n${data.slice(0, 10).map((r: Record<string, unknown>) =>
        Object.entries(r).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(' | ')
      ).join('\n')}`
    } catch {
      return `### ${type}.${method}\nData unavailable.`
    }
  }
}

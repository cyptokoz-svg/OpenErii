/**
 * Atlas Data Bridge — Connects Alice's opentypebb data layer to Atlas agents
 *
 * Fetches market data (price, news, macro) from Alice's existing providers,
 * formats it as text context, and distributes to agents based on their dataSources config.
 */

import type { AgentConfig } from './types.js'
import type { NewsCollectorStore } from '../news-collector/store.js'

// ==================== Types ====================

export interface DataBridgeDeps {
  /** Fetch OHLCV price data for a symbol. */
  fetchPrice: (symbol: string, interval: string) => Promise<PriceBar[]>
  /** Fetch macro indicator value. */
  fetchMacro: (provider: string, query: string, symbols: string[]) => Promise<MacroDataPoint[]>
  /** News collector store for deduped news. */
  newsStore: NewsCollectorStore
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

    // Has price data source → always run (prices are real-time)
    if (sources.some((s) => s.type === 'price')) return true

    // Pure news agent → only run if new news since last run
    if (sources.every((s) => s.type === 'news')) {
      const lastRun = this.lastRunTimestamps.get(`${departmentId}:${agent.name}`)
      if (!lastRun) return true // First run
      const hasNew = await this.hasNewNews(lastRun)
      return hasNew
    }

    // Macro agent → run (data updates are infrequent but important)
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
            parts.push(await this.fetchNewsContext(departmentId, agent.name))
            break
          case 'macro':
            parts.push(await this.fetchMacroContext(source.provider, source.query, source.symbols ?? []))
            break
        }
      } catch (err) {
        parts.push(`⚠️ Data fetch error (${source.provider}/${source.query}): ${err}`)
      }
    }

    // Mark agent as run
    this.lastRunTimestamps.set(`${departmentId}:${agent.name}`, new Date())

    return parts.filter(Boolean).join('\n\n')
  }

  // ==================== Price Data ====================

  private async fetchPriceContext(symbols: string[], agentName: string): Promise<string> {
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

          lines.push(
            `**${symbol} (${tf})**: Close=${latest.close.toFixed(2)} Change=${change}% ` +
            `High20=${high20.toFixed(2)} Low20=${low20.toFixed(2)} Vol=${latest.volume}`,
          )
        } catch {
          lines.push(`**${symbol} (${tf})**: data unavailable`)
        }
      }
    }

    return lines.join('\n')
  }

  // ==================== News Data ====================

  private async fetchNewsContext(departmentId: string, agentName: string): Promise<string> {
    const lastRun = this.lastRunTimestamps.get(`${departmentId}:${agentName}`)
    const startTime = lastRun ?? new Date(Date.now() - 24 * 60 * 60 * 1000) // Default: last 24h
    const endTime = new Date()

    const news = await this.deps.newsStore.getNews(startTime, endTime)
    if (news.length === 0) return '### News\nNo new news since last analysis.'

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

  // ==================== Macro Data ====================

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

  // ==================== Helpers ====================

  private async hasNewNews(since: Date): Promise<boolean> {
    const news = await this.deps.newsStore.getNews(since, new Date())
    return news.length > 0
  }
}

/**
 * Atlas Data Bridge — Universal data layer for Atlas agents
 *
 * Connects all of Alice's data clients (equity, crypto, currency, economy, commodity, news)
 * to Atlas agents. Agents declare data_sources in their config; the bridge routes each source
 * to the correct client and method, formats the result as markdown context.
 *
 * Generic SDK sources use a transparent passthrough: type → client, method → client[method](params).
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import type { AgentConfig, DataSourceType } from './types.js'
import type { NewsCollectorStore } from '../news-collector/store.js'
import type { NewsRouter, TaggedNewsItem } from './news-router.js'

// ==================== Types ====================

/** Any SDK client that follows the duck-typed Record<string,unknown> → Record<string,unknown>[] pattern. */
export type GenericClient = Record<string, (params: Record<string, unknown>) => Promise<Record<string, unknown>[]>>

export interface DataBridgeDeps {
  /** Fetch OHLCV price data for a symbol. Optional startDate for backtest full range. */
  fetchPrice: (symbol: string, interval: string, startDate?: string) => Promise<PriceBar[]>
  /** Fetch macro indicator value (legacy). */
  fetchMacro: (provider: string, query: string, symbols: string[]) => Promise<MacroDataPoint[]>
  /** News collector store for deduped news. */
  newsStore: NewsCollectorStore
  /** All SDK clients keyed by DataSourceType. */
  clients: Partial<Record<DataSourceType, GenericClient>>
  /** Optional NewsRouter for layer-aware news filtering. */
  newsRouter?: NewsRouter
  /**
   * Path to persist news cursor timestamps across restarts.
   * Defaults to data/atlas/state/news_cursors.json if not provided.
   */
  cursorFile?: string
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
  private cursorFile: string

  constructor(deps: DataBridgeDeps, timeframes: string[] = ['15m', '4h', '1d']) {
    this.deps = deps
    this.timeframes = timeframes
    this.cursorFile = deps.cursorFile ?? resolve('data/atlas/state/news_cursors.json')
  }

  /**
   * Load persisted news cursor timestamps from disk.
   * Call once after construction to restore state across restarts.
   */
  async loadCursors(): Promise<void> {
    try {
      const raw = await readFile(this.cursorFile, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, string>
      for (const [key, isoDate] of Object.entries(parsed)) {
        this.lastRunTimestamps.set(key, new Date(isoDate))
      }
    } catch {
      // File not found or invalid — start fresh (first run)
    }
  }

  /** Persist current cursor timestamps to disk (fire-and-forget). */
  private saveCursors(): void {
    const obj: Record<string, string> = {}
    for (const [key, date] of this.lastRunTimestamps.entries()) {
      obj[key] = date.toISOString()
    }
    mkdir(dirname(this.cursorFile), { recursive: true })
      .then(() => writeFile(this.cursorFile, JSON.stringify(obj, null, 2)))
      .catch(() => { /* non-critical — in-memory state still valid */ })
  }

  /**
   * Check if an agent should run based on data freshness.
   * Price-based agents always run. News-only agents skip if no new news.
   */
  async shouldRun(agent: AgentConfig, departmentId: string): Promise<boolean> {
    const sources = agent.data_sources

    // No data sources (e.g. L4 decision layer — runs on upstream context only) → always run
    if (sources.length === 0) return true

    // Has price, current_price, or generic SDK data source → always run
    if (sources.some((s) => s.type === 'price' || s.type === 'current_price' || s.method)) return true

    // All other agents (news-only, macro-only) → always run
    // News dedup is handled inside fetchNewsContext; don't gate at the agent level
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
          case 'current_price':
            parts.push(await this.fetchCurrentPriceContext(source.symbols ?? []))
            break
          case 'news':
            parts.push(await this.fetchNewsContext(departmentId, agent))
            break
          case 'macro':
            parts.push(await this.fetchMacroContext(source.provider, source.query, source.symbols ?? []))
            break
          case 'correlation':
            parts.push(await this.fetchCorrelationContext(source.symbols ?? [], source.params))
            break
          // Generic SDK client passthrough
          case 'equity':
          case 'economy':
          case 'crypto':
          case 'commodity':
          case 'currency':
          case 'cot':
          case 'derivatives':
          case 'volatility':
          case 'weather':
            parts.push(await this.fetchGenericContext(source.type, source.method, source.params, source.symbols))
            break
        }
      } catch (err) {
        parts.push(`⚠️ Data fetch error (${source.type}/${source.method ?? source.query}): ${err}`)
      }
    }

    // Mark agent as run and persist cursor (only for agents that actually fetch data — L4 has no sources)
    if (agent.data_sources.length > 0) {
      this.lastRunTimestamps.set(`${departmentId}:${agent.name}`, new Date())
      this.saveCursors()
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

          // Technical indicators computed from the full bar sequence
          const closes = bars.map((b) => b.close)
          const rsi = computeRSI(closes)
          const bb = computeBollinger(closes)
          const macd = computeMACD(closes)
          const atr = computeATR(bars)
          const adx = computeADX(bars)
          const ema20 = computeEMA(closes, 20)
          const ema50 = computeEMA(closes, 50)

          let line = `**${symbol} (${tf})**: Close=${latest.close.toFixed(2)} Change=${change}% ` +
            `High20=${high20.toFixed(2)} Low20=${low20.toFixed(2)} Vol=${vol}`
          if (rsi !== null) line += ` RSI14=${rsi.toFixed(1)}`
          if (bb !== null) line += ` BB(${bb.lower.toFixed(2)}/${bb.mid.toFixed(2)}/${bb.upper.toFixed(2)})`
          if (ema20.length > 0) line += ` EMA20=${ema20[ema20.length - 1].toFixed(2)}`
          if (ema50.length > 0) line += ` EMA50=${ema50[ema50.length - 1].toFixed(2)}`
          if (macd !== null) line += ` MACD=${macd.macd.toFixed(3)}/Sig=${macd.signal.toFixed(3)}/Hist=${macd.histogram.toFixed(3)}`
          if (atr !== null) line += ` ATR14=${atr.toFixed(2)}`
          if (adx !== null) line += ` ADX14=${adx.adx.toFixed(1)}(+DI=${adx.plusDI.toFixed(1)}/-DI=${adx.minusDI.toFixed(1)})`
          lines.push(line)
        } catch {
          lines.push(`**${symbol} (${tf})**: data unavailable`)
        }
      }
    }

    return lines.join('\n')
  }

  // ==================== Current Price (lightweight, for L4) ====================

  private async fetchCurrentPriceContext(symbols: string[]): Promise<string> {
    if (symbols.length === 0) return ''
    const equityClient = this.deps.clients.equity
    if (!equityClient) return ''

    const parts: string[] = []
    for (const symbol of symbols) {
      try {
        const rows = await equityClient.getQuote({ symbol })
        const q = rows[0]
        if (!q) continue
        const price = Number(q.last_price ?? q.last ?? q.price ?? q.close ?? 0)
        const changePctRaw = q.change_percent ?? q.percent_change ?? q.change_pct ?? null
        if (!price) continue
        const pctStr = changePctRaw == null ? '' : ` (${Number(changePctRaw) >= 0 ? '+' : ''}${Number(changePctRaw).toFixed(2)}%)`
        parts.push(`${symbol}: $${price.toFixed(2)}${pctStr}`)
      } catch {
        // skip failed symbol
      }
    }
    if (parts.length === 0) return ''
    return `### Current Prices\n${parts.join(' | ')}`
  }

  // ==================== Cross-Asset Correlation ====================

  /**
   * Fetch daily closes for multiple symbols, compute Pearson correlation matrix
   * over 30/60/90-day windows, and calculate key macro ratios.
   *
   * params.periods: number[] — lookback windows in days (default [30, 60, 90])
   * symbols: yfinance-style tickers, e.g. ['CL=F', 'GC=F', 'SI=F', 'HG=F', 'DX-Y.NYB', '^VIX']
   */
  private async fetchCorrelationContext(
    symbols: string[],
    params?: Record<string, unknown>,
  ): Promise<string> {
    if (symbols.length < 2) return '### Cross-Asset Correlations\n⚠️ Need at least 2 symbols.'

    const periods = Array.isArray(params?.periods)
      ? (params.periods as number[])
      : [30, 60, 90]
    const maxPeriod = Math.max(...periods)

    // Fetch daily bars for all symbols (need maxPeriod + buffer)
    const closesMap = new Map<string, Map<string, number>>() // symbol → (date → close)
    const fetchErrors: string[] = []

    await Promise.all(symbols.map(async (sym) => {
      try {
        const bars = await this.deps.fetchPrice(sym, '1d')
        if (bars.length === 0) { fetchErrors.push(sym); return }
        const dateMap = new Map<string, number>()
        for (const b of bars) dateMap.set(b.date.slice(0, 10), b.close)
        closesMap.set(sym, dateMap)
      } catch {
        fetchErrors.push(sym)
      }
    }))

    // Intersect dates — only include days where ALL symbols have data
    const availSymbols = symbols.filter((s) => closesMap.has(s))
    if (availSymbols.length < 2) {
      return `### Cross-Asset Correlations\n⚠️ Insufficient data (fetched ${availSymbols.length}/${symbols.length} symbols).`
    }

    // Collect all dates that exist in every symbol's map, sorted desc
    let commonDates: string[] = []
    for (const [i, sym] of availSymbols.entries()) {
      const dates = [...(closesMap.get(sym)?.keys() ?? [])]
      if (i === 0) {
        commonDates = dates
      } else {
        const set = closesMap.get(sym)!
        commonDates = commonDates.filter((d) => set.has(d))
      }
    }
    commonDates.sort().reverse() // newest first

    if (commonDates.length < periods[0]) {
      return `### Cross-Asset Correlations\n⚠️ Only ${commonDates.length} common trading days — need at least ${periods[0]}.`
    }

    const lines: string[] = ['### Cross-Asset Correlations']
    if (fetchErrors.length > 0) lines.push(`⚠️ Failed to fetch: ${fetchErrors.join(', ')}`)

    // Helper: get aligned returns series for a symbol over last N days
    const getReturns = (sym: string, n: number): number[] => {
      const map = closesMap.get(sym)!
      const dates = commonDates.slice(0, n + 1) // n+1 closes → n returns
      const closes = dates.map((d) => map.get(d)!).reverse() // oldest first
      const returns: number[] = []
      for (let i = 1; i < closes.length; i++) {
        returns.push((closes[i] - closes[i - 1]) / closes[i - 1])
      }
      return returns
    }

    // Pearson correlation
    const pearson = (a: number[], b: number[]): number => {
      const n = Math.min(a.length, b.length)
      if (n < 5) return NaN
      const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n
      const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n
      let num = 0, da2 = 0, db2 = 0
      for (let i = 0; i < n; i++) {
        const da = a[i] - meanA, db = b[i] - meanB
        num += da * db; da2 += da * da; db2 += db * db
      }
      const denom = Math.sqrt(da2 * db2)
      return denom === 0 ? 0 : num / denom
    }

    // Build correlation table for all pairs
    const pairs: Array<[string, string]> = []
    for (let i = 0; i < availSymbols.length - 1; i++) {
      for (let j = i + 1; j < availSymbols.length; j++) {
        pairs.push([availSymbols[i], availSymbols[j]])
      }
    }

    const header = `| Pair${' '.repeat(Math.max(0, 22 - 4))} | ${periods.map((p) => `${p}d`.padStart(6)).join(' | ')} |`
    const sep = `|${'-'.repeat(header.length - 2)}|`
    lines.push('')
    lines.push(`Lookback: ${periods.join('/')} days (daily log-returns, common trading days: ${Math.min(commonDates.length, maxPeriod + 1)})`)
    lines.push(header)
    lines.push(sep)

    for (const [a, b] of pairs) {
      const label = `${a}↔${b}`.padEnd(22)
      const cols = periods.map((p) => {
        const n = Math.min(p, commonDates.length - 1)
        const ra = getReturns(a, n)
        const rb = getReturns(b, n)
        const r = pearson(ra, rb)
        if (isNaN(r)) return '  n/a '
        const sign = r >= 0 ? '+' : ''
        return `${sign}${r.toFixed(2)}`.padStart(6)
      })
      lines.push(`| ${label} | ${cols.join(' | ')} |`)
    }

    // Key ratios (current price + rolling averages)
    const ratios: string[] = []
    const symToClose = (sym: string, daysAgo = 0): number | null => {
      const map = closesMap.get(sym)
      if (!map) return null
      const date = commonDates[daysAgo]
      return date ? (map.get(date) ?? null) : null
    }
    const rollingAvg = (sym: string, n: number): number | null => {
      const map = closesMap.get(sym)
      if (!map) return null
      const dates = commonDates.slice(0, n)
      const vals = dates.map((d) => map.get(d)).filter((v): v is number => v !== undefined)
      return vals.length === 0 ? null : vals.reduce((s, v) => s + v, 0) / vals.length
    }

    // Gold/Silver ratio
    const gcNow = symToClose('GC=F') ?? symToClose('GC')
    const siNow = symToClose('SI=F') ?? symToClose('SI')
    if (gcNow && siNow) {
      const ratio = gcNow / siNow
      const avg30 = (() => { const g = rollingAvg('GC=F', 30) ?? rollingAvg('GC', 30); const s = rollingAvg('SI=F', 30) ?? rollingAvg('SI', 30); return g && s ? g / s : null })()
      const avg90 = (() => { const g = rollingAvg('GC=F', 90) ?? rollingAvg('GC', 90); const s = rollingAvg('SI=F', 90) ?? rollingAvg('SI', 90); return g && s ? g / s : null })()
      let r = `- Gold/Silver Ratio: ${ratio.toFixed(1)}`
      if (avg30) r += ` (30d avg: ${avg30.toFixed(1)}`
      if (avg90) r += ` | 90d avg: ${avg90.toFixed(1)}`
      if (avg30 || avg90) r += ')'
      ratios.push(r)
    }

    // Copper/Gold ratio
    const hgNow = symToClose('HG=F') ?? symToClose('HG')
    const gcNow2 = gcNow
    if (hgNow && gcNow2) {
      const ratio = hgNow / gcNow2
      const avg30 = (() => { const h = rollingAvg('HG=F', 30) ?? rollingAvg('HG', 30); const g = rollingAvg('GC=F', 30) ?? rollingAvg('GC', 30); return h && g ? h / g : null })()
      const avg90 = (() => { const h = rollingAvg('HG=F', 90) ?? rollingAvg('HG', 90); const g = rollingAvg('GC=F', 90) ?? rollingAvg('GC', 90); return h && g ? h / g : null })()
      let r = `- Copper/Gold Ratio: ${ratio.toFixed(5)}`
      if (avg30) r += ` (30d avg: ${avg30.toFixed(5)}`
      if (avg90) r += ` | 90d avg: ${avg90.toFixed(5)}`
      if (avg30 || avg90) r += ')'
      ratios.push(r)
    }

    if (ratios.length > 0) {
      lines.push('')
      lines.push('**Key Macro Ratios**')
      lines.push(...ratios)
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

/**
 * RSI (Relative Strength Index) using Wilder's smoothing method.
 * Requires at least period+1 closes. Returns null if insufficient data.
 */
function computeEMA(closes: number[], period: number): number[] {
  if (closes.length === 0) return []
  const k = 2 / (period + 1)
  const result: number[] = [closes[0]]
  for (let i = 1; i < closes.length; i++) {
    result.push(closes[i] * k + result[i - 1] * (1 - k))
  }
  return result
}

/** MACD (12/26/9). Returns { macd, signal, histogram } or null. */
function computeMACD(closes: number[]): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < 35) return null
  const ema12 = computeEMA(closes, 12)
  const ema26 = computeEMA(closes, 26)
  const macdLine = ema12.map((v, i) => v - ema26[i]).slice(25)
  if (macdLine.length < 9) return null
  const signalLine = computeEMA(macdLine, 9)
  const macd = macdLine[macdLine.length - 1]
  const signal = signalLine[signalLine.length - 1]
  return { macd, signal, histogram: macd - signal }
}

/** ATR (14-period Average True Range). Returns value or null. */
function computeATR(bars: { high: number; low: number; close: number }[], period = 14): number | null {
  if (bars.length < period + 1) return null
  const trs: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    ))
  }
  // Wilder's smoothing
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
  }
  return atr
}

/** ADX (14-period). Returns { adx, plusDI, minusDI } or null. */
function computeADX(bars: { high: number; low: number; close: number }[], period = 14): { adx: number; plusDI: number; minusDI: number } | null {
  if (bars.length < period * 2 + 1) return null

  const plusDMs: number[] = []
  const minusDMs: number[] = []
  const trs: number[] = []

  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].high - bars[i - 1].high
    const downMove = bars[i - 1].low - bars[i].low
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0)
    const prevClose = bars[i - 1].close
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose)))
  }

  // Wilder smooth
  const smooth = (arr: number[]) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0)
    const out = [s]
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s) }
    return out
  }
  const sTR = smooth(trs)
  const sPDM = smooth(plusDMs)
  const sMDM = smooth(minusDMs)

  const dxArr: number[] = []
  for (let i = 0; i < sTR.length; i++) {
    if (sTR[i] === 0) continue
    const pdi = 100 * sPDM[i] / sTR[i]
    const mdi = 100 * sMDM[i] / sTR[i]
    const sum = pdi + mdi
    dxArr.push(sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum)
  }
  if (dxArr.length < period) return null

  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < dxArr.length; i++) { adx = (adx * (period - 1) + dxArr[i]) / period }

  const last = sTR.length - 1
  const plusDI = sTR[last] === 0 ? 0 : 100 * sPDM[last] / sTR[last]
  const minusDI = sTR[last] === 0 ? 0 : 100 * sMDM[last] / sTR[last]
  return { adx, plusDI, minusDI }
}

function computeRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null

  const changes = closes.slice(1).map((c, i) => c - closes[i])

  // Seed with simple average over first `period` changes
  let avgGain = changes.slice(0, period).reduce((s, c) => s + (c > 0 ? c : 0), 0) / period
  let avgLoss = changes.slice(0, period).reduce((s, c) => s + (c < 0 ? -c : 0), 0) / period

  // Wilder's smoothing for remaining changes
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0
    const loss = changes[i] < 0 ? -changes[i] : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }

  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

/**
 * Bollinger Bands (20-period SMA ± 2σ).
 * Returns { lower, mid, upper } or null if insufficient data.
 */
function computeBollinger(
  closes: number[],
  period = 20,
  mult = 2,
): { lower: number; mid: number; upper: number } | null {
  if (closes.length < period) return null
  const slice = closes.slice(-period)
  const mid = slice.reduce((s, c) => s + c, 0) / period
  const variance = slice.reduce((s, c) => s + (c - mid) ** 2, 0) / period
  const std = Math.sqrt(variance)
  return { lower: mid - mult * std, mid, upper: mid + mult * std }
}

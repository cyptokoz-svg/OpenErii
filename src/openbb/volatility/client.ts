/**
 * Volatility Client — Options-implied volatility and VIX term structure
 *
 * Uses yfinance-compatible symbols via Yahoo Finance API (no key needed).
 * Provides: VIX term structure, commodity vol indices, ETF options skew.
 */

// ==================== Types ====================

export interface VolRecord {
  symbol: string
  date: string
  close: number
  pct_change_1d: number
}

export interface OptionsSkewRecord {
  symbol: string
  expiry: string
  atm_iv: number
  put_iv_25d: number
  call_iv_25d: number
  put_call_skew: number
}

// ==================== Client ====================

export class VolatilityClient {
  private readonly baseUrl = 'https://query1.finance.yahoo.com/v8/finance/chart'
  private readonly optionsUrl = 'https://query1.finance.yahoo.com/v7/finance/options'

  /**
   * Fetch VIX term structure: ^VIX (spot), ^VIX3M (3-month), ^VIX6M (6-month).
   * Returns array of { symbol, date, close, pct_change_1d } rows for last 30 days.
   */
  async getVixTermStructure(params: Record<string, unknown> = {}): Promise<VolRecord[]> {
    const symbols = ['%5EVIX', '%5EVIX3M', '%5EVIX6M'] // URL-encoded ^VIX, ^VIX3M, ^VIX6M
    const displaySymbols = ['^VIX', '^VIX3M', '^VIX6M']
    const results: VolRecord[] = []

    for (let i = 0; i < symbols.length; i++) {
      try {
        const rows = await this.fetchChartData(symbols[i], displaySymbols[i])
        results.push(...rows)
      } catch {
        // skip failed symbol — never throw
      }
    }

    return results
  }

  /**
   * Fetch commodity volatility indices: ^OVX (crude oil vol), ^GVZ (gold vol).
   * Accept optional params.symbols to override defaults.
   */
  async getCommodityVol(params: Record<string, unknown> = {}): Promise<VolRecord[]> {
    const defaultSymbols = ['^OVX', '^GVZ']
    const inputSymbols = Array.isArray(params.symbols)
      ? (params.symbols as string[])
      : defaultSymbols

    const results: VolRecord[] = []

    for (const sym of inputSymbols) {
      try {
        const encoded = encodeURIComponent(sym)
        const rows = await this.fetchChartData(encoded, sym)
        results.push(...rows)
      } catch {
        // skip failed symbol
      }
    }

    return results
  }

  /**
   * Fetch options chain for an ETF and return front-month IV metrics.
   * Default ETF: USO (crude) or GLD (gold), configurable via params.symbol.
   * Returns ATM IV, 25-delta put IV, 25-delta call IV, and put/call skew.
   */
  async getOptionsSkew(params: Record<string, unknown> = {}): Promise<OptionsSkewRecord[]> {
    const symbol = String(params.symbol ?? 'GLD')

    try {
      const url = `${this.optionsUrl}/${symbol}`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      })

      if (!res.ok) return []

      const json = await res.json() as Record<string, unknown>
      const optionChain = (json as any)?.optionChain?.result?.[0]
      if (!optionChain) return []

      const underlyingPrice: number = optionChain.quote?.regularMarketPrice ?? 0
      if (!underlyingPrice) return []

      // Get front-month options (first expiration)
      const expirationDates: number[] = optionChain.expirationDates ?? []
      if (expirationDates.length === 0) return []

      const frontExpiry = expirationDates[0]
      const expiryDate = new Date(frontExpiry * 1000).toISOString().slice(0, 10)

      // Fetch options for front expiry
      const expiryUrl = `${this.optionsUrl}/${symbol}?date=${frontExpiry}`
      const expiryRes = await fetch(expiryUrl, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      })
      if (!expiryRes.ok) return []

      const expiryJson = await expiryRes.json() as Record<string, unknown>
      const chain = (expiryJson as any)?.optionChain?.result?.[0]
      if (!chain) return []

      const calls: any[] = chain.options?.[0]?.calls ?? []
      const puts: any[] = chain.options?.[0]?.puts ?? []

      if (calls.length === 0 || puts.length === 0) return []

      // Find ATM option (strike closest to current price)
      const findClosest = (options: any[], targetStrike: number) => {
        return options.reduce((best, opt) => {
          const diff = Math.abs(opt.strike - targetStrike)
          const bestDiff = Math.abs(best.strike - targetStrike)
          return diff < bestDiff ? opt : best
        })
      }

      const atmCall = findClosest(calls, underlyingPrice)
      const atmPut = findClosest(puts, underlyingPrice)
      const atmIv = ((atmCall.impliedVolatility ?? 0) + (atmPut.impliedVolatility ?? 0)) / 2

      // Approximate 25-delta: strikes ~10% OTM from ATM
      const otmFactor = 0.90
      const otmCallStrike = underlyingPrice * (1 + (1 - otmFactor))
      const otmPutStrike = underlyingPrice * otmFactor

      const otmCall = findClosest(calls, otmCallStrike)
      const otmPut = findClosest(puts, otmPutStrike)

      const callIv25d = otmCall.impliedVolatility ?? 0
      const putIv25d = otmPut.impliedVolatility ?? 0
      const skew = putIv25d - callIv25d

      return [{
        symbol,
        expiry: expiryDate,
        atm_iv: Math.round(atmIv * 10000) / 100, // as percentage
        put_iv_25d: Math.round(putIv25d * 10000) / 100,
        call_iv_25d: Math.round(callIv25d * 10000) / 100,
        put_call_skew: Math.round(skew * 10000) / 100,
      }]
    } catch {
      return []
    }
  }

  // ==================== Private Helpers ====================

  private async fetchChartData(encodedSymbol: string, displaySymbol: string): Promise<VolRecord[]> {
    const url = `${this.baseUrl}/${encodedSymbol}?interval=1d&range=30d`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })

    if (!res.ok) return []

    const json = await res.json() as Record<string, unknown>
    const result = (json as any)?.chart?.result?.[0]
    if (!result) return []

    const timestamps: number[] = result.timestamp ?? []
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? []

    if (timestamps.length === 0 || closes.length === 0) return []

    const rows: VolRecord[] = []
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i]
      if (close == null || isNaN(close)) continue

      const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10)
      const prevClose = i > 0 ? (closes[i - 1] ?? close) : close
      const pctChange = prevClose !== 0
        ? Math.round(((close - prevClose) / prevClose) * 10000) / 100
        : 0

      rows.push({ symbol: displaySymbol, date, close: Math.round(close * 100) / 100, pct_change_1d: pctChange })
    }

    return rows
  }
}

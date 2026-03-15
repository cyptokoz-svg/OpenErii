/**
 * Atlas Scorecard — Agent attribution scoring + Darwinian weights
 *
 * Ported from ATLAS-Commodity's scorecard.py.
 * Records signals, backfills forward returns, manages agent weights.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import type { AtlasConfig, Direction, AgentScore, SignalRecord } from './types.js'

// ==================== Ticker Normalization ====================

/** Map natural-language or shorthand tickers to Yahoo Finance symbols. */
const TICKER_MAP: Record<string, string> = {
  'crude_oil_wti': 'CL=F', 'crude_oil_brent': 'BZ=F', 'natural_gas': 'NG=F',
  'heating_oil': 'HO=F', 'gasoline': 'RB=F',
  'copper_hg': 'HG=F', 'aluminum_al': 'ALI=F', 'zinc_zn': 'ZN=F',
  'nickel_ni': 'NI=F', 'tin_sn': 'SN=F', 'iron ore': 'TIO=F',
  'wheat_zw': 'ZW=F', 'corn_zc': 'ZC=F', 'soybean_zs': 'ZS=F', 'grains': 'ZW=F',
  'coffee_kc': 'KC=F', 'sugar_sb': 'SB=F', 'cotton_ct': 'CT=F',
  'live_cattle_le': 'LE=F', 'feeder_cattle_gf': 'GF=F', 'lean_hogs_he': 'HE=F',
  'coal': 'MTF=F',
  // Shorthand without =F
  'CL': 'CL=F', 'GC': 'GC=F', 'SI': 'SI=F', 'NG': 'NG=F',
  'HG': 'HG=F', 'LE': 'LE=F', 'GF': 'GF=F', 'HE': 'HE=F',
  'ZS': 'ZS=F', 'ZL': 'ZL=F', 'ZW': 'ZW=F', 'ZC': 'ZC=F',
  'JO': 'JO',
}

function normalizeTicker(ticker: string): string {
  return TICKER_MAP[ticker] ?? ticker
}

// ==================== Constants ====================

interface DarwinianConfig {
  initial_weight: number
  min_weight: number
  max_weight: number
  sharpe_lookback_days: number
}

const DEFAULT_DARWINIAN: DarwinianConfig = {
  initial_weight: 1.0,
  min_weight: 0.3,
  max_weight: 3.0,
  sharpe_lookback_days: 30,
}

// ==================== Scorecard ====================

export class Scorecard {
  private departmentId: string
  private darwinian: DarwinianConfig
  private weightsFile: string
  private scoresFile: string
  private weights: Record<string, number> = {}
  private signals: Record<string, SignalRecord[]> = {}

  constructor(departmentId: string, config: AtlasConfig) {
    this.departmentId = departmentId
    this.darwinian = DEFAULT_DARWINIAN

    const stateDir = resolve('data/atlas', departmentId, 'state')
    this.weightsFile = resolve(stateDir, 'weights.json')
    this.scoresFile = resolve(stateDir, 'scores.json')
  }

  // ==================== Persistence ====================

  async load(): Promise<void> {
    this.weights = await this.readJson(this.weightsFile) ?? {}
    this.signals = await this.readJson(this.scoresFile) ?? {}
  }

  async save(): Promise<void> {
    await this.writeJson(this.weightsFile, this.weights)
    await this.writeJson(this.scoresFile, this.signals)
  }

  // ==================== Weights ====================

  getWeight(agentName: string): number {
    return this.weights[agentName] ?? this.darwinian.initial_weight
  }

  getAllWeights(): Record<string, number> {
    return { ...this.weights }
  }

  // ==================== Signal Recording ====================

  recordSignal(
    agentName: string,
    direction: Direction,
    conviction: number,
    targets: string[],
    date: string,
  ): void {
    if (!this.signals[agentName]) {
      this.signals[agentName] = []
    }

    // Dedup: don't record same agent+date twice
    const existing = this.signals[agentName].find((s) => s.date === date)
    if (existing) return

    this.signals[agentName].push({
      agent: agentName,
      department: this.departmentId,
      direction,
      conviction,
      targets,
      date,
      scored: false,
    })
  }

  // ==================== Forward Return Backfill ====================

  /**
   * Score past signals by looking up actual market returns.
   * Returns number of signals scored.
   */
  async scorePastSignals(
    getReturn: (ticker: string, date: string, days: number) => Promise<number | null>,
    referenceDate?: string,
  ): Promise<number> {
    let scored = 0
    const forwardDays = 5

    // Reference date for minimum elapsed check (backtest uses simulated date)
    const refMs = referenceDate ? new Date(referenceDate).getTime() : Date.now()

    for (const [agentName, records] of Object.entries(this.signals)) {
      for (const record of records) {
        if (record.scored) continue
        if (record.targets.length === 0) continue

        // Only score signals that are at least forwardDays old
        const signalMs = new Date(record.date).getTime()
        const elapsedDays = (refMs - signalMs) / (86400 * 1000)
        if (elapsedDays < forwardDays) continue

        // Use first target for scoring (normalize to Yahoo Finance symbol)
        const ticker = normalizeTicker(record.targets[0])
        const forwardReturn = await getReturn(ticker, record.date, forwardDays)
        if (forwardReturn === null) continue

        record.forward_return = forwardReturn
        record.forward_days = forwardDays
        record.scored = true
        scored++
      }
    }

    // Update weights based on new scores
    if (scored > 0) {
      this.updateWeights(referenceDate)
    }

    return scored
  }

  // ==================== Weight Update ====================

  private updateWeights(referenceDate?: string): void {
    for (const [agentName, records] of Object.entries(this.signals)) {
      const scoredRecords = records.filter((r) => r.scored && r.forward_return !== undefined)
      if (scoredRecords.length < 3) continue // Need minimum history

      // Filter to lookback window (use referenceDate for backtest, otherwise today)
      const cutoff = referenceDate ? new Date(referenceDate) : new Date()
      cutoff.setDate(cutoff.getDate() - this.darwinian.sharpe_lookback_days)
      const cutoffStr = cutoff.toISOString().slice(0, 10)
      const recent = scoredRecords.filter((r) => r.date >= cutoffStr)
      if (recent.length < 3) continue

      const sharpe = this.computeSharpe(recent)
      const winRate = this.computeWinRate(recent)

      // Weight adjustment: sharpe-driven with bounds
      const currentWeight = this.getWeight(agentName)
      let newWeight = currentWeight

      if (sharpe > 0.5) {
        newWeight *= 1.1 // Reward good performance
      } else if (sharpe < -0.5) {
        newWeight *= 0.9 // Penalize bad performance
      }

      // Clamp to bounds
      newWeight = Math.max(this.darwinian.min_weight, Math.min(this.darwinian.max_weight, newWeight))
      this.weights[agentName] = Math.round(newWeight * 100) / 100
    }
  }

  // ==================== Metrics ====================

  private computeSharpe(records: SignalRecord[]): number {
    const returns = records
      .map((r) => {
        if (r.forward_return === undefined) return null
        // Directional return: positive if agent was right
        const sign = r.direction === 'BULLISH' ? 1 : r.direction === 'BEARISH' ? -1 : 0
        return sign * r.forward_return
      })
      .filter((r): r is number => r !== null)

    if (returns.length < 2) return 0

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1)
    const std = Math.sqrt(variance)

    return std === 0 ? 0 : mean / std
  }

  private computeWinRate(records: SignalRecord[]): number {
    const scored = records.filter((r) => r.forward_return !== undefined)
    if (scored.length === 0) return 0

    const wins = scored.filter((r) => {
      const sign = r.direction === 'BULLISH' ? 1 : r.direction === 'BEARISH' ? -1 : 0
      return sign * (r.forward_return ?? 0) > 0
    }).length

    return Math.round((wins / scored.length) * 100)
  }

  // ==================== Summary ====================

  getAllScores(): AgentScore[] {
    const scores: AgentScore[] = []

    for (const [agentName, records] of Object.entries(this.signals)) {
      const scored = records.filter((r) => r.scored)
      scores.push({
        agent: agentName,
        department: this.departmentId,
        weight: this.getWeight(agentName),
        sharpe: this.computeSharpe(scored),
        win_rate: this.computeWinRate(scored),
        total_signals: records.length,
        scored_signals: scored.length,
        avg_conviction: records.length > 0
          ? Math.round(records.reduce((a, b) => a + b.conviction, 0) / records.length)
          : 0,
        last_signal_date: records.length > 0
          ? records[records.length - 1].date
          : '',
      })
    }

    return scores.sort((a, b) => b.weight - a.weight)
  }

  getOverallAccuracy(): number {
    const allScored = Object.values(this.signals)
      .flat()
      .filter((r) => r.scored && r.forward_return !== undefined)

    if (allScored.length === 0) return 0
    return this.computeWinRate(allScored)
  }

  getSummary(agentName?: string): AgentScore | AgentScore[] {
    const all = this.getAllScores()
    if (agentName) {
      return all.find((s) => s.agent === agentName) ?? {
        agent: agentName,
        department: this.departmentId,
        weight: this.getWeight(agentName),
        sharpe: 0,
        win_rate: 0,
        total_signals: 0,
        scored_signals: 0,
        avg_conviction: 0,
        last_signal_date: '',
      }
    }
    return all
  }

  // ==================== Utils ====================

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      const raw = await readFile(path, 'utf-8')
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  private async writeJson(path: string, data: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(data, null, 2))
  }
}

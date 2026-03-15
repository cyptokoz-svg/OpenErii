/**
 * Backtest Metrics — Portfolio performance calculation
 *
 * Computes Sharpe, Sortino, max drawdown, win rate, profit factor
 * from accumulated signal records and equity curve.
 */

import type { PortfolioMetrics, AgentAttribution } from './types.js'
import type { SignalRecord, EvolutionEntry } from '../types.js'

// ==================== Portfolio Metrics ====================

export function computePortfolioMetrics(
  signals: SignalRecord[],
  initialCapital: number,
): PortfolioMetrics {
  const scored = signals.filter((s) => s.scored && s.forward_return !== undefined)

  if (scored.length === 0) {
    return {
      total_return_pct: 0,
      max_drawdown_pct: 0,
      sharpe_ratio: 0,
      sortino_ratio: 0,
      win_rate_pct: 0,
      profit_factor: 0,
      total_signals: signals.length,
      scored_signals: 0,
      avg_holding_days: 5,
    }
  }

  // Directional returns weighted by conviction (consistent with equity curve)
  const returns = scored.map((s) => {
    const sign = s.direction === 'BULLISH' ? 1 : s.direction === 'BEARISH' ? -1 : 0
    const weight = s.conviction / 100
    return sign * (s.forward_return ?? 0) * weight
  })

  // Total return (compounded)
  let equity = initialCapital
  for (const r of returns) {
    equity *= (1 + r)
  }
  const totalReturn = ((equity - initialCapital) / initialCapital) * 100

  // Max drawdown
  const maxDD = computeMaxDrawdown(returns, initialCapital)

  // Sharpe ratio (annualized, assuming ~50 signals/year)
  const sharpe = computeSharpe(returns)

  // Sortino ratio
  const sortino = computeSortino(returns)

  // Win rate
  const wins = returns.filter((r) => r > 0).length
  const winRate = Math.round((wins / returns.length) * 100)

  // Profit factor
  const grossProfit = returns.filter((r) => r > 0).reduce((a, b) => a + b, 0)
  const grossLoss = Math.abs(returns.filter((r) => r < 0).reduce((a, b) => a + b, 0))
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0

  // Average holding days
  const avgHolding = scored.reduce((a, s) => a + (s.forward_days ?? 5), 0) / scored.length

  return {
    total_return_pct: Math.round(totalReturn * 100) / 100,
    max_drawdown_pct: Math.round(maxDD * 100) / 100,
    sharpe_ratio: Math.round(sharpe * 100) / 100,
    sortino_ratio: Math.round(sortino * 100) / 100,
    win_rate_pct: winRate,
    profit_factor: Math.round(profitFactor * 100) / 100,
    total_signals: signals.length,
    scored_signals: scored.length,
    avg_holding_days: Math.round(avgHolding * 10) / 10,
  }
}

// ==================== Equity Curve ====================

export function computeEquityCurve(
  dayResults: Array<{ date: string; signals_scored: number }>,
  signals: SignalRecord[],
  initialCapital: number,
): Array<{ date: string; equity: number }> {
  const curve: Array<{ date: string; equity: number }> = []
  let equity = initialCapital

  // Group scored signals by date
  const scoredByDate = new Map<string, SignalRecord[]>()
  for (const s of signals) {
    if (!s.scored || s.forward_return === undefined) continue
    const arr = scoredByDate.get(s.date) ?? []
    arr.push(s)
    scoredByDate.set(s.date, arr)
  }

  // Walk through each day result
  for (const day of dayResults) {
    const daySignals = scoredByDate.get(day.date) ?? []
    for (const s of daySignals) {
      const sign = s.direction === 'BULLISH' ? 1 : s.direction === 'BEARISH' ? -1 : 0
      const r = sign * (s.forward_return ?? 0)
      // Scale by conviction: full conviction (100) = 100% position effect
      const weight = s.conviction / 100
      equity *= (1 + r * weight)
    }
    curve.push({ date: day.date, equity: Math.round(equity * 100) / 100 })
  }

  return curve
}

// ==================== Agent Attribution ====================

export function computeAgentAttribution(
  signals: SignalRecord[],
  weightHistory: Array<{ date: string; weights: Record<string, number> }>,
  evolutionLog: EvolutionEntry[],
): AgentAttribution[] {
  // Group signals by agent
  const byAgent = new Map<string, SignalRecord[]>()
  for (const s of signals) {
    const arr = byAgent.get(s.agent) ?? []
    arr.push(s)
    byAgent.set(s.agent, arr)
  }

  const attributions: AgentAttribution[] = []
  const evolvedAgents = new Set(evolutionLog.map((e) => e.agent))

  for (const [agent, agentSignals] of byAgent) {
    const scored = agentSignals.filter((s) => s.scored && s.forward_return !== undefined)

    // Directional returns
    const returns = scored.map((s) => {
      const sign = s.direction === 'BULLISH' ? 1 : s.direction === 'BEARISH' ? -1 : 0
      return sign * (s.forward_return ?? 0)
    })

    const wins = returns.filter((r) => r > 0).length
    const totalPnl = returns.reduce((a, b) => a + b, 0) * 100
    const avgConviction = agentSignals.reduce((a, s) => a + s.conviction, 0) / agentSignals.length

    // Weight start/end
    const firstWeights = weightHistory[0]?.weights ?? {}
    const lastWeights = weightHistory[weightHistory.length - 1]?.weights ?? {}

    attributions.push({
      agent,
      signals: agentSignals.length,
      win_rate_pct: scored.length > 0 ? Math.round((wins / scored.length) * 100) : 0,
      total_pnl_pct: Math.round(totalPnl * 100) / 100,
      avg_conviction: Math.round(avgConviction),
      sharpe: computeSharpe(returns),
      weight_start: firstWeights[agent] ?? 1.0,
      weight_end: lastWeights[agent] ?? 1.0,
      evolved: evolvedAgents.has(agent),
    })
  }

  return attributions.sort((a, b) => b.sharpe - a.sharpe)
}

// ==================== Helpers ====================

function computeSharpe(returns: number[]): number {
  if (returns.length < 2) return 0
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1)
  const std = Math.sqrt(variance)
  if (std === 0) return 0
  // Annualize: assume ~50 signals/year
  return Math.round((mean / std) * Math.sqrt(50) * 100) / 100
}

function computeSortino(returns: number[]): number {
  if (returns.length < 2) return 0
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const downside = returns.filter((r) => r < 0)
  if (downside.length === 0) return mean > 0 ? 99 : 0
  const downVar = downside.reduce((a, b) => a + b ** 2, 0) / downside.length
  const downStd = Math.sqrt(downVar)
  if (downStd === 0) return 0
  return Math.round((mean / downStd) * Math.sqrt(50) * 100) / 100
}

function computeMaxDrawdown(returns: number[], initialCapital: number): number {
  let equity = initialCapital
  let peak = initialCapital
  let maxDD = 0

  for (const r of returns) {
    equity *= (1 + r)
    if (equity > peak) peak = equity
    const dd = (peak - equity) / peak * 100
    if (dd > maxDD) maxDD = dd
  }

  return maxDD
}

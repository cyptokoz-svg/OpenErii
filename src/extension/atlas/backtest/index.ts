/**
 * Atlas Backtest — Walk-Forward Historical Simulation
 *
 * Re-exports for the backtest subsystem.
 */

export { WalkForwardEngine } from './engine.js'
export type { WalkForwardDeps } from './engine.js'
export { GdeltFetcher } from './gdelt.js'
export { HistoricalDataBridge } from './historical-bridge.js'
export { computePortfolioMetrics, computeEquityCurve, computeAgentAttribution } from './metrics.js'
export { saveState, loadState, loadResult, listRuns, generateRunId, type RunSummary } from './state.js'
export type {
  BacktestConfig,
  BacktestState,
  BacktestResult,
  BacktestStatus,
  DayResult,
  PortfolioMetrics,
  AgentAttribution,
} from './types.js'

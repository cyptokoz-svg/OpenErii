import { useState, useEffect, useCallback } from 'react'
import { PageHeader } from '../components/PageHeader'
import {
  atlasApi,
  type AtlasStatus,
  type BacktestRunConfig,
  type BacktestResultResponse,
  type BacktestRunSummary,
} from '../api/atlas'
import { api, type AIProviderConfig } from '../api'
import { useLocale } from '../i18n'

// ==================== Model Presets ====================

const PROVIDER_MODELS: Record<string, { label: string; value: string }[]> = {
  anthropic: [
    { label: 'Claude Opus 4.6', value: 'claude-opus-4-6' },
    { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
    { label: 'Claude Haiku 4.5', value: 'claude-haiku-4-5' },
  ],
  openai: [
    { label: 'GPT-5.2 Pro', value: 'gpt-5.2-pro' },
    { label: 'GPT-5.2', value: 'gpt-5.2' },
    { label: 'GPT-5 Mini', value: 'gpt-5-mini' },
  ],
  google: [
    { label: 'Gemini 3.1 Pro', value: 'gemini-3.1-pro-preview' },
    { label: 'Gemini 3 Flash', value: 'gemini-3-flash-preview' },
    { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
  ],
}

// ==================== Agent Chinese Names ====================

const AGENT_ZH: Record<string, string> = {
  fed_watcher: '美联储观察', dollar_fx: '美元/外汇', inflation_tracker: '通胀追踪',
  geopolitical: '地缘政治', global_central_banks: '全球央行', yield_curve: '收益率曲线',
  liquidity_monitor: '流动性监测', china_macro: '中国宏观', emerging_markets: '新兴市场',
  shipping_logistics: '航运物流', energy_desk: '能源分析', precious_metals: '贵金属分析',
  industrial_metals: '工业金属', agriculture: '农产品', soft_commodities: '软商品',
  livestock: '畜牧业', trend_follower: '趋势跟踪', mean_reversion: '均值回归',
  fundamental_value: '基本面', event_driven: '事件驱动', cro: 'CRO',
  portfolio_manager: '组合经理', devils_advocate: '魔鬼代言人', cio: 'CIO',
}

// ==================== Metric Card ====================

function MetricCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="glass-card rounded-xl p-3 text-center">
      <div className={`text-lg font-bold ${color ?? 'text-text'}`}>{value}</div>
      <div className="text-[11px] text-text-muted mt-1">{label}</div>
    </div>
  )
}

// ==================== SVG Equity Curve ====================

function EquityCurve({ data }: { data: Array<{ date: string; equity: number }> }) {
  const { t } = useLocale()

  if (data.length < 2) return null

  const w = 600, h = 200, pad = 30
  const equities = data.map((d) => d.equity)
  const minE = Math.min(...equities)
  const maxE = Math.max(...equities)
  const range = maxE - minE || 1

  const points = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * (w - 2 * pad)
    const y = h - pad - ((d.equity - minE) / range) * (h - 2 * pad)
    return `${x},${y}`
  }).join(' ')

  // Determine curve color based on final vs initial equity
  const finalEquity = equities[equities.length - 1]
  const initialEquity = equities[0]
  const isPositive = finalEquity >= initialEquity

  return (
    <div className="glass-card rounded-xl p-4">
      <h3 className="text-[13px] font-semibold text-text-muted mb-3">{t('backtest.equity_curve')}</h3>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxHeight: 220 }}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
          const y = h - pad - pct * (h - 2 * pad)
          const val = minE + pct * range
          return (
            <g key={pct}>
              <line x1={pad} y1={y} x2={w - pad} y2={y} stroke="var(--color-border)" strokeWidth="0.5" />
              <text x={pad - 4} y={y + 3} textAnchor="end" fill="var(--color-text-muted)" fontSize="8">
                {val >= 1000 ? `${(val / 1000).toFixed(0)}K` : val.toFixed(0)}
              </text>
            </g>
          )
        })}
        {/* Curve */}
        <polyline
          points={points}
          fill="none"
          stroke={isPositive ? 'var(--color-green)' : 'var(--color-red)'}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {/* Date labels */}
        {data.length > 2 && [0, Math.floor(data.length / 2), data.length - 1].map((idx) => {
          const x = pad + (idx / (data.length - 1)) * (w - 2 * pad)
          return (
            <text key={idx} x={x} y={h - 5} textAnchor="middle" fill="var(--color-text-muted)" fontSize="8">
              {data[idx].date.slice(0, 7)}
            </text>
          )
        })}
      </svg>
    </div>
  )
}

// ==================== Agent Attribution Table ====================

function AttributionTable({ data, locale }: {
  data: BacktestResultResponse['agent_attribution']
  locale: string
}) {
  const { t } = useLocale()

  return (
    <div className="glass-card rounded-xl p-4">
      <h3 className="text-[13px] font-semibold text-text-muted mb-3">{t('backtest.agent_attribution')}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th className="py-2 pr-3">{t('atlas.agent')}</th>
              <th className="py-2 pr-3 text-right">{t('backtest.signals')}</th>
              <th className="py-2 pr-3 text-right">{t('atlas.win_rate')}</th>
              <th className="py-2 pr-3 text-right">{t('backtest.pnl')}</th>
              <th className="py-2 pr-3 text-right">{t('atlas.sharpe')}</th>
              <th className="py-2 pr-3 text-right">{t('backtest.conviction')}</th>
              <th className="py-2 pr-3 text-right">{t('backtest.weight_change')}</th>
              <th className="py-2 text-right">{t('backtest.evolved')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((a) => {
              const name = locale === 'zh' ? (AGENT_ZH[a.agent] ?? a.agent) : a.agent
              return (
                <tr key={a.agent} className="border-b border-border/50 table-row-hover">
                  <td className="py-2 pr-3 font-medium text-text">{name}</td>
                  <td className="py-2 pr-3 text-right">{a.signals}</td>
                  <td className="py-2 pr-3 text-right">{a.win_rate_pct}%</td>
                  <td className="py-2 pr-3 text-right">
                    <span className={a.total_pnl_pct > 0 ? 'text-green' : a.total_pnl_pct < 0 ? 'text-red' : ''}>
                      {a.total_pnl_pct > 0 ? '+' : ''}{a.total_pnl_pct.toFixed(1)}%
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <span className={a.sharpe > 0 ? 'text-green' : a.sharpe < 0 ? 'text-red' : ''}>
                      {a.sharpe.toFixed(2)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right">{a.avg_conviction}</td>
                  <td className="py-2 pr-3 text-right text-text-muted">
                    {a.weight_start.toFixed(2)} → {a.weight_end.toFixed(2)}
                  </td>
                  <td className="py-2 text-right">
                    {a.evolved && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">Yes</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ==================== Evolution Log ====================

function EvolutionLog({ log, locale }: {
  log: BacktestResultResponse['evolution_log']
  locale: string
}) {
  const { t } = useLocale()
  if (log.length === 0) return null

  return (
    <div className="glass-card rounded-xl p-4">
      <h3 className="text-[13px] font-semibold text-text-muted mb-3">{t('backtest.evolution_log')}</h3>
      <div className="space-y-2">
        {log.map((e, i) => {
          const name = locale === 'zh' ? (AGENT_ZH[e.agent] ?? e.agent) : e.agent
          const statusColor = e.status === 'kept' ? 'text-green' : e.status === 'reverted' ? 'text-red' : 'text-amber-400'
          return (
            <div key={i} className="flex items-center gap-3 text-[12px] py-1.5 border-b border-border/30">
              <span className="text-text-muted w-20 shrink-0">{e.started_at.slice(0, 10)}</span>
              <span className="font-medium text-text">{name}</span>
              <span className="text-text-muted">
                Sharpe {e.sharpe_before.toFixed(2)} → {e.sharpe_after?.toFixed(2) ?? '?'}
              </span>
              <span className={`${statusColor} font-medium ml-auto`}>{e.status.toUpperCase()}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ==================== Config Panel ====================

function ConfigPanel({
  departments,
  selectedDept,
  onDeptChange,
  onRun,
  isRunning,
  aiProvider,
  completedRuns,
  forceSeedRunId,
}: {
  departments: AtlasStatus['departments']
  selectedDept: string
  onDeptChange: (dept: string) => void
  onRun: (config: BacktestRunConfig) => void
  isRunning: boolean
  aiProvider: string
  completedRuns: BacktestRunSummary[]
  forceSeedRunId?: string | null
}) {
  const { t } = useLocale()
  const [startDate, setStartDate] = useState('2023-01-03')
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10))
  const [step, setStep] = useState(5)
  const [capital, setCapital] = useState(100000)
  const [evolution, setEvolution] = useState(true)
  const [knowledge, setKnowledge] = useState(false)
  const [model, setModel] = useState('')
  const [seedRunId, setSeedRunId] = useState('')

  // Accept external seed override (from "continue with team" action)
  useEffect(() => {
    setSeedRunId(forceSeedRunId ?? '')
  }, [forceSeedRunId])

  const modelPresets = PROVIDER_MODELS[aiProvider] || []

  return (
    <div className="glass-card rounded-xl p-4">
      <h3 className="text-[13px] font-semibold text-text-muted mb-4">{t('backtest.config')}</h3>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Department */}
        <div>
          <label className="block text-[11px] text-text-muted mb-1">{t('backtest.department')}</label>
          <select
            value={selectedDept} onChange={(e) => onDeptChange(e.target.value)}
            disabled={isRunning}
            className="w-full text-[12px] px-2 py-1.5 rounded border border-border bg-bg text-text disabled:opacity-50"
          >
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>

        {/* Start Date */}
        <div>
          <label className="block text-[11px] text-text-muted mb-1">{t('backtest.start_date')}</label>
          <input
            type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
            className="w-full text-[12px] px-2 py-1.5 rounded border border-border bg-bg text-text"
          />
        </div>

        {/* End Date */}
        <div>
          <label className="block text-[11px] text-text-muted mb-1">{t('backtest.end_date')}</label>
          <input
            type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
            className="w-full text-[12px] px-2 py-1.5 rounded border border-border bg-bg text-text"
          />
        </div>

        {/* Step */}
        <div>
          <label className="block text-[11px] text-text-muted mb-1">{t('backtest.step')}</label>
          <input
            type="number" min={1} max={30} value={step} onChange={(e) => setStep(Number(e.target.value))}
            className="w-full text-[12px] px-2 py-1.5 rounded border border-border bg-bg text-text"
          />
          <span className="text-[10px] text-text-muted">{t('backtest.step_desc')}</span>
        </div>

        {/* Initial Capital */}
        <div>
          <label className="block text-[11px] text-text-muted mb-1">{t('backtest.initial_capital')}</label>
          <input
            type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value))}
            className="w-full text-[12px] px-2 py-1.5 rounded border border-border bg-bg text-text"
          />
        </div>

        {/* Model Override */}
        <div>
          <label className="block text-[11px] text-text-muted mb-1">{t('backtest.model')}</label>
          {modelPresets.length > 0 ? (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full text-[12px] px-2 py-1.5 rounded border border-border bg-bg text-text"
            >
              <option value="">{t('backtest.model_default')}</option>
              {modelPresets.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t('backtest.model_default')}
              className="w-full text-[12px] px-2 py-1.5 rounded border border-border bg-bg text-text placeholder:text-text-muted/50"
            />
          )}
        </div>

        {/* Toggles */}
        <div className="flex flex-col gap-2 justify-center">
          <label className="flex items-center gap-2 text-[12px] text-text cursor-pointer">
            <input type="checkbox" checked={evolution} onChange={(e) => setEvolution(e.target.checked)} />
            {t('backtest.evolution')}
          </label>
          <label className="flex items-center gap-2 text-[12px] text-text cursor-pointer">
            <input type="checkbox" checked={knowledge} onChange={(e) => setKnowledge(e.target.checked)} />
            {t('backtest.knowledge')}
          </label>
        </div>

        {/* Seed from previous run */}
        <div>
          <label className="block text-[11px] text-text-muted mb-1">{t('backtest.seed_run')}</label>
          <select
            value={seedRunId}
            onChange={(e) => setSeedRunId(e.target.value)}
            disabled={completedRuns.length === 0}
            className="w-full text-[12px] px-2 py-1.5 rounded border border-border bg-bg text-text disabled:opacity-50"
          >
            <option value="">{t('backtest.seed_none')}</option>
            {completedRuns.map((r) => (
              <option key={r.id} value={r.id}>
                {r.startDate} → {r.endDate} ({r.id.slice(0, 12)})
              </option>
            ))}
          </select>
          <span className="text-[10px] text-text-muted">{t('backtest.seed_desc')}</span>
        </div>
      </div>

      <div className="mt-4">
        <button
          onClick={() => onRun({
            department: selectedDept,
            startDate,
            endDate,
            step,
            initialCapital: capital,
            disable_evolution: !evolution,
            disable_knowledge: !knowledge,
            ...(model ? { model_tiers: { L1: model, L2: model, L3: model, L4: model } } : {}),
            ...(seedRunId ? { seedRunId } : {}),
          })}
          disabled={isRunning || !selectedDept}
          className="px-4 py-2 text-[13px] font-medium rounded-md bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isRunning ? t('backtest.running') : t('backtest.run')}
        </button>
      </div>
    </div>
  )
}

// ==================== Progress Bar ====================

function ProgressBar({ progress, status, currentDate, elapsed }: {
  progress: number
  status: string
  currentDate: string
  elapsed: number
}) {
  const { t } = useLocale()
  const statusKey = `backtest.${status}` as const
  const elapsedStr = elapsed > 60000
    ? `${Math.round(elapsed / 60000)}m ${Math.round((elapsed % 60000) / 1000)}s`
    : `${Math.round(elapsed / 1000)}s`

  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {status === 'running' && <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
          {status === 'downloading' && <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
          <span className="text-[13px] font-medium text-text">{t(statusKey as any)}</span>
        </div>
        <span className="text-[12px] text-text-muted">{t('backtest.elapsed')}: {elapsedStr}</span>
      </div>
      <div className="w-full h-2 bg-bg-tertiary rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${progress}%`,
            background: 'linear-gradient(90deg, var(--color-accent), var(--color-green))',
          }}
        />
      </div>
      <div className="flex justify-between mt-1.5 text-[11px] text-text-muted">
        <span>{progress}%</span>
        <span>{t('backtest.current_date')}: {currentDate}</span>
      </div>
    </div>
  )
}

// ==================== History List ====================

function HistoryList({ runs, onSelect }: {
  runs: BacktestRunSummary[]
  onSelect: (id: string) => void
}) {
  const { t } = useLocale()
  if (runs.length === 0) return null

  return (
    <div className="glass-card rounded-xl p-4">
      <h3 className="text-[13px] font-semibold text-text-muted mb-3">{t('backtest.history')}</h3>
      <div className="space-y-2">
        {runs.map((run) => (
          <button
            key={run.id}
            onClick={() => onSelect(run.id)}
            className="w-full flex items-center justify-between text-left py-2 px-3 rounded-lg hover:bg-bg-tertiary/40 transition-colors text-[12px]"
          >
            <div>
              <span className="font-medium text-text">{run.startDate} → {run.endDate}</span>
              <span className="text-text-muted ml-2">{new Date(run.started_at).toLocaleDateString()}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                run.status === 'completed' ? 'bg-green/10 text-green' :
                run.status === 'running' ? 'bg-amber-400/10 text-amber-400' :
                run.status === 'failed' ? 'bg-red/10 text-red' :
                'bg-bg-tertiary text-text-muted'
              }`}>
                {run.status}
              </span>
              {run.progress < 100 && <span className="text-text-muted">{run.progress}%</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ==================== Page ====================

export function BacktestPage() {
  const { t, locale } = useLocale()
  const [status, setStatus] = useState<AtlasStatus | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [runs, setRuns] = useState<BacktestRunSummary[]>([])
  const [result, setResult] = useState<BacktestResultResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedDept, setSelectedDept] = useState<string | null>(null)
  const [pollId, setPollId] = useState<string | null>(null)
  const [aiProvider, setAiProvider] = useState('anthropic')
  const [stopNotice, setStopNotice] = useState<string | null>(null)
  const [progressState, setProgressState] = useState<{
    progress: number; status: string; currentDate: string; elapsed: number
  } | null>(null)
  const [promoteMsg, setPromoteMsg] = useState<string | null>(null)
  const [seedRunIdFromResult, setSeedRunIdFromResult] = useState<string | null>(null)

  // Load departments + AI provider
  const loadStatus = useCallback(async () => {
    try {
      const [s, appCfg] = await Promise.all([atlasApi.getStatus(), api.config.load()])
      setStatus(s)
      setAiProvider(appCfg.aiProvider.provider || 'anthropic')
      if (!selectedDept && s.departments.length > 0) {
        setSelectedDept(s.departments[0].id)
      }
    } catch (err) {
      setError(String(err))
    }
  }, [selectedDept])

  // Load backtest history
  const loadRuns = useCallback(async () => {
    if (!selectedDept) return
    try {
      const { runs: r } = await atlasApi.backtestList(selectedDept)
      setRuns(r)
    } catch {
      setRuns([])
    }
  }, [selectedDept])

  useEffect(() => { loadStatus() }, [loadStatus])
  useEffect(() => { loadRuns() }, [loadRuns])

  // Poll running backtest
  useEffect(() => {
    if (!pollId || !selectedDept) return
    const timer = setInterval(async () => {
      try {
        const s = await atlasApi.backtestStatus(selectedDept, pollId)
        setProgressState({
          progress: s.progress,
          status: s.status,
          currentDate: s.currentDate,
          elapsed: s.elapsed_ms,
        })
        if (s.status === 'completed' || s.status === 'failed' || s.status === 'paused') {
          setIsRunning(false)
          clearInterval(timer)
          // Load result (including partial results for paused/failed)
          try {
            const r = await atlasApi.backtestResult(selectedDept, pollId)
            setResult(r)
          } catch { /* result may not be ready yet */ }
          setPollId(null)
          loadRuns()
        }
      } catch {
        // Status may not be available yet
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [pollId, selectedDept, loadRuns])

  const handleRun = async (config: BacktestRunConfig) => {
    try {
      setError(null)
      setResult(null)
      setIsRunning(true)
      const { runId } = await atlasApi.backtestRun(config)
      setPollId(runId)
      setProgressState({ progress: 0, status: 'preparing', currentDate: config.startDate, elapsed: 0 })
    } catch (err) {
      setError(String(err))
      setIsRunning(false)
    }
  }

  const handleStop = async () => {
    if (!selectedDept || !pollId) return
    // Capture values before any async state changes
    const dept = selectedDept
    const runId = pollId
    try {
      await atlasApi.backtestPause(dept)
      // Stop polling immediately to avoid race
      setPollId(null)
      setStopNotice(locale === 'zh'
        ? '正在停止回测...当前进行中的轮次将被丢弃，使用之前已完成的数据生成结果。'
        : 'Stopping backtest... The current in-progress round will be discarded. Results are based on previously completed rounds.')
      // Wait for the engine to finalize partial results
      setTimeout(async () => {
        try {
          const r = await atlasApi.backtestResult(dept, runId)
          setResult(r)
        } catch { /* partial result may not be ready */ }
        setIsRunning(false)
        setStopNotice(null)
        loadRuns()
      }, 3000)
    } catch (err) {
      setError(String(err))
      setStopNotice(null)
    }
  }

  const handleSelectRun = async (id: string) => {
    if (!selectedDept) return
    try {
      const r = await atlasApi.backtestResult(selectedDept, id)
      setResult(r)
      setProgressState(null)
      setPromoteMsg(null)
    } catch (err) {
      setError(String(err))
    }
  }

  /** Pre-fill seed run ID in config panel and scroll to top */
  const handleContinueWithTeam = (runId: string) => {
    setSeedRunIdFromResult(runId)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handlePromote = async () => {
    if (!selectedDept || !result) return
    const confirmed = window.confirm(t('backtest.promote_confirm'))
    if (!confirmed) return
    try {
      const res = await atlasApi.backtestPromote(selectedDept, result.id)
      setPromoteMsg(locale === 'zh'
        ? `已推送到实盘: ${res.promoted.join(', ')}${res.warnings.length > 0 ? ` (注意: ${res.warnings.join(', ')})` : ''}`
        : `Promoted to live: ${res.promoted.join(', ')}${res.warnings.length > 0 ? ` (warnings: ${res.warnings.join(', ')})` : ''}`)
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <PageHeader title={t('backtest.title')} description={t('backtest.description')} />

      {error && (
        <div className="mt-4 p-3 rounded-lg bg-red/10 text-red text-[13px]">{error}</div>
      )}

      {/* Config Panel */}
      {status && status.departments.length > 0 && selectedDept && (
        <section className="mt-6">
          <ConfigPanel
            departments={status.departments}
            selectedDept={selectedDept}
            onDeptChange={(d) => { setSelectedDept(d); setSeedRunIdFromResult(null) }}
            onRun={(cfg) => { setSeedRunIdFromResult(null); handleRun(cfg) }}
            isRunning={isRunning}
            aiProvider={aiProvider}
            completedRuns={runs.filter((r) => r.status === 'completed' || r.status === 'paused')}
            forceSeedRunId={seedRunIdFromResult}
          />
        </section>
      )}

      {/* Progress Bar */}
      {progressState && (
        <section className="mt-4">
          <ProgressBar {...progressState} />
          {isRunning && (
            <div className="mt-2 flex items-center justify-between">
              {stopNotice && (
                <span className="text-[12px] text-amber-400">{stopNotice}</span>
              )}
              <button
                onClick={handleStop}
                disabled={!!stopNotice}
                className="ml-auto px-4 py-1.5 text-[12px] font-medium rounded-md border border-red/50 text-red hover:bg-red/10 transition-colors disabled:opacity-50"
              >
                {t('backtest.pause')}
              </button>
            </div>
          )}
        </section>
      )}

      {/* Metrics Summary */}
      {result && (
        <section className="mt-6">
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4 lg:grid-cols-6">
            <MetricCard
              label={t('backtest.total_return')}
              value={`${result.metrics.total_return_pct > 0 ? '+' : ''}${result.metrics.total_return_pct}%`}
              color={result.metrics.total_return_pct >= 0 ? 'text-green' : 'text-red'}
            />
            <MetricCard
              label={t('backtest.max_drawdown')}
              value={`-${Math.abs(result.metrics.max_drawdown_pct)}%`}
              color="text-red"
            />
            <MetricCard
              label={t('backtest.sharpe')}
              value={String(result.metrics.sharpe_ratio)}
              color={result.metrics.sharpe_ratio > 0 ? 'text-green' : 'text-red'}
            />
            <MetricCard label={t('backtest.win_rate')} value={`${result.metrics.win_rate_pct}%`} />
            <MetricCard label={t('backtest.profit_factor')} value={String(result.metrics.profit_factor)} />
            <MetricCard label={t('backtest.scored_signals')} value={`${result.metrics.scored_signals}/${result.metrics.total_signals}`} />
          </div>
          {/* Action Panel — user decides what to do with the result */}
          {!isRunning && (
            <div className="mt-4 glass-card rounded-xl p-4">
              <h4 className="text-[12px] font-semibold text-text-muted mb-3">{t('backtest.actions')}</h4>
              <div className="flex flex-wrap gap-3">
                {/* Continue backtesting with this team */}
                <button
                  onClick={() => handleContinueWithTeam(result.id)}
                  className="flex items-center gap-2 px-4 py-2 text-[13px] font-medium rounded-md border border-accent/50 text-accent hover:bg-accent/10 transition-colors"
                >
                  <span>&#8635;</span>
                  {t('backtest.action_continue')}
                </button>

                {/* Promote to live */}
                <button
                  onClick={handlePromote}
                  disabled={result.status !== 'completed' && result.status !== 'paused'}
                  className="flex items-center gap-2 px-4 py-2 text-[13px] font-medium rounded-md border border-green/50 text-green hover:bg-green/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span>&#9650;</span>
                  {t('backtest.action_promote')}
                </button>

                {/* Keep / archive (do nothing) */}
                <span className="flex items-center gap-2 px-4 py-2 text-[13px] text-text-muted">
                  <span>&#9679;</span>
                  {t('backtest.action_keep')}
                </span>
              </div>

              {promoteMsg && (
                <div className="mt-3 p-2 rounded-lg bg-green/10 text-green text-[12px]">{promoteMsg}</div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Equity Curve */}
      {result && result.equity_curve.length > 1 && (
        <section className="mt-6">
          <EquityCurve data={result.equity_curve} />
        </section>
      )}

      {/* Agent Attribution */}
      {result && result.agent_attribution.length > 0 && (
        <section className="mt-6">
          <AttributionTable data={result.agent_attribution} locale={locale} />
        </section>
      )}

      {/* Evolution Log */}
      {result && result.evolution_log.length > 0 && (
        <section className="mt-6">
          <EvolutionLog log={result.evolution_log} locale={locale} />
        </section>
      )}

      {/* Backtest History */}
      {runs.length > 0 && (
        <section className="mt-8">
          <HistoryList runs={runs} onSelect={handleSelectRun} />
        </section>
      )}

      {/* Empty state */}
      {!result && !isRunning && runs.length === 0 && status && (
        <section className="mt-8 text-center text-[13px] text-text-muted py-12">
          {t('backtest.no_runs')}
        </section>
      )}
    </div>
  )
}

import { useState, useEffect, useCallback } from 'react'
import { PageHeader } from '../components/PageHeader'
import { atlasApi, type AtlasStatus, type AgentScoreItem, type AtlasAgent } from '../api/atlas'
import { useLocale } from '../i18n'

// ==================== Layer colors & icons ====================

const LAYER_META: Record<string, { color: string; icon: string; labelKey: string }> = {
  L1: { color: 'text-blue-400', icon: '🌍', labelKey: 'atlas.macro_layer' },
  L2: { color: 'text-emerald-400', icon: '🏭', labelKey: 'atlas.sector_layer' },
  L3: { color: 'text-amber-400', icon: '📊', labelKey: 'atlas.strategy_layer' },
  L4: { color: 'text-purple-400', icon: '🎯', labelKey: 'atlas.decision_layer' },
}

/** Chinese display names for known agents */
const AGENT_ZH: Record<string, string> = {
  fed_watcher: '美联储观察',
  dollar_fx: '美元/外汇',
  inflation_tracker: '通胀追踪',
  geopolitical: '地缘政治',
  global_central_banks: '全球央行',
  yield_curve: '收益率曲线',
  liquidity_monitor: '流动性监测',
  china_macro: '中国宏观',
  emerging_markets: '新兴市场',
  shipping_logistics: '航运物流',
  energy_desk: '能源分析',
  precious_metals: '贵金属分析',
  industrial_metals: '工业金属分析',
  agriculture: '农产品分析',
  soft_commodities: '软商品分析',
  livestock: '畜牧业分析',
  carbon_esg: '碳排放与ESG',
  trend_follower: '趋势跟踪',
  mean_reversion: '均值回归',
  fundamental_value: '基本面价值',
  event_driven: '事件驱动',
  cro: '首席风控官 (CRO)',
  portfolio_manager: '投资组合经理',
  devils_advocate: '魔鬼代言人',
  cio: '首席投资官 (CIO)',
}

// ==================== Agent Card ====================

function AgentCard({ agent, locale }: { agent: AtlasAgent; locale: string }) {
  const name = locale === 'zh' ? (AGENT_ZH[agent.name] ?? agent.display_name) : agent.display_name
  const meta = LAYER_META[agent.layer] ?? { color: 'text-text-muted', icon: '❓' }
  const symbols = agent.data_sources.flatMap((ds) => ds.symbols).filter(Boolean)

  return (
    <div className="border border-border rounded-lg p-3 bg-bg-secondary hover:border-border-hover transition-colors">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-base">{meta.icon}</span>
        <span className="text-[13px] font-semibold text-text flex-1 truncate">{name}</span>
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${meta.color} bg-bg-tertiary`}>
          {agent.layer}
        </span>
      </div>
      {symbols.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {symbols.slice(0, 6).map((s) => (
            <span key={s} className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-muted font-mono">
              {s}
            </span>
          ))}
          {symbols.length > 6 && (
            <span className="text-[10px] text-text-muted">+{symbols.length - 6}</span>
          )}
        </div>
      )}
      {agent.knowledge_links.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {agent.knowledge_links.map((k) => (
            <span key={k} className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">
              #{k}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ==================== Agent Team Grid ====================

function AgentTeamGrid({ agents, locale }: { agents: AtlasAgent[]; locale: string }) {
  const { t } = useLocale()
  const layers: [string, AtlasAgent[]][] = ['L1', 'L2', 'L3', 'L4'].map((layer) => [
    layer,
    agents.filter((a) => a.layer === layer),
  ])

  return (
    <div className="space-y-6">
      {layers.map(([layer, layerAgents]) => {
        if (layerAgents.length === 0) return null
        const meta = LAYER_META[layer] ?? { color: 'text-text-muted', icon: '❓', labelKey: '' }
        const labelKey = meta.labelKey as keyof ReturnType<typeof t extends (k: infer K) => string ? never : never>
        return (
          <div key={layer}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-base">{meta.icon}</span>
              <h3 className={`text-[13px] font-semibold uppercase tracking-wider ${meta.color}`}>
                {t(meta.labelKey as any)} ({layerAgents.length})
              </h3>
            </div>
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {layerAgents.map((agent) => (
                <AgentCard key={agent.name} agent={agent} locale={locale} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ==================== Scorecard Table ====================

function ScorecardTable({ agents }: { agents: AgentScoreItem[] }) {
  const { t } = useLocale()

  if (agents.length === 0) {
    return <p className="text-[13px] text-text-muted">{t('atlas.no_agents')}</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th className="py-2 pr-3 font-medium">{t('atlas.agent')}</th>
            <th className="py-2 pr-3 font-medium">{t('atlas.layer')}</th>
            <th className="py-2 pr-3 font-medium text-right">{t('atlas.weight')}</th>
            <th className="py-2 pr-3 font-medium text-right">{t('atlas.sharpe')}</th>
            <th className="py-2 pr-3 font-medium text-right">{t('atlas.win_rate')}</th>
            <th className="py-2 pr-3 font-medium text-right">{t('atlas.signals')}</th>
            <th className="py-2 font-medium text-right">{t('atlas.avg_conviction')}</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.agent} className="border-b border-border/50 hover:bg-bg-tertiary/50">
              <td className="py-2 pr-3 font-medium text-text">{a.agent}</td>
              <td className="py-2 pr-3 text-text-muted">{a.department}</td>
              <td className="py-2 pr-3 text-right">
                <span className={a.weight >= 1.5 ? 'text-green' : a.weight <= 0.5 ? 'text-red' : 'text-text'}>
                  {a.weight.toFixed(2)}
                </span>
              </td>
              <td className="py-2 pr-3 text-right">
                <span className={a.sharpe > 0 ? 'text-green' : a.sharpe < 0 ? 'text-red' : 'text-text-muted'}>
                  {a.sharpe.toFixed(2)}
                </span>
              </td>
              <td className="py-2 pr-3 text-right">{a.win_rate}%</td>
              <td className="py-2 pr-3 text-right">{a.scored_signals}/{a.total_signals}</td>
              <td className="py-2 text-right">{a.avg_conviction}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ==================== Department Card ====================

function DepartmentCard({
  dept,
  onRun,
  running,
}: {
  dept: AtlasStatus['departments'][number]
  onRun: (id: string) => void
  running: boolean
}) {
  const { t } = useLocale()

  return (
    <div className="border border-border rounded-lg p-4 bg-bg-secondary">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">🛢️</span>
          <h3 className="text-[15px] font-semibold text-text">{dept.name}</h3>
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${dept.enabled ? 'bg-green/10 text-green' : 'bg-bg-tertiary text-text-muted'}`}>
          {dept.enabled ? t('atlas.on') : t('atlas.off')}
        </span>
      </div>
      <div className="text-[12px] text-text-muted mb-3">
        <p>{t('atlas.timeframes')}: {dept.timeframes.join(', ')}</p>
        <p>{t('atlas.last_run')}: {dept.last_run ? new Date(dept.last_run).toLocaleString() : t('atlas.never')}</p>
      </div>
      {dept.enabled && (
        <button
          onClick={() => onRun(dept.id)}
          disabled={running}
          className="px-3 py-1.5 text-[13px] font-medium rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {running ? t('atlas.running') : t('atlas.run_analysis')}
        </button>
      )}
    </div>
  )
}

// ==================== Page ====================

export function AtlasPage() {
  const { t, locale } = useLocale()
  const [status, setStatus] = useState<AtlasStatus | null>(null)
  const [agents, setAgents] = useState<AtlasAgent[]>([])
  const [scorecard, setScorecard] = useState<AgentScoreItem[]>([])
  const [selectedDept, setSelectedDept] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const s = await atlasApi.getStatus()
      setStatus(s)
      if (!selectedDept && s.departments.length > 0) {
        setSelectedDept(s.departments[0].id)
      }
    } catch (err) {
      setError(String(err))
    }
  }, [selectedDept])

  const loadAgents = useCallback(async () => {
    if (!selectedDept) return
    try {
      const data = await atlasApi.getAgents(selectedDept)
      setAgents(data.agents)
    } catch {
      setAgents([])
    }
  }, [selectedDept])

  const loadScorecard = useCallback(async () => {
    if (!selectedDept) return
    try {
      const data = await atlasApi.getScorecard(selectedDept)
      setScorecard(data.agents)
    } catch {
      setScorecard([])
    }
  }, [selectedDept])

  useEffect(() => { loadStatus() }, [loadStatus])
  useEffect(() => { loadAgents() }, [loadAgents])
  useEffect(() => { loadScorecard() }, [loadScorecard])

  const handleRun = async (deptId: string) => {
    setRunning(true)
    try {
      await atlasApi.runAnalysis(deptId)
    } catch (err) {
      setError(String(err))
    } finally {
      setTimeout(() => {
        setRunning(false)
        loadStatus()
        loadScorecard()
      }, 2000)
    }
  }

  if (error) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <PageHeader title={t('atlas.title')} description={t('atlas.description_disabled')} />
        <p className="text-[13px] text-red mt-4">{error}</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <PageHeader
        title={t('atlas.title')}
        description={status?.enabled ? t('atlas.description_active') : t('atlas.description_disabled')}
      />

      {/* Departments */}
      <section className="mt-6">
        <h2 className="text-[13px] font-semibold text-text-muted uppercase tracking-wider mb-3">{t('atlas.departments')}</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {status?.departments.map((dept) => (
            <DepartmentCard
              key={dept.id}
              dept={dept}
              onRun={handleRun}
              running={running}
            />
          ))}
        </div>
        {status?.departments.length === 0 && (
          <p className="text-[13px] text-text-muted">{t('atlas.no_departments')}</p>
        )}
      </section>

      {/* Agent Team Roster */}
      {agents.length > 0 && (
        <section className="mt-8">
          <h2 className="text-[13px] font-semibold text-text-muted uppercase tracking-wider mb-4">
            {t('atlas.team_roster')} — {agents.length} AI
          </h2>
          <AgentTeamGrid agents={agents} locale={locale} />
        </section>
      )}

      {/* Scorecard */}
      {selectedDept && scorecard.length > 0 && (
        <section className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-semibold text-text-muted uppercase tracking-wider">
              {t('atlas.scorecard')} — {selectedDept}
            </h2>
            <select
              value={selectedDept}
              onChange={(e) => setSelectedDept(e.target.value)}
              className="text-[13px] bg-bg-secondary border border-border rounded px-2 py-1"
            >
              {status?.departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <ScorecardTable agents={scorecard} />
        </section>
      )}
    </div>
  )
}

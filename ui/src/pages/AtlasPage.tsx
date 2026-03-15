import { useState, useEffect, useCallback } from 'react'
import { PageHeader } from '../components/PageHeader'
import { atlasApi, type AtlasStatus, type AgentScoreItem, type AtlasAgent } from '../api/atlas'
import { cronApi } from '../api/cron'
import { api } from '../api'
import type { CronJob } from '../api/types'
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
    <div className="glass-card rounded-xl p-3">
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

function ScorecardTable({ agents, locale }: { agents: AgentScoreItem[]; locale: string }) {
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
          {agents.map((a) => {
            const displayName = locale === 'zh' ? (AGENT_ZH[a.agent] ?? a.agent) : a.agent
            return (
            <tr key={a.agent} className="border-b border-border/50 table-row-hover transition-colors">
              <td className="py-2 pr-3 font-medium text-text">{displayName}</td>
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
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ==================== Model Tiers ====================

const LAYER_TIERS = [
  { key: 'default', labelKey: 'atlas.default_tier', descKey: 'atlas.default_tier_desc' },
  { key: 'L1', labelKey: 'atlas.macro_layer', descKey: 'atlas.macro_tier_desc' },
  { key: 'L2', labelKey: 'atlas.sector_layer', descKey: 'atlas.sector_tier_desc' },
  { key: 'L3', labelKey: 'atlas.strategy_layer', descKey: 'atlas.strategy_tier_desc' },
  { key: 'L4', labelKey: 'atlas.decision_layer', descKey: 'atlas.decision_tier_desc' },
] as const

/** Model presets per provider — synced with AIProviderPage */
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

function ModelTiersEditor({
  tiers,
  onSave,
  aiBackend,
  aiProvider,
}: {
  tiers: Record<string, string>
  onSave: (tiers: Record<string, string>) => void
  aiBackend: string
  aiProvider: string
}) {
  const { t } = useLocale()
  const [localTiers, setLocalTiers] = useState(tiers)
  const [dirty, setDirty] = useState(false)
  const modelPresets = PROVIDER_MODELS[aiProvider] || []

  const handleChange = (key: string, value: string) => {
    if (value) {
      setLocalTiers((prev) => ({ ...prev, [key]: value }))
    } else {
      if (key !== 'default') {
        setLocalTiers((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
      }
    }
    setDirty(true)
  }

  const handleSave = () => {
    onSave(localTiers)
    setDirty(false)
  }

  const backendLabel: Record<string, string> = {
    'claude-code': 'Claude Code CLI',
    'vercel-ai-sdk': 'Vercel AI SDK',
    'agent-sdk': 'Agent SDK',
  }

  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-base">🧠</span>
          <h3 className="text-[13px] font-semibold gradient-text">{t('atlas.model_config')}</h3>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              onClick={handleSave}
              className="text-[11px] px-2.5 py-1 rounded-md bg-accent text-white font-medium hover:opacity-90 transition-opacity"
            >
              {t('atlas.save')}
            </button>
          )}
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent">
            ⚡ {backendLabel[aiBackend] || aiBackend}{aiProvider && aiProvider !== aiBackend ? ` · ${aiProvider}` : ''}
          </span>
        </div>
      </div>

      {/* AI source sync indicator */}
      <p className="text-[11px] text-text-muted mb-3">
        {t('atlas.ai_sync')} ({backendLabel[aiBackend] || aiBackend}) {t('atlas.dept_model_desc')}
      </p>

      <div className="space-y-2">
          {LAYER_TIERS.map(({ key, labelKey, descKey }) => {
            const value = localTiers[key] ?? ''
            const isInherited = !localTiers[key] && key !== 'default'
            return (
              <div key={key} className="flex items-center gap-3">
                <div className="w-24 shrink-0">
                  <span className="text-[12px] font-medium text-text">{t(labelKey as any)}</span>
                  <span className="text-[10px] text-text-muted block">{t(descKey as any)}</span>
                </div>
                {modelPresets.length > 0 ? (
                <select
                  className="flex-1 text-[12px] px-2 py-1.5 rounded border border-border bg-bg text-text"
                  value={modelPresets.some((m) => m.value === value) || value === '' ? value : '__custom__'}
                  onChange={(e) => handleChange(key, e.target.value === '__custom__' ? '' : e.target.value)}
                >
                  {key !== 'default' && (
                    <option value="">{t('atlas.inherit_default')}</option>
                  )}
                  {modelPresets.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="flex-1 text-[12px] px-2 py-1.5 rounded border border-border bg-bg text-text font-mono"
                  value={value}
                  onChange={(e) => handleChange(key, e.target.value)}
                  placeholder={key === 'default' ? 'model-id' : t('atlas.inherit_default')}
                />
              )}
                {isInherited && (
                  <span className="text-[10px] text-text-muted">
                    → {localTiers['default'] || 'haiku'}
                  </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ==================== Obsidian Vault Sync ====================

function ObsidianVaultEditor({
  vaultPath,
  onSave,
}: {
  vaultPath: string
  onSave: (path: string) => void
}) {
  const { t } = useLocale()
  const [localPath, setLocalPath] = useState(vaultPath)
  const [dirty, setDirty] = useState(false)

  useEffect(() => { setLocalPath(vaultPath) }, [vaultPath])

  const handleSave = () => {
    onSave(localPath.trim())
    setDirty(false)
  }

  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-base">📗</span>
          <h3 className="text-[13px] font-semibold gradient-text">{t('atlas.knowledge_graph')}</h3>
        </div>
        {dirty && (
          <button
            onClick={handleSave}
            className="text-[11px] px-2.5 py-1 rounded-md bg-accent text-white font-medium hover:opacity-90 transition-opacity"
          >
            {t('atlas.save')}
          </button>
        )}
      </div>

      <p className="text-[11px] text-text-muted mb-3">
        {t('atlas.knowledge_sync_desc')}
      </p>

      <div className="flex items-center gap-2">
        <input
          className="flex-1 text-[12px] px-2.5 py-1.5 rounded border border-border bg-bg text-text font-mono"
          value={localPath}
          onChange={(e) => { setLocalPath(e.target.value); setDirty(true) }}
          placeholder="/Users/.../Obsidian Vault"
        />
        {localPath && (
          <span className="text-[10px] text-text-muted shrink-0">
            {t('atlas.subdirectory')}
          </span>
        )}
      </div>

      {localPath && (
        <div className="mt-2 text-[10px] text-text-muted">
          <span className="text-green">●</span> {t('atlas.mirror_write')} {localPath}/Atlas/commodity/
        </div>
      )}
    </div>
  )
}

// ==================== Department Card ====================

/** Format cron schedule for display */
function useFormatSchedule() {
  const { t } = useLocale()
  return (job: CronJob): string => {
    const s = job.schedule
    if (s.kind === 'every') return `${t('atlas.every')} ${s.every}`
    if (s.kind === 'cron') return `${t('atlas.cron_label')} ${s.cron}`
    if (s.kind === 'at') return `${t('atlas.at_label')} ${new Date(s.at).toLocaleString()}`
    return t('atlas.unknown')
  }
}

function DepartmentCard({
  dept,
  onRun,
  onStop,
  cronJob,
  onToggleCron,
  onUpdateCronSchedule,
}: {
  dept: AtlasStatus['departments'][number]
  onRun: (id: string) => void
  onStop: (id: string) => void
  cronJob?: CronJob
  onToggleCron: (jobId: string, enabled: boolean) => void
  onUpdateCronSchedule: (jobId: string, every: string) => void
}) {
  const isRunning = dept.run_status === 'running'
  const { t } = useLocale()
  const formatSchedule = useFormatSchedule()
  const [editingInterval, setEditingInterval] = useState(false)
  const [intervalValue, setIntervalValue] = useState(
    cronJob?.schedule.kind === 'every' ? cronJob.schedule.every : '4h',
  )

  const handleIntervalSave = () => {
    if (cronJob && intervalValue.trim()) {
      onUpdateCronSchedule(cronJob.id, intervalValue.trim())
    }
    setEditingInterval(false)
  }

  const handleIntervalKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleIntervalSave()
    if (e.key === 'Escape') setEditingInterval(false)
  }

  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">🛢️</span>
          <h3 className="text-[15px] font-semibold gradient-text">{dept.name}</h3>
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${dept.enabled ? 'bg-green/10 text-green' : 'bg-bg-tertiary text-text-muted'}`}>
          {dept.enabled ? t('atlas.on') : t('atlas.off')}
        </span>
      </div>
      <div className="text-[12px] text-text-muted mb-3">
        <p>{t('atlas.timeframes')}: {dept.timeframes.join(', ')}</p>
        <p>{t('atlas.last_run')}: {dept.last_run ? new Date(dept.last_run).toLocaleString() : t('atlas.never')}</p>
      </div>

      {/* Cron schedule row */}
      {cronJob && (
        <div className="flex items-center justify-between mb-3 py-2 px-3 rounded-md bg-bg-tertiary">
          <div className="flex items-center gap-2">
            <span className="text-[12px]">⏱</span>
            {editingInterval ? (
              <input
                className="w-16 text-[12px] px-1.5 py-0.5 rounded border border-border bg-bg text-text font-mono"
                value={intervalValue}
                onChange={(e) => setIntervalValue(e.target.value)}
                onBlur={handleIntervalSave}
                onKeyDown={handleIntervalKeyDown}
                autoFocus
                placeholder="4h"
              />
            ) : (
              <button
                onClick={() => setEditingInterval(true)}
                className="text-[12px] text-text-muted hover:text-text transition-colors cursor-pointer"
                title={t('atlas.click_edit_interval')}
              >
                {formatSchedule(cronJob)}
              </button>
            )}
            {cronJob.enabled && cronJob.state.nextRunAtMs && (
              <span className="text-[11px] text-text-muted">
                · {t('atlas.next')} {new Date(cronJob.state.nextRunAtMs).toLocaleTimeString()}
              </span>
            )}
          </div>
          <button
            onClick={() => onToggleCron(cronJob.id, !cronJob.enabled)}
            className={`text-[11px] px-2 py-0.5 rounded-full font-medium transition-colors ${
              cronJob.enabled
                ? 'bg-green/15 text-green hover:bg-green/25'
                : 'bg-bg-secondary text-text-muted hover:bg-bg-secondary/80'
            }`}
          >
            {cronJob.enabled ? t('atlas.auto_on') : t('atlas.auto_off')}
          </button>
        </div>
      )}

      {dept.enabled && (
        <div className="flex items-center gap-2">
          {isRunning ? (
            <>
              <div className="flex items-center gap-2 text-[13px] text-amber-400">
                <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                {t('atlas.running')}
                {dept.run_started_at && (
                  <span className="text-[11px] text-text-muted">
                    ({Math.round((Date.now() - new Date(dept.run_started_at).getTime()) / 1000)}s)
                  </span>
                )}
              </div>
              <button
                onClick={() => onStop(dept.id)}
                className="px-2.5 py-1 text-[12px] font-medium rounded-md bg-red/10 text-red hover:bg-red/20 transition-colors"
              >
                {t('atlas.stop')}
              </button>
            </>
          ) : (
            <button
              onClick={() => onRun(dept.id)}
              className="px-3 py-1.5 text-[13px] font-medium rounded-md bg-accent text-white hover:opacity-90 transition-opacity"
            >
              {t('atlas.run_analysis')}
            </button>
          )}
          {dept.run_status === 'failed' && (
            <span className="text-[11px] text-red">{t('atlas.failed')}</span>
          )}
          {dept.run_status === 'stopped' && (
            <span className="text-[11px] text-text-muted">{t('atlas.stopped')}</span>
          )}
        </div>
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
  const [error, setError] = useState<string | null>(null)
  const [cronJobs, setCronJobs] = useState<CronJob[]>([])
  const [modelTiers, setModelTiers] = useState<Record<string, string>>({ default: 'claude-haiku-4-5' })
  const [aiBackend, setAiBackend] = useState('claude-code')
  const [aiProvider, setAiProvider] = useState('anthropic')
  const [obsidianVaultPath, setObsidianVaultPath] = useState('')

  const loadAtlasConfig = useCallback(async () => {
    try {
      const [cfg, appCfg] = await Promise.all([atlasApi.getConfig(), api.config.load()])
      setModelTiers(cfg.model_tiers)
      setObsidianVaultPath(cfg.obsidian_vault_path || '')
      setAiBackend(appCfg.aiProvider.backend)
      setAiProvider(appCfg.aiProvider.provider || 'anthropic')
    } catch {
      /* keep defaults */
    }
  }, [])

  const loadCronJobs = useCallback(async () => {
    try {
      const { jobs } = await cronApi.list()
      setCronJobs(jobs.filter((j) => j.name.startsWith('atlas-')))
    } catch {
      setCronJobs([])
    }
  }, [])

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
  useEffect(() => { loadCronJobs() }, [loadCronJobs])
  useEffect(() => { loadAtlasConfig() }, [loadAtlasConfig])

  const handleToggleCron = async (jobId: string, enabled: boolean) => {
    try {
      await cronApi.update(jobId, { enabled })
      await loadCronJobs()
    } catch (err) {
      setError(String(err))
    }
  }

  const handleUpdateCronSchedule = async (jobId: string, every: string) => {
    try {
      await cronApi.update(jobId, { schedule: { kind: 'every', every } })
      await loadCronJobs()
    } catch (err) {
      setError(String(err))
    }
  }

  const handleSaveModelTiers = async (tiers: Record<string, string>) => {
    try {
      const result = await atlasApi.updateConfig({ model_tiers: tiers })
      setModelTiers(result.model_tiers)
    } catch (err) {
      setError(String(err))
    }
  }

  // Poll status while any department is running
  const anyRunning = status?.departments.some((d) => d.run_status === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const timer = setInterval(() => { loadStatus(); loadScorecard() }, 3000)
    return () => clearInterval(timer)
  }, [anyRunning, loadStatus, loadScorecard])

  const handleRun = async (deptId: string) => {
    try {
      await atlasApi.runAnalysis(deptId)
      await loadStatus()
    } catch (err) {
      setError(String(err))
    }
  }

  const handleStop = async (deptId: string) => {
    try {
      await atlasApi.stopAnalysis(deptId)
      await loadStatus()
    } catch (err) {
      setError(String(err))
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
              onStop={handleStop}
              cronJob={cronJobs.find((j) => j.name === `atlas-${dept.id}`)}
              onToggleCron={handleToggleCron}
              onUpdateCronSchedule={handleUpdateCronSchedule}
            />
          ))}
        </div>
        {status?.departments.length === 0 && (
          <p className="text-[13px] text-text-muted">{t('atlas.no_departments')}</p>
        )}
      </section>

      {/* Model Tiers */}
      <section className="mt-6">
        <ModelTiersEditor tiers={modelTiers} onSave={handleSaveModelTiers} aiBackend={aiBackend} aiProvider={aiProvider} />
      </section>

      {/* Knowledge Graph — Obsidian Sync */}
      <section className="mt-6">
        <ObsidianVaultEditor
          vaultPath={obsidianVaultPath}
          onSave={async (path) => {
            try {
              const result = await atlasApi.updateConfig({ obsidian_vault_path: path })
              setObsidianVaultPath(result.obsidian_vault_path || '')
            } catch (err) {
              setError(String(err))
            }
          }}
        />
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
          <ScorecardTable agents={scorecard} locale={locale} />
        </section>
      )}
    </div>
  )
}

import { useState, useEffect, useCallback } from 'react'
import { PageHeader } from '../components/PageHeader'
import { atlasApi, type AtlasStatus, type AgentScoreItem } from '../api/atlas'
import { useLocale } from '../i18n'

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
  const { t } = useLocale()
  const [status, setStatus] = useState<AtlasStatus | null>(null)
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

      {/* Scorecard */}
      {selectedDept && (
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

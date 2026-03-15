import { useState, useEffect, useCallback, useMemo } from 'react'
import { api, type AppConfig } from '../api'
import { Toggle } from '../components/Toggle'
import { SaveIndicator } from '../components/SaveIndicator'
import { Section, Field, inputClass } from '../components/form'
import { useAutoSave } from '../hooks/useAutoSave'
import { PageHeader } from '../components/PageHeader'
import { PageLoading } from '../components/StateViews'
import { useLocale } from '../i18n'

export function SettingsPage() {
  const { t } = useLocale()
  const [config, setConfig] = useState<AppConfig | null>(null)

  useEffect(() => {
    api.config.load().then(setConfig).catch(() => {})
  }, [])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title={t('settings.title')} />

      {config ? (
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6">
          <div className="max-w-[640px] space-y-5">
            {/* Agent */}
            <Section id="agent" title={t('settings.agent')} description={t('settings.agent_desc')}>
              <div className="flex items-center justify-between gap-4 py-1">
                <div className="flex-1">
                  <span className="text-sm font-medium text-text">
                    {t('settings.evolution_mode')}
                  </span>
                  <p className="text-[12px] text-text-muted mt-0.5 leading-relaxed">
                    {config.agent?.evolutionMode
                      ? t('settings.evolution_on')
                      : t('settings.evolution_off')}
                  </p>
                </div>
                <Toggle
                  checked={config.agent?.evolutionMode || false}
                  onChange={async (v) => {
                    try {
                      await api.config.updateSection('agent', { ...config.agent, evolutionMode: v })
                      setConfig((c) => c ? { ...c, agent: { ...c.agent, evolutionMode: v } } : c)
                    } catch {
                      // Toggle doesn't flip on failure
                    }
                  }}
                />
              </div>
            </Section>

            {/* Compaction */}
            <Section id="compaction" title={t('settings.compaction')} description={t('settings.compaction_desc')}>
              <CompactionForm config={config} />
            </Section>
          </div>
      </div>
      ) : (
        <PageLoading />
      )}
    </div>
  )
}

// ==================== Form Sections ====================

function CompactionForm({ config }: { config: AppConfig }) {
  const { t } = useLocale()
  const [ctx, setCtx] = useState(String(config.compaction?.maxContextTokens || ''))
  const [out, setOut] = useState(String(config.compaction?.maxOutputTokens || ''))

  const data = useMemo(
    () => ({ maxContextTokens: Number(ctx), maxOutputTokens: Number(out) }),
    [ctx, out],
  )

  const save = useCallback(async (d: { maxContextTokens: number; maxOutputTokens: number }) => {
    await api.config.updateSection('compaction', d)
  }, [])

  const { status, retry } = useAutoSave({ data, save })

  return (
    <>
      <Field label={t('settings.max_context')}>
        <input className={inputClass} type="number" step={1000} value={ctx} onChange={(e) => setCtx(e.target.value)} />
      </Field>
      <Field label={t('settings.max_output')}>
        <input className={inputClass} type="number" step={1000} value={out} onChange={(e) => setOut(e.target.value)} />
      </Field>
      <SaveIndicator status={status} onRetry={retry} />
    </>
  )
}

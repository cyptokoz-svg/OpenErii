import { useMemo } from 'react'
import { useConfigPage } from '../hooks/useConfigPage'
import { SaveIndicator } from '../components/SaveIndicator'
import { SDKSelector, CONNECTOR_OPTIONS } from '../components/SDKSelector'
import { Section, Field, inputClass } from '../components/form'
import { PageHeader } from '../components/PageHeader'
import { useLocale } from '../i18n'
import type { AppConfig, ConnectorsConfig } from '../api'

export function ConnectorsPage() {
  const { t } = useLocale()

  const connectorOptions = useMemo(() => CONNECTOR_OPTIONS.map((opt) => ({
    ...opt,
    ...({
      web: { name: t('connectors.web_ui'), description: t('connectors.web_ui_desc') },
      mcp: { name: t('connectors.mcp_server'), description: t('connectors.mcp_server_desc') },
      mcpAsk: { name: t('connectors.mcp_ask'), description: t('connectors.mcp_ask_desc') },
      telegram: { name: t('connectors.telegram'), description: t('connectors.telegram_desc') },
    }[opt.id] ?? {}),
  })), [t])

  const { config, status, loadError, updateConfig, updateConfigImmediate, retry } =
    useConfigPage<ConnectorsConfig>({
      section: 'connectors',
      extract: (full: AppConfig) => full.connectors,
    })

  // Derive selected connector IDs from enabled flags (web + mcp are always included)
  const selected = config
    ? [
        'web',
        'mcp',
        ...(config.mcpAsk.enabled ? ['mcpAsk'] : []),
        ...(config.telegram.enabled ? ['telegram'] : []),
      ]
    : ['web', 'mcp']

  const handleToggle = (id: string) => {
    if (!config) return
    if (id === 'mcpAsk') {
      updateConfigImmediate({ mcpAsk: { ...config.mcpAsk, enabled: !config.mcpAsk.enabled } })
    } else if (id === 'telegram') {
      updateConfigImmediate({ telegram: { ...config.telegram, enabled: !config.telegram.enabled } })
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader
        title={t('connectors.title')}
        description={t('connectors.description')}
        right={<SaveIndicator status={status} onRetry={retry} />}
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        {config && (
          <div className="max-w-[640px] space-y-5">
            {/* Connector selector cards */}
            <Section
              title={t('connectors.active')}
              description={t('connectors.active_desc')}
            >
              <SDKSelector
                options={connectorOptions}
                selected={selected}
                onToggle={handleToggle}
              />
            </Section>

            {/* Web UI config — always shown */}
            <Section
              title={t('connectors.web_ui')}
              description={t('connectors.web_ui_desc')}
            >
              <Field label={t('connectors.port')}>
                <input
                  className={inputClass}
                  type="number"
                  value={config.web.port}
                  onChange={(e) => updateConfig({ web: { port: Number(e.target.value) } })}
                />
              </Field>
            </Section>

            {/* MCP Server config — always shown */}
            <Section
              title={t('connectors.mcp_server')}
              description={t('connectors.mcp_server_desc')}
            >
              <Field label={t('connectors.port')}>
                <input
                  className={inputClass}
                  type="number"
                  value={config.mcp.port}
                  onChange={(e) => updateConfig({ mcp: { port: Number(e.target.value) } })}
                />
              </Field>
            </Section>

            {/* MCP Ask config */}
            {config.mcpAsk.enabled && (
              <Section
                title={t('connectors.mcp_ask')}
                description={t('connectors.mcp_ask_desc')}
              >
                <Field label={t('connectors.port')}>
                  <input
                    className={inputClass}
                    type="number"
                    value={config.mcpAsk.port ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      updateConfig({ mcpAsk: { ...config.mcpAsk, port: v ? Number(v) : undefined } })
                    }}
                    placeholder="e.g. 3003"
                  />
                </Field>
              </Section>
            )}

            {/* Telegram config */}
            {config.telegram.enabled && (
              <Section
                title={t('connectors.telegram')}
                description={t('connectors.telegram_desc')}
              >
                <Field label={t('connectors.bot_token')}>
                  <input
                    className={inputClass}
                    type="password"
                    value={config.telegram.botToken ?? ''}
                    onChange={(e) =>
                      updateConfig({
                        telegram: { ...config.telegram, botToken: e.target.value || undefined },
                      })
                    }
                    placeholder="123456:ABC-DEF..."
                  />
                </Field>
                <Field label={t('connectors.bot_username')}>
                  <input
                    className={inputClass}
                    value={config.telegram.botUsername ?? ''}
                    onChange={(e) =>
                      updateConfig({
                        telegram: { ...config.telegram, botUsername: e.target.value || undefined },
                      })
                    }
                    placeholder="my_bot"
                  />
                </Field>
                <Field label={t('connectors.chat_ids')}>
                  <input
                    className={inputClass}
                    value={config.telegram.chatIds.join(', ')}
                    onChange={(e) =>
                      updateConfig({
                        telegram: {
                          ...config.telegram,
                          chatIds: e.target.value
                            ? e.target.value
                                .split(',')
                                .map((s) => Number(s.trim()))
                                .filter((n) => !isNaN(n))
                            : [],
                        },
                      })
                    }
                    placeholder={t('connectors.chat_ids_placeholder')}
                  />
                </Field>
              </Section>
            )}
          </div>
        )}
        {loadError && <p className="text-[13px] text-red">{t('connectors.load_error')}</p>}
      </div>
    </div>
  )
}

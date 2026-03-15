import { useState, useEffect } from 'react'
import { api } from '../api'
import type { ChannelListItem } from '../api/channels'
import type { ToolInfo } from '../api/tools'
import { useLocale } from '../i18n'

interface ChannelConfigModalProps {
  channel: ChannelListItem
  onClose: () => void
  onSaved: (updated: ChannelListItem) => void
}

export function ChannelConfigModal({ channel, onClose, onSaved }: ChannelConfigModalProps) {
  const { t } = useLocale()
  const [label, setLabel] = useState(channel.label)
  const [systemPrompt, setSystemPrompt] = useState(channel.systemPrompt ?? '')
  const [provider, setProvider] = useState(channel.provider ?? '')
  const [disabledTools, setDisabledTools] = useState<Set<string>>(new Set(channel.disabledTools ?? []))
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Vercel AI SDK override state
  const [vModelProvider, setVModelProvider] = useState(channel.vercelAiSdk?.provider ?? '')
  const [vModel, setVModel] = useState(channel.vercelAiSdk?.model ?? '')
  const [vBaseUrl, setVBaseUrl] = useState(channel.vercelAiSdk?.baseUrl ?? '')
  const [vApiKey, setVApiKey] = useState(channel.vercelAiSdk?.apiKey ?? '')

  // Agent SDK override state
  const [aModel, setAModel] = useState(channel.agentSdk?.model ?? '')
  const [aBaseUrl, setABaseUrl] = useState(channel.agentSdk?.baseUrl ?? '')
  const [aApiKey, setAApiKey] = useState(channel.agentSdk?.apiKey ?? '')

  const showVercelConfig = provider === 'vercel-ai-sdk'
  const showAgentSdkConfig = provider === 'agent-sdk'

  useEffect(() => {
    api.tools.load().then(({ inventory }) => setTools(inventory)).catch(() => {})
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      const vercelAiSdk = showVercelConfig && vModelProvider && vModel
        ? {
            provider: vModelProvider,
            model: vModel,
            ...(vBaseUrl ? { baseUrl: vBaseUrl } : {}),
            ...(vApiKey ? { apiKey: vApiKey } : {}),
          }
        : undefined

      const agentSdk = showAgentSdkConfig && aModel
        ? {
            model: aModel,
            ...(aBaseUrl ? { baseUrl: aBaseUrl } : {}),
            ...(aApiKey ? { apiKey: aApiKey } : {}),
          }
        : undefined

      const { channel: updated } = await api.channels.update(channel.id, {
        label: label.trim() || channel.label,
        systemPrompt: systemPrompt.trim() || undefined,
        provider: (provider as 'claude-code' | 'vercel-ai-sdk' | 'agent-sdk') || undefined,
        vercelAiSdk: vercelAiSdk ?? (null as unknown as undefined),
        agentSdk: agentSdk ?? (null as unknown as undefined),
        disabledTools: disabledTools.size > 0 ? [...disabledTools] : undefined,
      })
      onSaved(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channel.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const toggleTool = (name: string) => {
    setDisabledTools((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // Group tools by group name
  const toolGroups = tools.reduce<Record<string, ToolInfo[]>>((acc, tool) => {
    ;(acc[tool.group] ??= []).push(tool)
    return acc
  }, {})

  const inputClass = 'w-full text-sm px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text placeholder:text-text-muted focus:outline-none focus:border-accent'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-bg border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text">
            <span className="text-text-muted mr-1">#</span>
            {channel.id}
          </h2>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-secondary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Label */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">{t('channel.label')}</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className={inputClass}
            />
          </div>

          {/* System Prompt */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">{t('channel.system_prompt')}</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t('channel.system_prompt_placeholder')}
              rows={4}
              className={`${inputClass} resize-y`}
            />
          </div>

          {/* AI Backend */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">{t('channel.ai_backend')}</label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className={inputClass}
            >
              <option value="">{t('channel.default_global')}</option>
              <option value="vercel-ai-sdk">Vercel AI SDK</option>
              <option value="claude-code">Claude Code</option>
              <option value="agent-sdk">Agent SDK</option>
            </select>
          </div>

          {/* Vercel AI SDK config — only when provider is vercel-ai-sdk */}
          {showVercelConfig && (
            <div className="rounded-lg border border-border/50 bg-bg-secondary/30 p-3 space-y-3">
              <p className="text-xs font-medium text-text-muted">{t('channel.vercel_config')}</p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-text-muted/70 mb-1">{t('channel.llm_provider')}</label>
                  <select
                    value={vModelProvider}
                    onChange={(e) => setVModelProvider(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">{t('channel.select')}</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="google">Google</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-text-muted/70 mb-1">{t('ai.model')}</label>
                  <input
                    type="text"
                    value={vModel}
                    onChange={(e) => setVModel(e.target.value)}
                    placeholder="e.g. gpt-4o"
                    className={inputClass}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-text-muted/70 mb-1">{t('channel.base_url')} <span className="text-text-muted/40">({t('channel.optional')})</span></label>
                <input
                  type="text"
                  value={vBaseUrl}
                  onChange={(e) => setVBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className={inputClass}
                />
                {vModelProvider === 'anthropic' && (
                  <p className="mt-1 text-xs text-text-muted/60">
                    Anthropic-compatible APIs: URL must end with <code className="font-mono">/v1</code> — e.g. <code className="font-mono">https://example.com/anthropic/v1</code>
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs text-text-muted/70 mb-1">{t('trading.api_key')} <span className="text-text-muted/40">({t('channel.optional_override')})</span></label>
                <input
                  type="password"
                  value={vApiKey}
                  onChange={(e) => setVApiKey(e.target.value)}
                  placeholder="sk-..."
                  className={inputClass}
                />
              </div>
            </div>
          )}

          {/* Agent SDK config — only when provider is agent-sdk */}
          {showAgentSdkConfig && (
            <div className="rounded-lg border border-border/50 bg-bg-secondary/30 p-3 space-y-3">
              <p className="text-xs font-medium text-text-muted">{t('channel.agent_sdk_override')}</p>

              <div>
                <label className="block text-xs text-text-muted/70 mb-1">{t('ai.model')}</label>
                <input
                  type="text"
                  value={aModel}
                  onChange={(e) => setAModel(e.target.value)}
                  placeholder="e.g. claude-opus-4-6"
                  className={inputClass}
                />
              </div>

              <div>
                <label className="block text-xs text-text-muted/70 mb-1">{t('channel.base_url')} <span className="text-text-muted/40">({t('channel.optional')})</span></label>
                <input
                  type="text"
                  value={aBaseUrl}
                  onChange={(e) => setABaseUrl(e.target.value)}
                  placeholder={t('channel.leave_empty')}
                  className={inputClass}
                />
              </div>

              <div>
                <label className="block text-xs text-text-muted/70 mb-1">{t('trading.api_key')} <span className="text-text-muted/40">({t('channel.optional_override')})</span></label>
                <input
                  type="password"
                  value={aApiKey}
                  onChange={(e) => setAApiKey(e.target.value)}
                  placeholder="sk-ant-..."
                  className={inputClass}
                />
              </div>
            </div>
          )}

          {/* Disabled Tools */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-2">
              {t('channel.disabled_tools')}
              {disabledTools.size > 0 && (
                <span className="ml-2 text-text-muted/60">({disabledTools.size} {t('channel.disabled_count')})</span>
              )}
            </label>
            {tools.length === 0 ? (
              <p className="text-xs text-text-muted">{t('channel.loading_tools')}</p>
            ) : (
              <div className="space-y-3 max-h-48 overflow-y-auto">
                {Object.entries(toolGroups).map(([group, groupTools]) => (
                  <div key={group}>
                    <p className="text-xs font-medium text-text-muted/70 mb-1">{group}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {groupTools.map((tool) => {
                        const isDisabled = disabledTools.has(tool.name)
                        return (
                          <button
                            key={tool.name}
                            onClick={() => toggleTool(tool.name)}
                            title={tool.description}
                            className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                              isDisabled
                                ? 'border-red-400/30 bg-red-400/10 text-red-400 line-through'
                                : 'border-border bg-bg-secondary text-text hover:border-accent/50'
                            }`}
                          >
                            {tool.name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-between">
          {error ? <p className="text-xs text-red-400">{error}</p> : <div />}
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="text-sm px-3 py-1.5 rounded-lg text-text-muted hover:text-text transition-colors"
            >
              {t('trading.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-sm px-4 py-1.5 rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors disabled:opacity-50"
            >
              {saving ? t('trading.saving') : t('trading.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

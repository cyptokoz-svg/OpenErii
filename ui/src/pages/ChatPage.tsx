import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../api'
import type { ChannelListItem } from '../api/channels'
import { useChat } from '../hooks/useChat'
import { ChatMessage, ToolCallGroup, ThinkingIndicator, StreamingToolGroup } from '../components/ChatMessage'
import { ChatInput } from '../components/ChatInput'
import { ChannelConfigModal } from '../components/ChannelConfigModal'
import { useLocale } from '../i18n'

interface ChatPageProps {
  onSSEStatus?: (connected: boolean) => void
}

export function ChatPage({ onSSEStatus }: ChatPageProps) {
  const { t } = useLocale()
  const [channels, setChannels] = useState<ChannelListItem[]>([{ id: 'default', label: 'Erii' }])
  const [activeChannel, setActiveChannel] = useState('default')
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [newMsgCount, setNewMsgCount] = useState(0)

  const { messages, streamSegments, isWaiting, send, abort } = useChat({
    channel: activeChannel,
    onSSEStatus: activeChannel === 'default' ? onSSEStatus : undefined,
  })

  // Popover state
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [showNewForm, setShowNewForm] = useState(false)
  const [newChannelId, setNewChannelId] = useState('')
  const [newChannelLabel, setNewChannelLabel] = useState('')
  const [newChannelError, setNewChannelError] = useState('')
  const [editingChannel, setEditingChannel] = useState<ChannelListItem | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ChannelListItem | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const isOnSubChannel = activeChannel !== 'default'
  const subChannels = channels.filter((ch) => ch.id !== 'default')
  const activeChannelConfig = channels.find((ch) => ch.id === activeChannel)

  // Close popover on outside click
  useEffect(() => {
    if (!popoverOpen) return
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopoverOpen(false)
        setShowNewForm(false)
        setNewChannelError('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [popoverOpen])

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    if (!userScrolledUp.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [])

  useEffect(scrollToBottom, [messages, isWaiting, streamSegments, scrollToBottom])

  // Detect user scroll
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      const isUp = scrollHeight - scrollTop - clientHeight > 80
      userScrolledUp.current = isUp
      setShowScrollBtn(isUp)
      if (!isUp) setNewMsgCount(0)
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Load channels list on mount
  useEffect(() => {
    api.channels.list().then(({ channels: ch }) => setChannels(ch)).catch(() => {})
  }, [])

  // Cleanup abort on unmount
  useEffect(() => {
    return () => { abort() }
  }, [abort])

  const handleScrollToBottom = useCallback(() => {
    userScrolledUp.current = false
    setShowScrollBtn(false)
    setNewMsgCount(0)
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const switchToChannel = useCallback((id: string) => {
    setActiveChannel(id)
    setPopoverOpen(false)
    setShowNewForm(false)
    setNewChannelError('')
  }, [])

  const handleCreateChannel = useCallback(async () => {
    setNewChannelError('')
    if (!newChannelId.trim() || !newChannelLabel.trim()) {
      setNewChannelError(t('chat.id_required'))
      return
    }
    try {
      const { channel } = await api.channels.create({ id: newChannelId.trim(), label: newChannelLabel.trim() })
      setChannels((prev) => [...prev, channel])
      switchToChannel(channel.id)
      setNewChannelId('')
      setNewChannelLabel('')
    } catch (err) {
      setNewChannelError(err instanceof Error ? err.message : 'Failed to create channel')
    }
  }, [newChannelId, newChannelLabel, switchToChannel])

  const handleRequestDelete = useCallback((ch: ChannelListItem, e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmDelete(ch)
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    if (!confirmDelete) return
    const id = confirmDelete.id
    try {
      await api.channels.remove(id)
      setChannels((prev) => prev.filter((ch) => ch.id !== id))
      if (activeChannel === id) switchToChannel('default')
    } catch (err) {
      console.error('Failed to delete channel:', err)
    }
    setConfirmDelete(null)
  }, [confirmDelete, activeChannel, switchToChannel])

  return (
    <div className="flex flex-col flex-1 min-h-0 max-w-[800px] mx-auto w-full">
      {/* Channel tab bar — always visible */}
      <div className="flex items-center gap-0.5 px-3 py-1.5 overflow-x-auto" style={{ borderBottom: '1px solid var(--color-border)' }} ref={popoverRef}>
        {/* Main channel tab */}
        <button
          onClick={() => switchToChannel('default')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all shrink-0 btn-press ${
            activeChannel === 'default'
              ? 'bg-accent/12 text-accent channel-tab-active'
              : 'text-text-muted hover:text-text hover:bg-bg-tertiary/50'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={activeChannel === 'default' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
          </svg>
          Erii
        </button>

        {/* Divider between main and sub-channels */}
        {subChannels.length > 0 && (
          <div className="w-px h-5 bg-border/60 mx-1 shrink-0" />
        )}

        {/* Sub-channel tabs */}
        {subChannels.map((ch) => (
          <div key={ch.id} className="flex items-center shrink-0 group">
            <button
              onClick={() => switchToChannel(ch.id)}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[13px] font-medium transition-all btn-press ${
                activeChannel === ch.id
                  ? 'bg-accent/12 text-accent channel-tab-active'
                  : 'text-text-muted hover:text-text hover:bg-bg-tertiary/50'
              }`}
            >
              <span className={activeChannel === ch.id ? 'opacity-70' : 'opacity-40'}>#</span>
              {ch.label}
            </button>
            {/* Settings & delete — visible on hover; atlas-* channels are system-managed, no delete */}
            <span className={`flex items-center gap-0.5 transition-opacity ${activeChannel === ch.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
              <span
                onClick={(e) => { e.stopPropagation(); setEditingChannel(ch) }}
                className="w-5 h-5 rounded flex items-center justify-center text-text-muted/50 hover:text-text-muted hover:bg-bg-secondary cursor-pointer"
                title={t('chat.channel_settings')}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </span>
              {!ch.id.startsWith('atlas-') && (
                <span
                  onClick={(e) => handleRequestDelete(ch, e)}
                  className="w-5 h-5 rounded flex items-center justify-center text-text-muted/50 hover:text-red-400 hover:bg-red-400/10 cursor-pointer"
                  title={t('common.delete')}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </span>
              )}
            </span>
          </div>
        ))}

        {/* New channel button / inline form */}
        {!showNewForm ? (
          <button
            onClick={() => setShowNewForm(true)}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-[12px] text-text-muted/50 hover:text-text-muted hover:bg-bg-secondary/60 transition-all shrink-0"
            title={t('chat.new_channel')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        ) : (
          <div className="flex items-center gap-1.5 shrink-0 ml-1">
            <input
              type="text"
              placeholder="id"
              value={newChannelId}
              onChange={(e) => setNewChannelId(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ''))}
              className="w-20 text-[12px] px-2 py-1 rounded border border-border bg-bg text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
              autoFocus
            />
            <input
              type="text"
              placeholder={t('channel.label')}
              value={newChannelLabel}
              onChange={(e) => setNewChannelLabel(e.target.value)}
              className="w-24 text-[12px] px-2 py-1 rounded border border-border bg-bg text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateChannel(); if (e.key === 'Escape') { setShowNewForm(false); setNewChannelError('') } }}
            />
            <button
              onClick={handleCreateChannel}
              className="text-[11px] px-2 py-1 rounded bg-accent text-white hover:bg-accent/80 transition-colors"
            >
              {t('trading.create')}
            </button>
            <button
              onClick={() => { setShowNewForm(false); setNewChannelError(''); setNewChannelId(''); setNewChannelLabel('') }}
              className="text-[11px] px-1.5 py-1 rounded text-text-muted hover:text-text"
            >
              {t('trading.cancel')}
            </button>
            {newChannelError && <span className="text-[11px] text-red-400">{newChannelError}</span>}
          </div>
        )}
      </div>

      {/* Messages area */}
      <div className="flex-1 min-h-0 relative">

        {/* Scrollable messages */}
        <div ref={containerRef} className="h-full overflow-y-auto overflow-x-hidden px-3 py-3 md:px-5 md:py-6">
        {messages.length === 0 && !isWaiting && (
          <div className="flex-1 flex flex-col items-center justify-center h-full gap-4 select-none">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center glow-accent" style={{ background: 'linear-gradient(135deg, rgba(6,214,160,0.15) 0%, rgba(124,92,252,0.15) 100%)', border: '1px solid var(--color-border)' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="url(#welcomeGrad)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <defs>
                  <linearGradient id="welcomeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#06d6a0" />
                    <stop offset="100%" stopColor="#7c5cfc" />
                  </linearGradient>
                </defs>
                <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
              </svg>
            </div>
            <div className="text-center">
              {activeChannel === 'default' ? (
                <>
                  <h2 className="text-lg font-semibold gradient-text mb-1">{t('chat.greeting')}</h2>
                  <p className="text-sm text-text-muted">{t('chat.start_chatting')}</p>
                </>
              ) : (
                <>
                  <h2 className="text-lg font-semibold text-text mb-1">{activeChannelConfig?.label ?? activeChannel}</h2>
                  <p className="text-sm text-text-muted">{t('chat.start_chatting')}</p>
                </>
              )}
            </div>
          </div>
        )}
        <div className="flex flex-col">
          {messages.map((msg, i) => {
            const prev = i > 0 ? messages[i - 1] : undefined

            if (msg.kind === 'tool_calls') {
              const prevIsAssistantish = prev != null && (
                prev.kind === 'tool_calls' ||
                (prev.kind === 'text' && prev.role === 'assistant')
              )
              return (
                <div key={msg._id} className={prevIsAssistantish ? 'mt-1' : i === 0 ? '' : 'mt-5'}>
                  <ToolCallGroup calls={msg.calls} timestamp={msg.timestamp} />
                </div>
              )
            }

            const isGrouped =
              msg.role === 'assistant' && prev != null && (
                (prev.kind === 'text' && prev.role === 'assistant') ||
                prev.kind === 'tool_calls'
              )
            return (
              <div key={msg._id} className={isGrouped ? 'mt-1' : i === 0 ? '' : 'mt-5'}>
                <ChatMessage
                  role={msg.role}
                  text={msg.text}
                  timestamp={msg.timestamp}
                  isGrouped={isGrouped}
                  media={msg.media}
                />
              </div>
            )
          })}
          {isWaiting && (
            <div className={`${messages.length > 0 ? 'mt-5' : ''}`}>
              {streamSegments.length > 0 ? (
                <>
                  {streamSegments.map((seg, i) => {
                    if (seg.kind === 'tools') {
                      const allDone = seg.tools.every((t) => t.status === 'done')
                      return (
                        <div key={i} className={i > 0 ? 'mt-1' : ''}>
                          {allDone ? (
                            <ToolCallGroup calls={seg.tools.map((t) => ({
                              name: t.name,
                              input: typeof t.input === 'string' ? t.input : JSON.stringify(t.input ?? ''),
                              result: t.result,
                            }))} />
                          ) : (
                            <StreamingToolGroup tools={seg.tools} />
                          )}
                        </div>
                      )
                    }
                    return (
                      <div key={i} className={i > 0 ? 'mt-1' : ''}>
                        <ChatMessage role="assistant" text={seg.text} isGrouped={i > 0} />
                      </div>
                    )
                  })}
                  {(() => {
                    const last = streamSegments[streamSegments.length - 1]
                    if (last?.kind === 'tools' && last.tools.every((t) => t.status === 'done')) {
                      return (
                        <div className="text-text-muted ml-8 mt-1">
                          <div className="flex">
                            <span className="thinking-dot">.</span>
                            <span className="thinking-dot">.</span>
                            <span className="thinking-dot">.</span>
                          </div>
                        </div>
                      )
                    }
                    return null
                  })()}
                </>
              ) : (
                <ThinkingIndicator />
              )}
            </div>
          )}
        </div>
        <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Scroll to bottom button */}
      {showScrollBtn && (
        <div className="relative">
          <button
            onClick={handleScrollToBottom}
            className="absolute -top-14 left-1/2 -translate-x-1/2 w-10 h-10 rounded-full bg-bg-secondary border border-border text-text-muted hover:text-text hover:border-accent/50 flex items-center justify-center transition-all shadow-lg z-10"
            aria-label="Scroll to bottom"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
            {newMsgCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] rounded-full bg-accent text-white text-[10px] font-semibold flex items-center justify-center px-1">
                {newMsgCount > 99 ? '99+' : newMsgCount}
              </span>
            )}
          </button>
        </div>
      )}

      {/* Input */}
      <ChatInput disabled={isWaiting} onSend={send} />

      {/* Channel config modal */}
      {editingChannel && (
        <ChannelConfigModal
          channel={editingChannel}
          onClose={() => setEditingChannel(null)}
          onSaved={(updated) => {
            setChannels((prev) => prev.map((ch) => ch.id === updated.id ? updated : ch))
            setEditingChannel(null)
          }}
        />
      )}

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setConfirmDelete(null)}>
          <div className="bg-bg border border-border rounded-xl p-5 w-80 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-text mb-2">{t('chat.delete_channel_title')}</h3>
            <p className="text-[13px] text-text-muted mb-4">
              {t('chat.delete_channel_warn')} <span className="font-medium text-text">#{confirmDelete.label}</span>
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="text-[13px] px-3 py-1.5 rounded-md text-text-muted hover:text-text hover:bg-bg-secondary transition-colors"
              >
                {t('trading.cancel')}
              </button>
              <button
                onClick={handleConfirmDelete}
                className="text-[13px] px-3 py-1.5 rounded-md bg-red/90 text-white font-medium hover:bg-red transition-colors"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

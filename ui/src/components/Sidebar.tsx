import { type ReactNode, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { type Page, ROUTES } from '../App'
import { LanguageSwitcher } from './LanguageSwitcher'
import { useLocale, type TranslationKey } from '../i18n'
import { useTheme, type ThemeMode } from '../hooks/useTheme'

const COLLAPSED_KEY = 'oa-sidebar-collapsed'

interface SidebarProps {
  sseConnected: boolean
  open: boolean
  onClose: () => void
}

// Chevron icon for expandable groups
const Chevron = ({ expanded }: { expanded: boolean }) => (
  <svg
    width="14" height="14" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

// ==================== Nav item definitions ====================

interface NavLeaf {
  page: Page
  label: string
  i18nKey?: TranslationKey
  icon: (active: boolean) => ReactNode
}

interface NavGroup {
  prefix: string
  label: string
  icon: (active: boolean) => ReactNode
  children: { page: Page; label: string; i18nKey?: TranslationKey }[]
}

type NavItem = NavLeaf | NavGroup
const isGroup = (item: NavItem): item is NavGroup => 'children' in item

// Nav items grouped by function:
//   1. Chat (primary)
//   2. Trading & Analysis: Portfolio, Trading, Atlas, Backtest
//   3. Monitoring: Events, Heartbeat
//   4. System: Data Sources, Connectors, Tools, AI Provider, Settings, Dev

const NAV_ITEMS: NavItem[] = [
  // ── Primary ──
  {
    page: 'chat', i18nKey: 'nav.chat' as const,
    label: 'Chat',
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  // ── Trading & Analysis ──
  {
    page: 'portfolio', i18nKey: 'nav.portfolio' as const,
    label: 'Portfolio',
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <path d="M8 21h8" />
        <path d="M12 17v4" />
        <path d="M7 10l3-3 2 2 5-5" />
      </svg>
    ),
  },
  {
    page: 'trading' as const, i18nKey: 'nav.trading' as const,
    label: 'Trading',
    icon: (active: boolean) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 20h20" />
        <path d="M5 17V10" /><path d="M5 7V4" /><path d="M3 10h4" /><path d="M3 7h4" />
        <path d="M10 17V13" /><path d="M10 10V6" /><path d="M8 13h4" /><path d="M8 10h4" />
        <path d="M15 17V11" /><path d="M15 8V4" /><path d="M13 11h4" /><path d="M13 8h4" />
        <path d="M20 17V14" /><path d="M20 11V8" /><path d="M18 14h4" /><path d="M18 11h4" />
      </svg>
    ),
  },
  {
    page: 'atlas' as const, i18nKey: 'nav.atlas' as const,
    label: 'Atlas',
    icon: (active: boolean) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        <path d="M2 12h20" />
      </svg>
    ),
  },
  {
    page: 'backtest' as const, i18nKey: 'nav.backtest' as const,
    label: 'Backtest',
    icon: (active: boolean) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18" />
        <path d="M7 16l4-8 4 4 4-6" />
      </svg>
    ),
  },
  // ── Monitoring ──
  {
    page: 'events', i18nKey: 'nav.events' as const,
    label: 'Events',
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    page: 'heartbeat', i18nKey: 'nav.heartbeat' as const,
    label: 'Heartbeat',
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
    ),
  },
  // ── System ──
  {
    page: 'data-sources', i18nKey: 'nav.data_sources' as const,
    label: 'Data Sources',
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      </svg>
    ),
  },
  {
    page: 'connectors', i18nKey: 'nav.connectors' as const,
    label: 'Connectors',
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    ),
  },
  {
    page: 'tools', i18nKey: 'nav.tools' as const,
    label: 'Tools',
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
    ),
  },
  {
    page: 'ai-provider', i18nKey: 'nav.ai_provider' as const,
    label: 'AI Provider',
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73v1.27h1a7 7 0 0 1 7 7h1.27c.34-.6.99-1 1.73-1a2 2 0 1 1 0 4c-.74 0-1.39-.4-1.73-1H21a7 7 0 0 1-7 7v1.27c.6.34 1 .99 1 1.73a2 2 0 1 1-4 0c0-.74.4-1.39 1-1.73V21a7 7 0 0 1-7-7H2.73c-.34.6-.99 1-1.73 1a2 2 0 1 1 0-4c.74 0 1.39.4 1.73 1H4a7 7 0 0 1 7-7V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z" />
        <circle cx="12" cy="14" r="3" />
      </svg>
    ),
  },
  {
    page: 'settings', i18nKey: 'nav.settings' as const,
    label: 'Settings',
    icon: (active) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
  {
    page: 'dev' as const, i18nKey: 'nav.dev' as const,
    label: 'Dev',
    icon: (active: boolean) => (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
]

// ==================== Helpers ====================

/** Derive active page from current URL path */
function pathToPage(pathname: string): Page | null {
  for (const [page, path] of Object.entries(ROUTES) as [Page, string][]) {
    if (path === pathname) return page
    // Match root path for chat
    if (page === 'chat' && pathname === '/') return 'chat'
  }
  return null
}

// ==================== Sidebar ====================

const THEME_ICONS: Record<ThemeMode, string> = { light: '☀️', dark: '🌙', auto: '🌗' }
const THEME_CYCLE: ThemeMode[] = ['auto', 'light', 'dark']

export function Sidebar({ sseConnected, open, onClose }: SidebarProps) {
  const location = useLocation()
  const currentPage = pathToPage(location.pathname)
  const { t } = useLocale()
  const { mode: themeMode, setMode: setThemeMode } = useTheme()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true')

  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem(COLLAPSED_KEY, String(next))
  }

  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(themeMode)
    setThemeMode(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length])
  }

  /** Resolve label: use i18n key if available, otherwise fall back to static label */
  const resolveLabel = (label: string, i18nKey?: TranslationKey) =>
    i18nKey ? t(i18nKey) : label

  return (
    <>
      {/* Backdrop — mobile only */}
      <div
        className={`fixed inset-0 bg-black/50 z-40 md:hidden transition-opacity duration-300 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        onTouchStart={(e) => {
          const startX = e.touches[0].clientX;
          const el = e.currentTarget;
          const onMove = (ev: TouchEvent) => {
            const dx = ev.touches[0].clientX - startX;
            if (dx < -60) { onClose(); el.removeEventListener('touchmove', onMove); }
          };
          el.addEventListener('touchmove', onMove, { passive: true });
          el.addEventListener('touchend', () => el.removeEventListener('touchmove', onMove), { once: true });
        }}
      />

      {/* Sidebar */}
      <aside
        className={`
          ${collapsed ? 'w-[60px]' : 'w-[220px]'} h-full flex flex-col shrink-0
          fixed z-50 top-0 left-0 transition-all duration-300 ease-out
          ${open ? 'translate-x-0' : '-translate-x-full'}
          md:static md:translate-x-0 md:z-auto
        `}
        style={{
          background: 'linear-gradient(180deg, var(--color-sidebar-top) 0%, var(--color-sidebar-bottom) 100%)',
          borderRight: '1px solid var(--color-border)',
        }}
      >
        {/* Branding + collapse toggle */}
        <div className={`py-4 flex items-center ${collapsed ? 'px-2 justify-center' : 'px-5 gap-2.5'}`}>
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg, rgba(244,114,182,0.15) 0%, rgba(192,132,252,0.15) 100%)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="url(#brandGrad)" stroke="none">
              <defs>
                <linearGradient id="brandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#f472b6" />
                  <stop offset="100%" stopColor="#c084fc" />
                </linearGradient>
              </defs>
              <path d="M12 12 C8 9,7 5,10 2.5 Q11 1,12 3.5 Q13 1,14 2.5 C17 5,16 9,12 12Z" />
              <path d="M12 12 C8 9,7 5,10 2.5 Q11 1,12 3.5 Q13 1,14 2.5 C17 5,16 9,12 12Z" transform="rotate(72 12 12)" />
              <path d="M12 12 C8 9,7 5,10 2.5 Q11 1,12 3.5 Q13 1,14 2.5 C17 5,16 9,12 12Z" transform="rotate(144 12 12)" />
              <path d="M12 12 C8 9,7 5,10 2.5 Q11 1,12 3.5 Q13 1,14 2.5 C17 5,16 9,12 12Z" transform="rotate(216 12 12)" />
              <path d="M12 12 C8 9,7 5,10 2.5 Q11 1,12 3.5 Q13 1,14 2.5 C17 5,16 9,12 12Z" transform="rotate(288 12 12)" />
              <circle cx="12" cy="12" r="2.5" opacity="0.4" />
              <circle cx="10.5" cy="10" r="0.6" opacity="0.6" />
              <circle cx="13.5" cy="10" r="0.6" opacity="0.6" />
              <circle cx="12" cy="8.5" r="0.6" opacity="0.6" />
              <circle cx="10.8" cy="12.8" r="0.6" opacity="0.6" />
              <circle cx="13.2" cy="12.8" r="0.6" opacity="0.6" />
            </svg>
          </div>
          {!collapsed && <h1 className="text-[15px] font-semibold gradient-text flex-1">OpenErii</h1>}
          {!collapsed && (
            <button
              onClick={toggleCollapsed}
              className="hidden md:flex items-center justify-center w-6 h-6 rounded-md text-text-muted hover:text-text hover:bg-bg-tertiary/40 transition-colors"
              title={t('sidebar.collapse')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="11 17 6 12 11 7" />
                <polyline points="18 17 13 12 18 7" />
              </svg>
            </button>
          )}
        </div>

        {/* Expand button — only when collapsed */}
        {collapsed && (
          <div className="hidden md:flex justify-center pb-2">
            <button
              onClick={toggleCollapsed}
              className="flex items-center justify-center w-8 h-8 rounded-md text-text-muted hover:text-text hover:bg-bg-tertiary/40 transition-colors"
              title={t('sidebar.expand')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="13 17 18 12 13 7" />
                <polyline points="6 17 11 12 6 7" />
              </svg>
            </button>
          </div>
        )}

        {/* Navigation */}
        <nav className={`flex-1 flex flex-col gap-0.5 ${collapsed ? 'px-1 items-center' : 'px-2'} overflow-y-auto overflow-x-hidden`}>
          {NAV_ITEMS.map((item) => {
            if (isGroup(item)) {
              const expanded = location.pathname.startsWith(`/${item.prefix}`)
              if (collapsed) {
                // Collapsed: show only parent icon
                return (
                  <Link
                    key={item.prefix}
                    to={ROUTES[item.children[0].page]}
                    onClick={onClose}
                    className={`relative flex items-center justify-center w-10 h-10 rounded-lg transition-colors ${
                      expanded ? 'text-text bg-bg-tertiary/60 nav-active-glow' : 'text-text-muted hover:text-text hover:bg-bg-tertiary/40'
                    }`}
                    title={resolveLabel(item.label, 'i18nKey' in item ? (item as unknown as NavLeaf).i18nKey : undefined)}
                  >
                    {expanded && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full" style={{ background: 'linear-gradient(180deg, #06d6a0, #7c5cfc)' }} />}
                    <span className="flex items-center justify-center w-5 h-5">{item.icon(expanded)}</span>
                  </Link>
                )
              }
              return (
                <div key={item.prefix}>
                  {/* Group parent */}
                  <Link
                    to={ROUTES[item.children[0].page]}
                    onClick={onClose}
                    className={`relative w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                      expanded
                        ? 'text-text bg-bg-tertiary/60'
                        : 'text-text-muted hover:text-text hover:bg-bg-tertiary/40'
                    }`}
                  >
                    {expanded && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full" style={{ background: 'linear-gradient(180deg, #06d6a0, #7c5cfc)' }} />}
                    <span className="flex items-center justify-center w-5 h-5">{item.icon(expanded)}</span>
                    <span className="flex-1">{resolveLabel(item.label, 'i18nKey' in item ? (item as unknown as NavLeaf).i18nKey : undefined)}</span>
                    <Chevron expanded={expanded} />
                  </Link>

                  {/* Children — animate height */}
                  <div
                    className={`overflow-hidden transition-all duration-150 ${
                      expanded ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'
                    }`}
                  >
                    {item.children.map((child) => {
                      const isActive = currentPage === child.page
                      return (
                        <Link
                          key={child.page}
                          to={ROUTES[child.page]}
                          onClick={onClose}
                          className={`relative w-full flex items-center pl-11 pr-3 py-1.5 rounded-lg text-[13px] transition-colors text-left ${
                            isActive
                              ? 'bg-bg-tertiary/60 text-text'
                              : 'text-text-muted hover:text-text hover:bg-bg-tertiary/40'
                          }`}
                        >
                          {isActive && <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full" style={{ background: 'linear-gradient(180deg, #06d6a0, #7c5cfc)' }} />}
                          {resolveLabel(child.label, child.i18nKey)}
                        </Link>
                      )
                    })}
                  </div>
                </div>
              )
            }

            // Leaf item
            const isActive = currentPage === item.page
            if (collapsed) {
              return (
                <Link
                  key={item.page}
                  to={ROUTES[item.page]}
                  onClick={onClose}
                  className={`relative flex items-center justify-center w-10 h-10 rounded-lg transition-colors ${
                    isActive ? 'bg-bg-tertiary/60 text-text nav-active-glow' : 'text-text-muted hover:text-text hover:bg-bg-tertiary/40'
                  }`}
                  title={resolveLabel(item.label, (item as NavLeaf).i18nKey)}
                >
                  {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full" style={{ background: 'linear-gradient(180deg, #06d6a0, #7c5cfc)' }} />}
                  <span className="flex items-center justify-center w-5 h-5">{item.icon(isActive)}</span>
                </Link>
              )
            }
            return (
              <Link
                key={item.page}
                to={ROUTES[item.page]}
                onClick={onClose}
                className={`relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                  isActive
                    ? 'bg-bg-tertiary/60 text-text'
                    : 'text-text-muted hover:text-text hover:bg-bg-tertiary/40'
                }`}
              >
                {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full" style={{ background: 'linear-gradient(180deg, #06d6a0, #7c5cfc)' }} />}
                <span className="flex items-center justify-center w-5 h-5">{item.icon(isActive)}</span>
                {resolveLabel(item.label, (item as NavLeaf).i18nKey)}
              </Link>
            )
          })}
        </nav>

        {/* SSE Connection Status + Footer */}
        <div className={`mt-auto py-3 ${collapsed ? 'px-2' : 'px-4'}`} style={{ borderTop: '1px solid var(--color-border)' }}>
          <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2'} text-[12px] text-text-muted`}>
            <span className="relative flex h-2 w-2 shrink-0" title={sseConnected ? t('common.connected') : t('common.disconnected')}>
              {sseConnected ? (
                <span className="w-2 h-2 rounded-full bg-green pulse-ring" />
              ) : (
                <>
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red/60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-red" />
                </>
              )}
            </span>
            {!collapsed && <span>{sseConnected ? t('common.connected') : t('common.disconnected')}</span>}
          </div>
          {collapsed ? (
            <div className="mt-2 flex flex-col items-center gap-1">
              <button
                onClick={cycleTheme}
                className="flex items-center justify-center w-8 h-8 rounded-md text-text-muted hover:text-text hover:bg-bg-tertiary/40 transition-colors"
                title={`Theme: ${themeMode}`}
              >
                <span className="text-[14px]">{THEME_ICONS[themeMode]}</span>
              </button>
            </div>
          ) : (
            <div className="mt-2 flex items-center justify-between">
              <button
                onClick={cycleTheme}
                className="flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text transition-colors px-2 py-1 rounded-md hover:bg-bg-tertiary/40"
                title={`Theme: ${themeMode}`}
              >
                <span>{THEME_ICONS[themeMode]}</span>
                <span className="uppercase tracking-wide">{themeMode}</span>
              </button>
              <LanguageSwitcher />
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

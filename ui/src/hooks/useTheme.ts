import { useState, useEffect, useCallback } from 'react'

export type ThemeMode = 'light' | 'dark' | 'auto'

const STORAGE_KEY = 'oa-theme-mode'

/** 6:00–18:00 local time = light */
function isDay(): boolean {
  const h = new Date().getHours()
  return h >= 6 && h < 18
}

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'auto') return isDay() ? 'light' : 'dark'
  return mode
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return (saved === 'light' || saved === 'dark' || saved === 'auto') ? saved : 'auto'
  })

  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(mode))

  const applyTheme = useCallback((theme: 'light' | 'dark') => {
    const root = document.documentElement
    if (theme === 'light') {
      root.classList.add('light')
      root.classList.remove('dark')
    } else {
      root.classList.remove('light')
      root.classList.add('dark')
    }
    // Sync iOS status bar / theme-color with header bg
    const themeColor = theme === 'light' ? '#f8f9fb' : '#0a0a0f'
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor)
    setResolved(theme)
  }, [])

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m)
    localStorage.setItem(STORAGE_KEY, m)
    applyTheme(resolveTheme(m))
  }, [applyTheme])

  // Apply on mount
  useEffect(() => {
    applyTheme(resolveTheme(mode))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto mode: re-check every minute
  useEffect(() => {
    if (mode !== 'auto') return
    const timer = setInterval(() => {
      applyTheme(resolveTheme('auto'))
    }, 60_000)
    return () => clearInterval(timer)
  }, [mode, applyTheme])

  return { mode, resolved, setMode }
}

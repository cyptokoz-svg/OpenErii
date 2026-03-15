/**
 * i18n — Internationalization system for Open Alice
 *
 * Default: English. User can switch to Chinese via UI.
 * Language preference stored in localStorage.
 *
 * Usage:
 *   const { t, locale, setLocale } = useLocale()
 *   t('atlas.title')  // "Atlas Research" or "投研部门"
 */

import { useState, useCallback, createContext, useContext, type ReactNode } from 'react'
import { en } from './en'
import { zh } from './zh'
import type { Locale, TranslationKey, TranslationKeys } from './types'

export type { Locale, TranslationKey }

const LOCALES: Record<Locale, TranslationKeys> = { en, zh }
const STORAGE_KEY = 'erii-locale'
const HTML_LANG: Record<Locale, string> = { en: 'en', zh: 'zh-CN' }

function syncHtmlLang(locale: Locale) {
  document.documentElement.lang = HTML_LANG[locale]
}

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh' || stored === 'en') return stored
  } catch { /* SSR or blocked storage */ }
  return 'en'
}

// ==================== Context ====================

interface LocaleContextValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: TranslationKey) => string
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: (key) => key,
})

// ==================== Provider ====================

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const l = getStoredLocale()
    syncHtmlLang(l)
    return l
  })

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    syncHtmlLang(l)
    try { localStorage.setItem(STORAGE_KEY, l) } catch { /* ignore */ }
  }, [])

  const t = useCallback((key: TranslationKey): string => {
    return LOCALES[locale][key] ?? LOCALES.en[key] ?? key
  }, [locale])

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LocaleContext.Provider>
  )
}

// ==================== Hook ====================

export function useLocale() {
  return useContext(LocaleContext)
}

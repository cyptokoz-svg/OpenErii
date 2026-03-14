/**
 * LanguageSwitcher — Toggle between English and Chinese
 */

import { useLocale, type Locale } from '../i18n'

const LABELS: Record<Locale, string> = {
  en: 'EN',
  zh: '中',
}

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale()

  return (
    <button
      onClick={() => setLocale(locale === 'en' ? 'zh' : 'en')}
      className="text-[12px] px-2 py-1 rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors"
      title={locale === 'en' ? 'Switch to Chinese' : '切换到英文'}
    >
      {LABELS[locale]}
    </button>
  )
}

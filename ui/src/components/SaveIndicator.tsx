import type { SaveStatus } from '../hooks/useAutoSave'
import { useLocale } from '../i18n'

export function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry?: () => void }) {
  const { t } = useLocale()

  if (status === 'idle') return null

  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] shrink-0">
      {status === 'saving' && (
        <>
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          <span className="text-text-muted">{t('save.saving')}</span>
        </>
      )}
      {status === 'saved' && (
        <>
          <span className="w-1.5 h-1.5 rounded-full bg-green" />
          <span className="text-text-muted">{t('save.saved')}</span>
        </>
      )}
      {status === 'error' && (
        <>
          <span className="w-1.5 h-1.5 rounded-full bg-red" />
          <span className="text-red">{t('save.failed')}</span>
          {onRetry && (
            <button
              onClick={onRetry}
              className="text-red underline underline-offset-2 hover:text-text ml-0.5"
            >
              {t('save.retry')}
            </button>
          )}
        </>
      )}
    </span>
  )
}

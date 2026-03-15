import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description?: ReactNode
  right?: ReactNode
}

export function PageHeader({ title, description, right }: PageHeaderProps) {
  return (
    <div className="shrink-0 relative">
      <div className="px-4 md:px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold gradient-text">{title}</h2>
          {description && (
            <p className="text-[12px] text-text-muted mt-0.5">{description}</p>
          )}
        </div>
        {right && <div className="shrink-0 ml-4">{right}</div>}
      </div>
      <div className="divider-gradient" />
    </div>
  )
}

import { Skeleton } from './States'

export type KpiTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'error'

interface KpiCardProps {
  label: string
  /** Null renders a dash: "not available", never a fabricated zero. */
  value: string | null
  hint?: string
  tone?: KpiTone
  /** Navigates to the filtered view behind this number. */
  href?: string
  loading?: boolean
  footnote?: string
}

/**
 * A headline number that is also a link to the data behind it.
 *
 * Every KPI on the dashboard is clickable because a number you cannot drill
 * into is a number you cannot verify.
 */
export function KpiCard({ label, value, hint, tone = 'neutral', href, loading, footnote }: KpiCardProps) {
  const body = (
    <>
      <span className="kpi__label">{label}</span>
      {loading ? (
        <Skeleton height={34} width="60%" className="kpi__skeleton" />
      ) : (
        <span className="kpi__value">{value ?? '—'}</span>
      )}
      {hint && <span className="kpi__hint">{hint}</span>}
      {footnote && <span className="kpi__footnote">{footnote}</span>}
      {href && (
        <span className="kpi__arrow" aria-hidden="true">
          →
        </span>
      )}
    </>
  )

  const className = `kpi kpi--${tone}${href ? ' kpi--link' : ''}`
  return href ? (
    <a className={className} href={href} aria-busy={loading || undefined}>
      {body}
    </a>
  ) : (
    <div className={className} aria-busy={loading || undefined}>
      {body}
    </div>
  )
}

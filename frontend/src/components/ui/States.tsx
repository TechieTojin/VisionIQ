/**
 * Loading, empty and error states.
 *
 * Every data view renders one of these instead of placeholder numbers. A KPI
 * that shows "0" while loading would be indistinguishable from a real zero.
 */

interface EmptyStateProps {
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
  icon?: string
  compact?: boolean
}

export function EmptyState({ title, children, action, icon = '◇', compact }: EmptyStateProps) {
  return (
    <div className={`empty${compact ? ' empty--compact' : ''}`} role="status">
      <span className="empty__icon" aria-hidden="true">
        {icon}
      </span>
      <h3 className="empty__title">{title}</h3>
      {children && <div className="empty__body">{children}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  )
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string
  message: string
  onRetry?: () => void
}) {
  return (
    <div className="empty empty--error" role="alert">
      <span className="empty__icon" aria-hidden="true">
        !
      </span>
      <h3 className="empty__title">{title}</h3>
      <div className="empty__body">{message}</div>
      {onRetry && (
        <div className="empty__action">
          <button type="button" className="btn btn--ghost" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}

/** A shimmering placeholder block. Purely decorative to assistive tech. */
export function Skeleton({
  height = 16,
  width = '100%',
  radius,
  className = '',
}: {
  height?: number | string
  width?: number | string
  radius?: number
  className?: string
}) {
  return (
    <span
      className={`skeleton ${className}`}
      aria-hidden="true"
      style={{ height, width, borderRadius: radius }}
    />
  )
}

export function LoadingBlock({ label = 'Loading…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={14} width={`${92 - i * 14}%`} />
      ))}
    </div>
  )
}

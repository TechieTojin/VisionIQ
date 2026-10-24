import { useEffect, useRef, useState } from 'react'
import { thumbnail } from '../../api/workbench'
import { useScanData } from '../../data/useScanData'

/** The standard page header used by every screen. */
export function PageHead({
  eyebrow,
  title,
  subtitle,
  actions,
  badge,
}: {
  eyebrow: string
  title: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  badge?: React.ReactNode
}) {
  return (
    <header className="page-head">
      <div className="page-head__text">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="page-title">
          {title}
          {badge}
        </h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </header>
  )
}

/**
 * Shown instead of a workbench page in cloud and demo deployments, where
 * the local FastAPI endpoints these features need do not exist.
 */
export function LocalOnly({ feature, children }: { feature: string; children?: React.ReactNode }) {
  const { source } = useScanData()
  return (
    <div className="empty" role="status">
      <span className="empty__icon" aria-hidden="true">
        ⌂
      </span>
      <h3 className="empty__title">{feature} runs on the local backend</h3>
      <div className="empty__body">
        {source.mode === 'demo'
          ? 'This is the static demo: there is no backend, so nothing can be computed, stored or trained here. Run VisionIQ locally to use it.'
          : 'Cloud mode talks to the serverless control plane, which does not host this feature. It needs the local FastAPI backend and its workbench store.'}
        {children}
      </div>
    </div>
  )
}

/** A small status pill. */
export function Pill({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'accent' | 'info'; children: React.ReactNode; title?: string }) {
  return (
    <span className={`status-pill status-pill--${tone}`} title={title}>
      {children}
    </span>
  )
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="progress-line">
      <div
        className="progress-line__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max || 100}
        aria-valuenow={max > 0 ? value : undefined}
      >
        <span className="progress-line__bar" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-line__text">{max > 0 ? `${value} / ${max}` : '…'}</span>
    </div>
  )
}

/**
 * Modal confirmation. Focus moves into the dialog, Escape cancels, and
 * focus returns to whatever opened it.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  children: React.ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  confirmDisabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('[data-autofocus], button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus?.()
    }
  }, [open, onCancel])
  if (!open) return null
  return (
    <div className="modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal__dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}>
        <h2 id="modal-title" className="modal__title">
          {title}
        </h2>
        <div className="modal__body">{children}</div>
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
            aria-busy={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// -- thumbnails ------------------------------------------------------------------

const thumbs = new Map<string, string>()
const MAX_THUMBS = 120

function rememberThumb(id: string, url: string) {
  thumbs.set(id, url)
  while (thumbs.size > MAX_THUMBS) {
    const [k, v] = thumbs.entries().next().value as [string, string]
    thumbs.delete(k)
    URL.revokeObjectURL(v)
  }
}

/**
 * A lazily-loaded scan thumbnail (server-resized JPEG). Loads only when
 * scrolled into view, and keeps at most 120 in memory.
 */
export function Thumb({ analysisId, alt, size = 256 }: { analysisId: string; alt: string; size?: number }) {
  const { source } = useScanData()
  const [state, setState] = useState<{ id: string; url: string | null; failed: boolean }>({ id: '', url: null, failed: false })
  const holder = useRef<HTMLSpanElement>(null)
  const cached = thumbs.get(analysisId)

  useEffect(() => {
    if (cached || source.mode !== 'local') return
    let cancelled = false
    const load = () =>
      thumbnail(analysisId, size).then(
        (blob) => {
          if (cancelled) return
          if (!blob) return setState({ id: analysisId, url: null, failed: true })
          const url = URL.createObjectURL(blob)
          rememberThumb(analysisId, url)
          setState({ id: analysisId, url, failed: false })
        },
        () => !cancelled && setState({ id: analysisId, url: null, failed: true }),
      )
    const el = holder.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      load()
      return () => {
        cancelled = true
      }
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect()
        load()
      }
    })
    io.observe(el)
    return () => {
      cancelled = true
      io.disconnect()
    }
  }, [analysisId, cached, size, source.mode])

  const url = cached ?? (state.id === analysisId ? state.url : null)
  const failed = state.id === analysisId && state.failed
  return (
    <span className="thumb" ref={holder}>
      {url ? <img src={url} alt={alt} loading="lazy" /> : <span className="thumb__ph" aria-hidden="true">{failed ? '▢' : ''}</span>}
    </span>
  )
}

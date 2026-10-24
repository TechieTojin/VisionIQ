import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { getAnalysisClient } from '../api/analysisClient'
import { quality, savedApi } from '../api/workbench'
import { BarList } from '../components/charts/Charts'
import { Dropzone } from '../components/Dropzone'
import { PageHead, Pill } from '../components/ui/Page'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/States'
import { useScanData } from '../data/useScanData'
import { useAsync } from '../hooks/useAsync'
import {
  batchReducer,
  MAX_BATCH,
  newBatch,
  restore,
  summarize,
  toCsv,
  validateForBatch,
  type BatchAction,
  type BatchItem,
  type BatchState,
  type BatchStatus,
} from '../lib/batch'
import { formatBytes, formatDateTime, pluralize } from '../lib/format'
import { href } from '../lib/router'
import { downloadBytes } from '../lib/pdf/export'

const STATUS: Record<BatchStatus, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'error' | 'accent' }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'accent' },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'error' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  invalid: { label: 'Rejected', tone: 'error' },
  interrupted: { label: 'Interrupted', tone: 'warn' },
}

const LOCAL_KEY = 'visioniq.batches.v1'

/** Where batch manifests are kept: the backend in local mode, else this browser. */
function useManifestStore(mode: string) {
  return useMemo(
    () => ({
      async list(): Promise<BatchState[]> {
        if (mode === 'local') {
          const items = await savedApi.list<BatchState>('batch')
          return items.map((i) => i.data)
        }
        try {
          return JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? '[]') as BatchState[]
        } catch {
          return []
        }
      },
      async save(state: BatchState): Promise<void> {
        if (mode === 'local') {
          await savedApi.put('batch', state.batchId, state)
          return
        }
        try {
          const all = (JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? '[]') as BatchState[]).filter(
            (b) => b.batchId !== state.batchId,
          )
          window.localStorage.setItem(LOCAL_KEY, JSON.stringify([state, ...all].slice(0, 20)))
        } catch {
          // Storage unavailable: the batch still runs, it just isn't remembered.
        }
      },
    }),
    [mode],
  )
}

let seq = 0
const itemId = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`

/**
 * Batch image processing. Images run ONE AT A TIME through the normal
 * analysis pipeline (the backend serialises inference anyway, and parallel
 * uploads would only queue there while holding memory).
 */
export function BatchPage() {
  const data = useScanData()
  const { source, upsert } = data
  const [state, dispatch] = useReducer(batchReducer, undefined, () => newBatch())
  const files = useRef(new Map<string, File>())
  const stateRef = useRef(state)
  const stopRef = useRef(false)
  const runningRef = useRef(false)
  const [active, setActive] = useState(false)
  const [stopRequested, setStopRequested] = useState(false)
  const [viewing, setViewing] = useState<BatchState | null>(null)
  // Clock for live elapsed times; ticks only while a batch is running.
  const [now, setNow] = useState(() => Date.now())
  const store = useManifestStore(source.mode)
  const history = useAsync(() => store.list(), [store])

  // Every change goes through `apply`, which advances the ref with the same
  // pure reducer synchronously — so the runner never reads stale state.
  const apply = useCallback((action: BatchAction) => {
    stateRef.current = batchReducer(stateRef.current, action)
    dispatch(action)
  }, [])

  // Persist the manifest (never the files) shortly after each change.
  useEffect(() => {
    if (state.items.length === 0) return
    const t = setTimeout(() => {
      store.save(state).catch(() => {})
    }, 400)
    return () => clearTimeout(t)
  }, [state, store])

  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])

  // Warn before leaving while images are still being processed.
  useEffect(() => {
    if (!active) return
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [active])

  const run = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    stopRef.current = false
    setActive(true)
    setStopRequested(false)
    // Items whose file vanished are skipped; everything else re-reads state.
    const skip = new Set<string>()
    try {
      for (;;) {
        if (stopRef.current) break
        const item = stateRef.current.items.find((i) => i.status === 'queued' && !skip.has(i.id))
        if (!item) break
        const file = files.current.get(item.id)
        if (!file) {
          skip.add(item.id)
          apply({ type: 'fail', id: item.id, now: Date.now(), error: 'The file is no longer in memory — add it again.' })
          continue
        }
        apply({ type: 'start', id: item.id, now: Date.now() })
        try {
          const record = await getAnalysisClient().analyze(file, (p) =>
            apply({ type: 'progress', id: item.id, progress: p.percent ?? 100, stage: p.stage }),
          )
          upsert(record)
          const dets = record.detection?.detections ?? []
          const categories: Record<string, number> = {}
          for (const d of dets) categories[d.label] = (categories[d.label] ?? 0) + 1
          const failed =
            record.status === 'failed'
              ? record.error ?? 'Analysis failed.'
              : record.detection?.status === 'unavailable'
                ? 'No detection model ran — nothing was analysed.'
                : null
          apply({ type: 'complete', id: item.id, now: Date.now(), analysisId: record.analysis_id, detections: dets.length, categories, failed })
          if (source.mode === 'local' && record.image_key) {
            quality.get(record.analysis_id).then(
              (q) => apply({ type: 'quality', id: item.id, overall: q.report.overall }),
              () => {},
            )
          }
        } catch (err) {
          apply({
            type: 'fail',
            id: item.id,
            now: Date.now(),
            error: err instanceof ApiError ? err.message : 'Unexpected error.',
          })
        }
      }
    } finally {
      runningRef.current = false
      setActive(false)
      setStopRequested(false)
      history.reload()
    }
  }, [upsert, source.mode, history, apply])

  const addFiles = (list: File[]) => {
    setViewing(null)
    const entries = list.map((file) => {
      const id = itemId()
      const error = validateForBatch(file)
      if (!error) files.current.set(id, file)
      return { id, file, error }
    })
    apply({ type: 'add', files: entries })
  }

  const retry = (id: string) => {
    apply({ type: 'retry', id })
    // The runner reads state through a ref; give React one tick to commit.
    setTimeout(() => void run(), 0)
  }

  const shown = viewing ?? state
  const summary = summarize(shown)
  const queued = summary.counts.queued

  return (
    <div className="page">
      <PageHead
        eyebrow="Batch processing"
        title="Analyze many images"
        subtitle="Each image runs through the same detection pipeline as a single scan, one at a time to keep memory steady. Results appear in the timeline and dashboard as they finish."
        actions={
          <>
            {!viewing && summary.total > 0 && (
              <>
                <button type="button" className="btn btn--primary" onClick={() => void run()} disabled={active || queued === 0}>
                  {active ? 'Processing…' : `Start ${pluralize(queued, 'image')}`}
                </button>
                {active && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => {
                      stopRef.current = true
                      setStopRequested(true)
                    }}
                    disabled={stopRequested}
                    title="The image currently running will finish; the rest stay queued."
                  >
                    {stopRequested ? 'Stopping after current…' : 'Pause after current'}
                  </button>
                )}
                <button type="button" className="btn btn--ghost" onClick={() => apply({ type: 'cancelAll' })} disabled={queued === 0}>
                  Cancel queued
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => { apply({ type: 'retryFailed' }); setTimeout(() => void run(), 0) }} disabled={summary.counts.failed === 0 || active}>
                  Retry failed
                </button>
              </>
            )}
            {summary.total > 0 && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => downloadBytes(new TextEncoder().encode(toCsv(shown)), `visioniq-batch-${shown.batchId}.csv`, 'text/csv')}
              >
                Export CSV
              </button>
            )}
          </>
        }
      />

      {viewing && (
        <div className="callout" role="status">
          Viewing a previous batch from {formatDateTime(viewing.createdAt)} (read-only).{' '}
          <button type="button" className="link-btn" onClick={() => setViewing(null)}>
            Back to current batch
          </button>
        </div>
      )}

      {!viewing && <Dropzone multiple disabled={false} onFilesSelected={addFiles} />}

      {summary.total > 0 && (
        <section className="kpi-grid kpi-grid--compact" aria-label="Batch summary">
          <div className="kpi"><span className="kpi__label">Images</span><span className="kpi__value">{summary.total}</span></div>
          <div className="kpi kpi--ok"><span className="kpi__label">Completed</span><span className="kpi__value">{summary.counts.completed}</span></div>
          <div className="kpi kpi--error"><span className="kpi__label">Failed / rejected</span><span className="kpi__value">{summary.counts.failed + summary.counts.invalid}</span></div>
          <div className="kpi"><span className="kpi__label">Queued / cancelled</span><span className="kpi__value">{summary.counts.queued} / {summary.counts.cancelled}</span></div>
          <div className="kpi kpi--accent"><span className="kpi__label">Detections</span><span className="kpi__value">{summary.detections}</span><span className="kpi__hint">completed images only</span></div>
          <div className="kpi"><span className="kpi__label">Mean time / image</span><span className="kpi__value">{summary.meanMs === null ? '—' : `${(summary.meanMs / 1000).toFixed(1)}s`}</span></div>
        </section>
      )}

      {summary.total === 0 ? (
        <EmptyState title="No images in this batch" icon="▦">
          Drop up to {MAX_BATCH} shelf photos above. Invalid files are rejected before anything is uploaded.
        </EmptyState>
      ) : (
        <div className="batch-grid">
          <section className="card" aria-label="Processing queue">
            <header className="card__header">
              <h2 className="card__title">Queue</h2>
              {!viewing && summary.counts.completed + summary.counts.cancelled + summary.counts.invalid > 0 && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => apply({ type: 'clearFinished' })} disabled={active}>
                  Clear finished
                </button>
              )}
            </header>
            <ol className="queue">
              {shown.items.map((item, n) => (
                <QueueRow
                  key={item.id}
                  n={n + 1}
                  item={item}
                  now={now}
                  readOnly={!!viewing}
                  duplicateIndex={item.duplicateOf ? shown.items.findIndex((i) => i.id === item.duplicateOf) + 1 : 0}
                  onCancel={() => apply({ type: 'cancel', id: item.id })}
                  onRetry={() => retry(item.id)}
                  onRemove={() => {
                    files.current.delete(item.id)
                    apply({ type: 'remove', id: item.id })
                  }}
                />
              ))}
            </ol>
          </section>
          <aside className="card">
            <h2 className="card__title">Detected categories</h2>
            <p className="card__subtitle">Model detections across completed images — not inventory.</p>
            <BarList label="Batch categories" items={summary.categories.slice(0, 12).map((c) => ({ key: c.label, label: c.label, value: c.count }))} emptyText="No completed detections yet." />
          </aside>
        </div>
      )}

      <section className="card" aria-labelledby="batch-history">
        <header className="card__header">
          <div>
            <h2 className="card__title" id="batch-history">
              Previous batches
            </h2>
            <p className="card__subtitle">
              Saved {source.mode === 'local' ? 'on the local backend' : 'in this browser'}. Files themselves are never stored here.
            </p>
          </div>
        </header>
        {history.error && !history.data ? (
          <ErrorState title="Batch history could not be loaded" message={history.error} onRetry={history.reload} />
        ) : !history.data ? (
          <LoadingBlock rows={2} label="Loading previous batches…" />
        ) : history.data.filter((b) => b.batchId !== state.batchId && b.items.length).length === 0 ? (
          <p className="note">No previous batches.</p>
        ) : (
          <ul className="history-list">
            {(history.data ?? [])
              .filter((b) => b.batchId !== state.batchId && b.items.length)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .slice(0, 10)
              .map((b) => {
                const r = restore(b)
                const s = summarize(r)
                return (
                  <li key={b.batchId}>
                    <button type="button" className="history-list__row" onClick={() => setViewing(r)}>
                      <span>{formatDateTime(b.createdAt)}</span>
                      <span className="muted">
                        {s.total} images · {s.counts.completed} completed · {s.counts.failed} failed
                        {s.counts.interrupted ? ` · ${s.counts.interrupted} interrupted` : ''}
                      </span>
                    </button>
                  </li>
                )
              })}
          </ul>
        )}
      </section>
    </div>
  )
}

function QueueRow({
  n,
  item,
  now,
  readOnly,
  duplicateIndex,
  onCancel,
  onRetry,
  onRemove,
}: {
  n: number
  item: BatchItem
  now: number
  readOnly: boolean
  duplicateIndex: number
  onCancel: () => void
  onRetry: () => void
  onRemove: () => void
}) {
  const s = STATUS[item.status]
  const elapsed =
    item.startedAt !== null ? ((item.finishedAt ?? now) - item.startedAt) / 1000 : null
  return (
    <li className={`queue__row queue__row--${item.status}`}>
      <span className="queue__n">{n}</span>
      <div className="queue__main">
        <div className="queue__name">
          {item.analysisId ? <a href={href('analyze', { id: item.analysisId })}>{item.name}</a> : item.name}
          {duplicateIndex > 0 && <span className="tag" title="Same name, size and date as an earlier file">duplicate of #{duplicateIndex}</span>}
        </div>
        <div className="queue__meta">
          <Pill tone={s.tone}>{s.label}</Pill>
          <span>{formatBytes(item.size)}</span>
          {item.status === 'running' && (
            <span>
              {item.stage === 'uploading' && item.progress < 100 ? `uploading ${item.progress}%` : 'running inference — cannot be interrupted'}
            </span>
          )}
          {elapsed !== null && <span>{elapsed.toFixed(1)}s</span>}
          {item.detections !== null && item.status === 'completed' && <span>{pluralize(item.detections, 'detection')}</span>}
          {item.quality && item.quality !== 'good' && <Pill tone={item.quality === 'poor' ? 'error' : 'warn'}>quality: {item.quality}</Pill>}
          {item.attempts > 1 && <span>attempt {item.attempts}</span>}
        </div>
        {item.status === 'running' && (
          <div className="queue__bar" aria-hidden="true">
            <span style={{ width: `${item.stage === 'uploading' ? Math.max(5, item.progress * 0.5) : 75}%` }} />
          </div>
        )}
        {item.error && <p className={`queue__error${item.status === 'interrupted' ? ' is-warn' : ''}`}>{item.error}</p>}
        {item.wasRunning && (
          <a className="link" href={href('timeline', { params: { q: item.name } })}>
            Check the timeline for this file →
          </a>
        )}
      </div>
      {!readOnly && (
        <div className="queue__actions">
          {item.status === 'queued' && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
              Cancel
            </button>
          )}
          {(item.status === 'failed' || item.status === 'cancelled') && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
              {item.status === 'failed' ? 'Retry' : 'Requeue'}
            </button>
          )}
          {item.status !== 'running' && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onRemove} aria-label={`Remove ${item.name}`}>
              ✕
            </button>
          )}
        </div>
      )}
    </li>
  )
}

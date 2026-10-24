import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { annotations, type AnnotationDoc, type AnnotationStatus } from '../api/workbench'
import { AnnotationEditor, type EditorMode } from '../components/annotate/AnnotationEditor'
import { Segmented } from '../components/ui/Controls'
import { ConfirmDialog, LocalOnly, PageHead, Pill, ProgressBar, Thumb } from '../components/ui/Page'
import { EmptyState, ErrorState, LoadingBlock, Skeleton } from '../components/ui/States'
import { useScanData } from '../data/useScanData'
import { useScanImage } from '../data/useScanImage'
import { useAsync } from '../hooks/useAsync'
import { useWorkbenchAvailable } from '../hooks/useWorkbench'
import {
  boxKind,
  commit,
  fromDoc,
  initHistory,
  redo,
  sameBoxes,
  toInput,
  undo,
  validate,
  yoloLabelFile,
  type EditorBox,
  type History,
} from '../lib/annotation'
import { formatDateTime, formatPercent, pluralize } from '../lib/format'
import { downloadBytes } from '../lib/pdf/export'
import { href, navigate } from '../lib/router'
import type { AnalysisRecord } from '../types'

const STATUS_TONE: Record<AnnotationStatus | 'none', 'neutral' | 'warn' | 'accent' | 'ok'> = {
  none: 'neutral',
  unreviewed: 'warn',
  in_progress: 'accent',
  reviewed: 'ok',
}
const STATUS_LABEL: Record<AnnotationStatus | 'none', string> = {
  none: 'Not started',
  unreviewed: 'Pre-annotated',
  in_progress: 'In review',
  reviewed: 'Reviewed',
}

export function AnnotatePage({ scanId }: { scanId?: string }) {
  const available = useWorkbenchAvailable()
  if (!available) {
    return (
      <div className="page">
        <PageHead eyebrow="Annotation Studio" title="Annotation Studio" />
        <LocalOnly feature="Annotation Studio" />
      </div>
    )
  }
  return scanId ? <Studio key={scanId} id={scanId} /> : <Queue />
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

type QueueFilter = 'all' | AnnotationStatus | 'none'

function Queue() {
  const overview = useAsync(() => annotations.overview(), [])
  const [filter, setFilter] = useState<QueueFilter>('all')
  const items = overview.data?.items ?? []
  const counts = overview.data?.counts ?? {}
  const shown = items.filter((i) => filter === 'all' || i.status === filter)

  return (
    <div className="page">
      <PageHead
        eyebrow="Annotation Studio"
        title="Review model predictions"
        subtitle="Correct the detector’s boxes to create human-verified labels. Model predictions are never modified — annotations are stored separately, with provenance for every box."
      />
      {overview.error ? (
        <ErrorState message={overview.error} onRetry={overview.reload} />
      ) : !overview.data ? (
        <LoadingBlock rows={5} />
      ) : items.length === 0 ? (
        <EmptyState title="No scans to annotate" action={<a className="btn btn--primary" href={href('analyze')}>Analyze a photo</a>}>
          Annotation starts from stored scans.
        </EmptyState>
      ) : (
        <>
          <section className="card review-progress">
            <div>
              <h2 className="card__title">Review progress</h2>
              <p className="card__subtitle">Only “Reviewed” images count as ground truth for datasets, evaluation and training.</p>
            </div>
            <ProgressBar value={counts.reviewed ?? 0} max={overview.data.total} label="Reviewed scans" />
          </section>
          <section className="card">
            <header className="card__header">
              <Segmented<QueueFilter>
                label="Annotation status"
                size="sm"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: `All (${items.length})` },
                  { value: 'none', label: `Not started (${counts.none ?? 0})` },
                  { value: 'unreviewed', label: `Pre-annotated (${counts.unreviewed ?? 0})` },
                  { value: 'in_progress', label: `In review (${counts.in_progress ?? 0})` },
                  { value: 'reviewed', label: `Reviewed (${counts.reviewed ?? 0})` },
                ]}
              />
            </header>
            {shown.length === 0 ? (
              <p className="note">No scans with this status.</p>
            ) : (
              <ul className="annot-queue">
                {shown.map((i) => (
                  <li key={i.analysis_id}>
                    <a className="annot-queue__row" href={href('annotate', { id: i.analysis_id })}>
                      <Thumb analysisId={i.analysis_id} alt="" size={128} />
                      <span className="annot-queue__main">
                        <span className="annot-queue__name">{i.filename}</span>
                        <span className="muted">
                          {formatDateTime(i.created_at)} · {pluralize(i.predictions, 'prediction')}
                          {i.stats && ` · ${pluralize(i.stats.boxes, 'box', 'boxes')} (${i.stats.human_added} added, ${i.stats.edited_predictions} edited, ${i.stats.deleted_predictions} removed)`}
                        </span>
                      </span>
                      <Pill tone={STATUS_TONE[i.status]}>{STATUS_LABEL[i.status]}</Pill>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Studio
// ---------------------------------------------------------------------------

function Studio({ id }: { id: string }) {
  const { ensureRecord } = useScanData()
  const record = useAsync(() => ensureRecord(id), [id, ensureRecord])
  const doc = useAsync(() => annotations.get(id), [id])
  const labels = useAsync(() => annotations.labels(), [])

  if (record.error) return <div className="page"><ErrorState title="Scan unavailable" message={record.error} onRetry={() => navigate(href('annotate'))} /></div>
  if (!record.data || (doc.loading && !doc.data && !doc.reason)) {
    return <div className="page"><Skeleton height={36} width="40%" /><Skeleton height={460} /></div>
  }
  if (doc.reason === 'not_annotated') {
    return <StartPanel record={record.data} onStarted={doc.reload} />
  }
  if (doc.error || !doc.data) return <div className="page"><ErrorState message={doc.error ?? 'Could not load annotations.'} onRetry={doc.reload} /></div>
  return <Workspace key={`${doc.data.revision}`} record={record.data} doc={doc.data} labels={labels.data ?? []} onLabelsChanged={labels.reload} onReload={doc.reload} />
}

function StartPanel({ record, onStarted }: { record: AnalysisRecord; onStarted: () => void }) {
  const [min, setMin] = useState(0.25)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preds = record.detection?.detections ?? []
  const n = preds.filter((d) => d.confidence >= min).length
  const go = (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    fn()
      .then(onStarted)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed.'))
      .finally(() => setBusy(false))
  }
  return (
    <div className="page">
      <PageHead eyebrow="Annotation Studio" title={record.image.filename} subtitle="This scan has no annotations yet." />
      <section className="card start-annot">
        <h2 className="card__title">Pre-annotate from model predictions</h2>
        <p className="card__subtitle">
          Copies predictions as editable starting boxes, tagged “model”. Nothing becomes ground truth until you mark the image reviewed.
        </p>
        <label className="field">
          <span>Import predictions at or above {formatPercent(min)}</span>
          <input type="range" className="range" min={0} max={95} value={Math.round(min * 100)} onChange={(e) => setMin(Number(e.target.value) / 100)} aria-valuetext={`${Math.round(min * 100)} percent, ${n} predictions`} />
        </label>
        <p className="note">{pluralize(n, 'prediction')} of {preds.length} will be imported.</p>
        <div className="row-actions">
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => go(() => annotations.importPredictions(record.analysis_id, min))}>
            Import {n} predictions
          </button>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => go(() => annotations.startEmpty(record.analysis_id))}>
            Start from scratch
          </button>
          <a className="btn btn--ghost" href={href('annotate')}>Back to queue</a>
        </div>
        {error && <p className="callout callout--error" role="alert">{error}</p>}
      </section>
    </div>
  )
}

function Workspace({
  record,
  doc,
  labels,
  onLabelsChanged,
  onReload,
}: {
  record: AnalysisRecord
  doc: AnnotationDoc
  labels: string[]
  onLabelsChanged: () => void
  onReload: () => void
}) {
  const image = useScanImage(record)
  const w = doc.image_width
  const h = doc.image_height
  const predictions = useMemo(
    () => new Map((record.detection?.detections ?? []).map((d) => [d.id, { x1: d.box.x1, y1: d.box.y1, x2: d.box.x2, y2: d.box.y2, label: d.label }])),
    [record],
  )
  const saved = useMemo(() => fromDoc(doc.boxes, predictions), [doc, predictions])
  const [history, setHistory] = useState<History>(() => initHistory(saved))
  const [live, setLive] = useState<EditorBox[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<EditorMode>('select')
  const [newLabel, setNewLabel] = useState(labels[0] ?? 'bottle')
  const [labelDraft, setLabelDraft] = useState('')
  const [status, setStatus] = useState<AnnotationStatus>(doc.status === 'unreviewed' ? 'in_progress' : doc.status)
  const [saveState, setSaveState] = useState<{ busy: boolean; error?: string; conflict?: boolean; savedAt?: string }>({ busy: false })
  const [confirmReset, setConfirmReset] = useState(false)

  const boxes = live ?? history.present
  const dirty = !sameBoxes(history.present, saved) || status !== doc.status
  const problems = validate(boxes, w, h)
  const selected = boxes.find((b) => b.id === selectedId) ?? null
  const allLabels = useMemo(() => [...new Set([...labels, ...boxes.map((b) => b.label)])].sort(), [labels, boxes])

  const change = useCallback((next: EditorBox[], isCommit: boolean) => {
    if (isCommit) {
      setLive(null)
      setHistory((h0) => commit(h0, next))
    } else {
      setLive(next)
    }
  }, [])

  const save = useCallback(
    (nextStatus: AnnotationStatus) => {
      if (problems.length) return
      setSaveState({ busy: true })
      annotations
        .save(record.analysis_id, doc.revision, nextStatus, toInput(history.present))
        .then(() => {
          setSaveState({ busy: false, savedAt: new Date().toISOString() })
          onReload()
        })
        .catch((e: unknown) =>
          setSaveState({
            busy: false,
            error: e instanceof Error ? e.message : 'Save failed.',
            conflict: e instanceof ApiError && e.reason === 'revision_conflict',
          }),
        )
    },
    [problems.length, record.analysis_id, doc.revision, history.present, onReload],
  )

  // Undo / redo / save shortcuts while the studio is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        setHistory(undo)
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault()
        setHistory(redo)
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault()
        save(status)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, status])

  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])

  const patchSelected = (patch: Partial<EditorBox>) => {
    if (!selected) return
    change(boxes.map((b) => (b.id === selected.id ? { ...b, ...patch } : b)), true)
  }

  const addLabel = () => {
    const name = labelDraft.trim()
    if (!name) return
    annotations
      .addLabel(name)
      .then(() => {
        onLabelsChanged()
        setNewLabel(name)
        setLabelDraft('')
        if (selected) patchSelected({ label: name })
      })
      .catch((e: unknown) => setSaveState({ busy: false, error: e instanceof Error ? e.message : 'Invalid label.' }))
  }

  const exportYolo = () => {
    const classes = [...new Set(boxes.map((b) => b.label))].sort()
    const stem = record.analysis_id
    downloadBytes(new TextEncoder().encode(yoloLabelFile(boxes, classes, w, h)), `${stem}.txt`, 'text/plain')
    downloadBytes(new TextEncoder().encode(`${classes.join('\n')}\n`), `${stem}.classes.txt`, 'text/plain')
  }

  const counts = {
    model: boxes.filter((b) => boxKind(b) === 'model').length,
    edited: boxes.filter((b) => boxKind(b) === 'edited').length,
    human: boxes.filter((b) => b.source === 'human').length,
    removed: doc.imported_detection_ids.filter((i) => !boxes.some((b) => b.origin_detection_id === i)).length,
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="Annotation Studio"
        title={record.image.filename}
        badge={<Pill tone={STATUS_TONE[doc.status]}>{STATUS_LABEL[doc.status]}</Pill>}
        subtitle={
          <>
            Revision {doc.revision}
            {doc.prediction_model && ` · pre-annotated by ${doc.prediction_model.name} at ≥${formatPercent(doc.import_min_confidence ?? 0)}`}
            {dirty && <strong className="text-warn"> · unsaved changes</strong>}
            {saveState.savedAt && !dirty && ' · saved'}
          </>
        }
        actions={
          <>
            <a className="btn btn--ghost" href={href('annotate')}>Queue</a>
            <button type="button" className="btn btn--ghost" onClick={() => setHistory(undo)} disabled={!history.past.length} title="Ctrl+Z">Undo</button>
            <button type="button" className="btn btn--ghost" onClick={() => setHistory(redo)} disabled={!history.future.length} title="Ctrl+Shift+Z">Redo</button>
            <button type="button" className="btn btn--ghost" onClick={exportYolo}>Export YOLO</button>
            <button type="button" className="btn btn--ghost" onClick={() => save(status)} disabled={saveState.busy || !dirty || problems.length > 0} title="Ctrl+S">
              {saveState.busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn--primary" onClick={() => { setStatus('reviewed'); save('reviewed') }} disabled={saveState.busy || problems.length > 0}>
              Mark reviewed
            </button>
          </>
        }
      />

      {saveState.error && (
        <div className="callout callout--error" role="alert">
          {saveState.error}{' '}
          {saveState.conflict && (
            <button type="button" className="link-btn" onClick={onReload}>Reload the saved version</button>
          )}
        </div>
      )}
      {problems.length > 0 && (
        <div className="callout callout--warn" role="alert">
          Fix before saving: {problems.slice(0, 3).map((p) => `${p.id} — ${p.message}`).join('; ')}
        </div>
      )}

      <div className="studio">
        <section className="card studio__canvas" aria-label="Annotation canvas">
          <div className="studio__toolbar">
            <Segmented<EditorMode>
              label="Tool"
              size="sm"
              value={mode}
              onChange={setMode}
              options={[{ value: 'select', label: 'Select / move' }, { value: 'draw', label: 'Draw box (N)' }]}
            />
            <label className="select-inline">
              New boxes
              <select value={newLabel} onChange={(e) => setNewLabel(e.target.value)}>
                {allLabels.length === 0 && <option value="bottle">bottle</option>}
                {allLabels.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <span className="legend">
              <span className="legend__item legend__item--model">model prediction</span>
              <span className="legend__item legend__item--edited">edited prediction</span>
              <span className="legend__item legend__item--human">human-added</span>
            </span>
          </div>
          {image.status === 'ready' || image.status === 'unavailable' ? (
            <AnnotationEditor
              imageUrl={image.url}
              width={w}
              height={h}
              boxes={boxes}
              selectedId={selectedId}
              mode={mode}
              newLabel={newLabel}
              onSelect={setSelectedId}
              onChange={change}
              onModeChange={setMode}
            />
          ) : (
            <Skeleton height={420} />
          )}
          {image.status === 'unavailable' && <p className="fineprint">The stored image is unavailable; boxes are shown on a blank canvas of the original size.</p>}
          <p className="fineprint">
            Drag to move, drag a handle to resize, Draw mode to add. Keyboard: click the canvas, then arrows (Shift ×10), Alt+arrows to resize, Delete, [ ] to cycle, Ctrl+Z / Ctrl+Shift+Z.
          </p>
        </section>

        <aside className="studio__side">
          <section className="card">
            <h2 className="card__title">Selected box</h2>
            {!selected ? (
              <p className="note">Select a box on the image or in the list.</p>
            ) : (
              <div className="stack-sm">
                <p className="muted">
                  {boxKind(selected) === 'human'
                    ? 'Human-added box.'
                    : `Model prediction #${selected.origin_detection_id}${selected.model_confidence !== null ? ` (${formatPercent(selected.model_confidence)} confidence, predicted '${selected.model_label}')` : ''}${boxKind(selected) === 'edited' ? ' — edited.' : ' — unchanged.'}`}
                </p>
                <label className="field">
                  <span>Label</span>
                  <select value={selected.label} onChange={(e) => patchSelected({ label: e.target.value })}>
                    {allLabels.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </label>
                <div className="zone-editor__grid">
                  {(['x1', 'y1', 'x2', 'y2'] as const).map((k) => (
                    <label key={k} className="zone-editor__field">
                      <span>{k}</span>
                      <input
                        type="number"
                        step={1}
                        value={Math.round(selected[k])}
                        min={0}
                        max={k.startsWith('x') ? w : h}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) patchSelected({ [k]: v } as Partial<EditorBox>)
                        }}
                      />
                    </label>
                  ))}
                </div>
                <button type="button" className="btn btn--danger btn--sm" onClick={() => { change(boxes.filter((b) => b.id !== selected.id), true); setSelectedId(null) }}>
                  Delete box
                </button>
              </div>
            )}
            <div className="add-label">
              <label className="field field--grow">
                <span>Create label</span>
                <input value={labelDraft} maxLength={40} onChange={(e) => setLabelDraft(e.target.value)} placeholder="e.g. cereal box" onKeyDown={(e) => e.key === 'Enter' && addLabel()} />
              </label>
              <button type="button" className="btn btn--ghost btn--sm" onClick={addLabel} disabled={!labelDraft.trim()}>Add</button>
            </div>
          </section>

          <section className="card">
            <h2 className="card__title">Review</h2>
            <dl className="kv">
              <div className="kv__row"><dt>Untouched predictions</dt><dd>{counts.model}</dd></div>
              <div className="kv__row"><dt>Edited predictions</dt><dd>{counts.edited}</dd></div>
              <div className="kv__row"><dt>Human-added</dt><dd>{counts.human}</dd></div>
              <div className="kv__row"><dt>Predictions removed</dt><dd>{counts.removed}</dd></div>
            </dl>
            <label className="field">
              <span>Status on save</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as AnnotationStatus)}>
                <option value="in_progress">In review</option>
                <option value="reviewed">Reviewed (ground truth)</option>
              </select>
            </label>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmReset(true)}>Discard annotations…</button>
          </section>

          <section className="card">
            <h2 className="card__title">Boxes ({boxes.length})</h2>
            <ul className="box-list">
              {boxes.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className={`box-list__row box-list__row--${boxKind(b)}${b.id === selectedId ? ' is-selected' : ''}`}
                    onClick={() => setSelectedId(b.id)}
                    aria-pressed={b.id === selectedId}
                  >
                    <span className="box-list__swatch" aria-hidden="true" />
                    <span>{b.label}</span>
                    <span className="muted">{Math.round(b.x2 - b.x1)}×{Math.round(b.y2 - b.y1)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="Discard all annotations for this scan?"
        confirmLabel="Discard"
        danger
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          annotations.remove(record.analysis_id).then(() => {
            setConfirmReset(false)
            onReload()
          })
        }}
      >
        The human annotations are deleted. The model’s original predictions on the scan are not affected.
      </ConfirmDialog>
    </div>
  )
}

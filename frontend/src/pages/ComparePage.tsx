import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { AnnotatedImage } from '../components/AnnotatedImage'
import { Segmented, Toggle } from '../components/ui/Controls'
import { EmptyState, ErrorState, LoadingBlock, Skeleton } from '../components/ui/States'
import { useScanData } from '../data/useScanData'
import { useScanImage } from '../data/useScanImage'
import {
  compareRecords,
  filterByThreshold,
  inferenceThreshold,
  isSuccessfulAnalysis,
  scanOutcome,
} from '../lib/analytics'
import {
  formatDateTime,
  formatPercent,
  formatSigned,
  formatSignedPercentPoints,
  pluralize,
} from '../lib/format'
import { href, navigate } from '../lib/router'
import type { AnalysisRecord, Detection } from '../types'
import { buildColorMap } from '../utils/colors'

type View = 'side' | 'wipe'

const VIEWS: { value: View; label: string }[] = [
  { value: 'side', label: 'Side by side' },
  { value: 'wipe', label: 'Wipe' },
]

/**
 * Before / after comparison of two scans.
 *
 * Deltas are changes in what the MODEL DETECTED at a common threshold —
 * lighting, angle and occlusion all move them — so the page never calls
 * them stock movement.
 */
export function ComparePage({ params }: { params: URLSearchParams }) {
  const data = useScanData()
  const a = params.get('a') ?? ''
  const b = params.get('b') ?? ''

  const candidates = useMemo(
    () => data.summaries.filter((s) => s.status === 'completed'),
    [data.summaries],
  )

  const setPair = (next: { a?: string; b?: string }) =>
    navigate(href('compare', { params: { a: next.a ?? a, b: next.b ?? b } }))

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Compare</p>
          <h1 className="page-title">Before / after</h1>
          <p className="page-subtitle">
            Compare what the model detected in two scans. Differences are changes in detections, not
            verified stock movement.
          </p>
        </div>
      </header>

      <section className="card pair-picker" aria-label="Choose scans">
        <ScanSelect
          label="Before (base)"
          value={a}
          exclude={b}
          options={candidates}
          onChange={(id) => setPair({ a: id })}
        />
        <button
          type="button"
          className="btn btn--ghost pair-picker__swap"
          onClick={() => setPair({ a: b, b: a })}
          disabled={!a || !b}
          aria-label="Swap before and after"
        >
          ⇄
        </button>
        <ScanSelect
          label="After"
          value={b}
          exclude={a}
          options={candidates}
          onChange={(id) => setPair({ b: id })}
        />
      </section>

      {data.status === 'loading' ? (
        <LoadingBlock rows={4} />
      ) : data.status === 'error' ? (
        <ErrorState message={data.error ?? 'Scans could not be loaded.'} onRetry={data.refresh} />
      ) : candidates.length < 2 ? (
        <EmptyState title="Two completed scans are needed" icon="⇄">
          Analyze at least two shelf photos — ideally the same shelf at different times — to compare them.
        </EmptyState>
      ) : !a || !b ? (
        <EmptyState title="Pick two scans" icon="⇄">
          Choose a <strong>before</strong> and an <strong>after</strong> scan above. Tip: the timeline has
          a “Compare ↔ prev” shortcut on every scan.
        </EmptyState>
      ) : a === b ? (
        <EmptyState title="Pick two different scans">A scan compared with itself has no changes.</EmptyState>
      ) : (
        <PairLoader key={`${a}|${b}`} a={a} b={b} />
      )}
    </div>
  )
}

function ScanSelect({
  label,
  value,
  exclude,
  options,
  onChange,
}: {
  label: string
  value: string
  exclude: string
  options: readonly { analysis_id: string; filename: string; created_at: string; detection_count: number }[]
  onChange: (id: string) => void
}) {
  const known = options.some((o) => o.analysis_id === value)
  return (
    <label className="field field--grow">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select a scan…</option>
        {value && !known && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.analysis_id} value={o.analysis_id} disabled={o.analysis_id === exclude}>
            {o.filename} — {formatDateTime(o.created_at)} ({pluralize(o.detection_count, 'detection')})
          </option>
        ))}
      </select>
    </label>
  )
}

function PairLoader({ a, b }: { a: string; b: string }) {
  const { ensureRecord, recordFor } = useScanData()
  const cachedA = recordFor(a)
  const cachedB = recordFor(b)
  const [state, setState] = useState<{ base?: AnalysisRecord; target?: AnalysisRecord; error?: string }>({})

  useEffect(() => {
    if (cachedA && cachedB) return
    let cancelled = false
    Promise.all([ensureRecord(a), ensureRecord(b)])
      .then(([base, target]) => {
        if (!cancelled) setState({ base, target })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            error:
              err instanceof ApiError && err.code === '404'
                ? 'One of these scans does not exist or was deleted.'
                : 'The scans could not be loaded.',
          })
      })
    return () => {
      cancelled = true
    }
  }, [a, b, cachedA, cachedB, ensureRecord])

  const base = cachedA ?? state.base
  const target = cachedB ?? state.target
  if (state.error) return <ErrorState title="Comparison unavailable" message={state.error} />
  if (!base || !target) return <LoadingBlock rows={5} label="Loading scans…" />
  return <Comparison base={base} target={target} />
}

function Comparison({ base, target }: { base: AnalysisRecord; target: AnalysisRecord }) {
  const floor = Math.max(inferenceThreshold(base), inferenceThreshold(target))
  const [threshold, setThreshold] = useState(floor)
  const [view, setView] = useState<View>('side')
  const [showBoxes, setShowBoxes] = useState(true)

  const result = useMemo(() => compareRecords(base, target, threshold), [base, target, threshold])
  const colors = useMemo(
    () => buildColorMap([...result.categories].sort((x, y) => y.after + y.before - (x.after + x.before)).map((c) => c.label)),
    [result.categories],
  )
  const bothRan = isSuccessfulAnalysis(base) && isSuccessfulAnalysis(target)
  const confByLabel = useMemo(() => new Map(result.confidence.map((c) => [c.label, c])), [result.confidence])
  const totalTone = result.total_delta > 0 ? 'up' : result.total_delta < 0 ? 'down' : 'flat'

  return (
    <div className="stack">
      {!bothRan && (
        <div className="callout callout--warn" role="note">
          <strong>One of these scans has no detections to compare.</strong>{' '}
          {[base, target]
            .filter((r) => !isSuccessfulAnalysis(r))
            .map((r) => `${r.image.filename}: ${scanOutcome(r)}`)
            .join('; ')}
          . A scan where the model did not run is not an empty shelf, so its counts are not meaningful here.
        </div>
      )}

      <section className="compare-summary" aria-label="Comparison summary">
        <div className="compare-summary__total">
          <span className="eyebrow">Detections at ≥{formatPercent(threshold)}</span>
          <span className="compare-summary__numbers">
            {result.total_before} → {result.total_after}
            <span className={`delta delta--${totalTone}`}>{formatSigned(result.total_delta)}</span>
          </span>
          <span className="fineprint">change in model detections — not verified stock movement</span>
        </div>
        <div className="compare-summary__stat">
          <span className="eyebrow">Mean confidence</span>
          <span>
            {formatPercent(result.meanBefore, 1)} → {formatPercent(result.meanAfter, 1)}
          </span>
        </div>
        <div className="compare-summary__stat">
          <span className="eyebrow">Model</span>
          <span>{result.comparable ? base.detection?.model.name ?? '—' : 'Different models'}</span>
        </div>
        <label className="compare-summary__threshold">
          <span className="eyebrow">Common threshold {formatPercent(threshold)}</span>
          <input
            type="range"
            className="range"
            min={Math.round(floor * 100)}
            max={100}
            step={1}
            value={Math.round(threshold * 100)}
            aria-valuetext={`${Math.round(threshold * 100)} percent`}
            onChange={(e) => setThreshold(Number(e.target.value) / 100)}
          />
        </label>
      </section>

      <section className="card" aria-label="Images">
        <header className="card__header">
          <Segmented label="Image view" options={VIEWS} value={view} onChange={setView} size="sm" />
          <Toggle label="Bounding boxes" checked={showBoxes} onChange={setShowBoxes} />
        </header>
        {result.dimensionsDiffer && (
          <p className="callout callout--warn" role="note">
            The images have different dimensions ({base.image.width}×{base.image.height} vs{' '}
            {target.image.width}×{target.image.height}), so they were not taken from an identical position.
          </p>
        )}
        {view === 'side' ? (
          <div className="side-by-side">
            <ComparePane title="Before" record={base} threshold={threshold} colors={colors} showBoxes={showBoxes} />
            <ComparePane title="After" record={target} threshold={threshold} colors={colors} showBoxes={showBoxes} />
          </div>
        ) : (
          <Wipe base={base} target={target} threshold={threshold} colors={colors} showBoxes={showBoxes} />
        )}
      </section>

      <section className="card" aria-labelledby="delta-title">
        <header className="card__header">
          <div>
            <h2 className="card__title" id="delta-title">
              Category changes
            </h2>
            <p className="card__subtitle">Sorted by size of change. Confidence is the per-category mean.</p>
          </div>
        </header>
        {result.categories.length === 0 ? (
          <p className="note">Neither scan has detections at this threshold.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col" className="num">
                    Before
                  </th>
                  <th scope="col" className="num">
                    After
                  </th>
                  <th scope="col" className="num">
                    Change
                  </th>
                  <th scope="col" className="num">
                    Confidence change
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.categories.map((c) => {
                  const conf = confByLabel.get(c.label)
                  return (
                    <tr key={c.label}>
                      <th scope="row">
                        <span className="dot" style={{ background: colors[c.label] }} aria-hidden="true" />
                        {c.label}
                      </th>
                      <td className="num">{c.before}</td>
                      <td className="num">{c.after}</td>
                      <td className="num">
                        <span className={`delta delta--${c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : 'flat'}`}>
                          {formatSigned(c.delta)}
                        </span>
                      </td>
                      <td className="num" title={conf ? `${formatPercent(conf.before, 1)} → ${formatPercent(conf.after, 1)}` : ''}>
                        {conf?.delta === null || conf === undefined
                          ? c.before === 0
                            ? 'new'
                            : 'gone'
                          : formatSignedPercentPoints(conf.delta)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <ul className="bullets">
          {result.notable_changes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <ul className="bullets bullets--muted">
          {result.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="row-actions">
          <a className="btn btn--ghost" href={href('reports', { params: { a: base.analysis_id, b: target.analysis_id } })}>
            Comparison report (PDF)
          </a>
        </div>
      </section>
    </div>
  )
}

function ComparePane({
  title,
  record,
  threshold,
  colors,
  showBoxes,
}: {
  title: string
  record: AnalysisRecord
  threshold: number
  colors: Record<string, string>
  showBoxes: boolean
}) {
  const image = useScanImage(record)
  const visible = useMemo(() => filterByThreshold(record.detection?.detections ?? [], threshold), [record, threshold])
  const [selected, setSelected] = useState<number | null>(null)

  return (
    <figure className="compare-pane">
      <figcaption>
        <strong>{title}</strong>{' '}
        <a className="link" href={href('analyze', { id: record.analysis_id })}>
          {record.image.filename}
        </a>
        <span className="muted"> · {formatDateTime(record.created_at)} · {pluralize(visible.length, 'detection')}</span>
      </figcaption>
      <PaneImage
        url={image.url}
        status={image.status}
        record={record}
        visible={visible}
        colors={colors}
        showBoxes={showBoxes}
        selected={selected}
        onSelect={setSelected}
      />
    </figure>
  )
}

function PaneImage({
  url,
  status,
  record,
  visible,
  colors,
  showBoxes,
  selected,
  onSelect,
  fill,
}: {
  url: string | null
  status: string
  record: AnalysisRecord
  visible: Detection[]
  colors: Record<string, string>
  showBoxes: boolean
  selected: number | null
  onSelect: (id: number | null) => void
  fill?: boolean
}) {
  if (url && status === 'ready') {
    return (
      <AnnotatedImage
        src={url}
        alt={`${record.image.filename}`}
        imageWidth={record.detection?.image_width ?? record.image.width}
        imageHeight={record.detection?.image_height ?? record.image.height}
        detections={visible}
        colors={colors}
        showBoxes={showBoxes}
        showLabels={false}
        selectedId={selected}
        onSelect={onSelect}
        fill={fill}
      />
    )
  }
  if (status === 'loading' || status === 'idle') return <Skeleton height={fill ? '100%' : 280} />
  return (
    <EmptyState title="Image not available" compact icon="▢">
      The detection data is still compared below.
    </EmptyState>
  )
}

/**
 * Wipe view: the "after" image underneath, the "before" image on top,
 * clipped at the handle. Each image is letterboxed in the same frame with
 * its own boxes, so boxes always line up with their own photo — but two
 * photos taken from slightly different positions will not line up with
 * each other, and the caption says so.
 */
function Wipe({
  base,
  target,
  threshold,
  colors,
  showBoxes,
}: {
  base: AnalysisRecord
  target: AnalysisRecord
  threshold: number
  colors: Record<string, string>
  showBoxes: boolean
}) {
  const before = useScanImage(base)
  const after = useScanImage(target)
  const [pos, setPos] = useState(50)
  const frame = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const visibleBefore = useMemo(() => filterByThreshold(base.detection?.detections ?? [], threshold), [base, threshold])
  const visibleAfter = useMemo(() => filterByThreshold(target.detection?.detections ?? [], threshold), [target, threshold])
  const noop = () => {}

  const fromPointer = (clientX: number) => {
    const rect = frame.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    setPos(Math.round(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100))))
  }

  const aspect = `${target.image.width} / ${target.image.height}`

  return (
    <div className="wipe-wrap">
      <div
        ref={frame}
        className="wipe"
        style={{ aspectRatio: aspect }}
        onPointerDown={(e) => {
          dragging.current = true
          e.currentTarget.setPointerCapture?.(e.pointerId)
          fromPointer(e.clientX)
        }}
        onPointerMove={(e) => {
          if (dragging.current) fromPointer(e.clientX)
        }}
        onPointerUp={() => {
          dragging.current = false
        }}
        onPointerCancel={() => {
          dragging.current = false
        }}
      >
        <div className="wipe__layer">
          <PaneImage
            url={after.url}
            status={after.status}
            record={target}
            visible={visibleAfter}
            colors={colors}
            showBoxes={showBoxes}
            selected={null}
            onSelect={noop}
            fill
          />
        </div>
        <div className="wipe__layer wipe__layer--top" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
          <PaneImage
            url={before.url}
            status={before.status}
            record={base}
            visible={visibleBefore}
            colors={colors}
            showBoxes={showBoxes}
            selected={null}
            onSelect={noop}
            fill
          />
        </div>
        <div className="wipe__handle" style={{ left: `${pos}%` }} aria-hidden="true">
          <span />
        </div>
        <span className="wipe__tag wipe__tag--left">Before</span>
        <span className="wipe__tag wipe__tag--right">After</span>
      </div>
      <label className="wipe__control">
        <span className="sr-only">Wipe position: before on the left, after on the right</span>
        <input
          type="range"
          className="range"
          min={0}
          max={100}
          step={1}
          value={pos}
          aria-valuetext={`${pos}% before`}
          onChange={(e) => setPos(Number(e.target.value))}
        />
      </label>
      <p className="fineprint">
        Drag across the image or use the slider (arrow keys work). The wipe is a visual aid: the two
        photos are shown in the same frame but are not registered to each other, so objects may not line
        up exactly.
      </p>
    </div>
  )
}

import { useMemo, useState } from 'react'
import { ColumnChart } from '../components/charts/Charts'
import { Segmented } from '../components/ui/Controls'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/States'
import { useScanData } from '../data/useScanData'
import {
  DATE_RANGES,
  detectionTrend,
  inRange,
  isSuccessfulAnalysis,
  localDateKey,
  LOW_CONFIDENCE,
  parseDateRange,
  scanOutcome,
  type DateRange,
  type ScanOutcome,
} from '../lib/analytics'
import {
  formatDate,
  formatDayHeading,
  formatTime,
  isRecent,
  localTimeZone,
  pluralize,
} from '../lib/format'
import { href } from '../lib/router'
import type { AnalysisRecord, AnalysisSummary } from '../types'

const TIMELINE_PAGE_SIZE = 20

type OutcomeFilter = 'all' | 'analyzed' | 'empty' | 'review' | 'problem' | 'pending'

const OUTCOME_FILTERS: { value: OutcomeFilter; label: string }[] = [
  { value: 'all', label: 'All outcomes' },
  { value: 'analyzed', label: 'Successful' },
  { value: 'empty', label: 'Nothing detected' },
  { value: 'review', label: 'Needs review (< 50%)' },
  { value: 'problem', label: 'Failed / no model' },
  { value: 'pending', label: 'In progress' },
]

const OUTCOME_LABEL: Record<ScanOutcome, string> = {
  analyzed: 'Analyzed',
  empty: 'Nothing detected',
  unavailable: 'No model',
  failed: 'Failed',
  pending: 'In progress',
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/** Outcome from the summary alone, for rows whose full record is still loading. */
function summaryOutcome(s: AnalysisSummary): ScanOutcome | null {
  if (s.status === 'failed' || s.status === 'cancelled') return 'failed'
  if (s.status === 'queued' || s.status === 'processing') return 'pending'
  return null
}

function matchesOutcome(filter: OutcomeFilter, outcome: ScanOutcome, record: AnalysisRecord | undefined): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'analyzed':
      return outcome === 'analyzed' || outcome === 'empty'
    case 'empty':
      return outcome === 'empty'
    case 'review':
      return (
        outcome === 'analyzed' &&
        !!record?.detection?.detections.some((d) => d.confidence < LOW_CONFIDENCE)
      )
    case 'problem':
      return outcome === 'failed' || outcome === 'unavailable'
    case 'pending':
      return outcome === 'pending'
  }
}

interface Row {
  summary: AnalysisSummary
  record: AnalysisRecord | undefined
  outcome: ScanOutcome | null
}

/**
 * Scan timeline: every stored scan, newest first, grouped by local calendar
 * day. Filters are seeded from the URL so dashboard links land pre-filtered.
 */
export function TimelinePage({ params }: { params: URLSearchParams }) {
  const data = useScanData()
  const now = useMemo(() => new Date(), [])

  const fromParam = params.get('from') ?? ''
  const toParam = params.get('to') ?? ''
  const [range, setRange] = useState<DateRange>(parseDateRange(params.get('range'), 'all'))
  const [from, setFrom] = useState(DATE_KEY.test(fromParam) ? fromParam : '')
  const [to, setTo] = useState(DATE_KEY.test(toParam) ? toParam : '')
  const [category, setCategory] = useState(params.get('category') ?? '')
  const [outcome, setOutcome] = useState<OutcomeFilter>(
    (OUTCOME_FILTERS.find((o) => o.value === params.get('outcome'))?.value ?? 'all') as OutcomeFilter,
  )
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [page, setPage] = useState(0)

  const allRows: Row[] = useMemo(
    () =>
      data.summaries.map((summary) => {
        const record = data.recordFor(summary.analysis_id)
        return { summary, record, outcome: record ? scanOutcome(record) : summaryOutcome(summary) }
      }),
    // recordFor changes identity whenever a record arrives.
    [data],
  )

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const r of data.records) for (const d of r.detection?.detections ?? []) set.add(d.label)
    if (category) set.add(category)
    return [...set].sort()
  }, [data.records, category])

  const needsRecord = !!category || (outcome !== 'all' && outcome !== 'pending')
  const q = query.trim().toLowerCase()

  const { rows, waiting } = useMemo(() => {
    let waiting = 0
    const rows = allRows.filter(({ summary, record, outcome: o }) => {
      if (!inRange(summary, range, now)) return false
      const day = localDateKey(new Date(summary.created_at))
      if (from && day < from) return false
      if (to && day > to) return false
      if (q && !summary.filename.toLowerCase().includes(q) && !summary.analysis_id.toLowerCase().includes(q)) {
        return false
      }
      if (needsRecord && !record) {
        // A failed or pending scan is decided by its summary alone.
        if (o && !category && matchesOutcome(outcome, o, undefined)) return true
        waiting++
        return false
      }
      if (category && !record?.detection?.detections.some((d) => d.label === category)) return false
      if (outcome !== 'all' && (!o || !matchesOutcome(outcome, o, record))) return false
      return true
    })
    return { rows, waiting }
  }, [allRows, range, now, from, to, q, needsRecord, category, outcome])

  const filteredRecords = useMemo(
    () => rows.map((r) => r.record).filter((r): r is AnalysisRecord => !!r),
    [rows],
  )
  const trend = useMemo(() => detectionTrend(filteredRecords), [filteredRecords])
  const successful = filteredRecords.filter(isSuccessfulAnalysis).length
  const problems = rows.filter((r) => r.outcome === 'failed' || r.outcome === 'unavailable').length

  const pageCount = Math.max(1, Math.ceil(rows.length / TIMELINE_PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const pageRows = rows.slice(current * TIMELINE_PAGE_SIZE, (current + 1) * TIMELINE_PAGE_SIZE)

  // The previous successful scan (older) for each row, for "compare" links.
  const previousOf = useMemo(() => {
    const map = new Map<string, string>()
    const ordered = allRows.filter((r) => r.outcome === 'analyzed' || r.outcome === 'empty')
    for (let i = 0; i < ordered.length - 1; i++) {
      map.set(ordered[i].summary.analysis_id, ordered[i + 1].summary.analysis_id)
    }
    return map
  }, [allRows])

  const groups = useMemo(() => {
    const out: { key: string; date: Date; rows: Row[] }[] = []
    for (const row of pageRows) {
      const date = new Date(row.summary.created_at)
      const key = localDateKey(date)
      const last = out[out.length - 1]
      if (last && last.key === key) last.rows.push(row)
      else out.push({ key, date, rows: [row] })
    }
    return out
  }, [pageRows])

  const filtersActive = range !== 'all' || !!from || !!to || !!category || outcome !== 'all' || !!q
  const reset = () => {
    setRange('all')
    setFrom('')
    setTo('')
    setCategory('')
    setOutcome('all')
    setQuery('')
    setPage(0)
  }
  const update = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setPage(0)
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Timeline</p>
          <h1 className="page-title">Scan timeline</h1>
          <p className="page-subtitle">
            Every scan, newest first. Days are grouped in your timezone ({localTimeZone()}).
          </p>
        </div>
      </header>

      <section className="card filters" aria-label="Filters">
        <Segmented label="Date range" options={DATE_RANGES} value={range} onChange={update(setRange)} size="sm" />
        <label className="field">
          <span>From</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => update(setFrom)(e.target.value)} />
        </label>
        <label className="field">
          <span>To</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => update(setTo)(e.target.value)} />
        </label>
        <label className="field">
          <span>Category</span>
          <select value={category} onChange={(e) => update(setCategory)(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Outcome</span>
          <select value={outcome} onChange={(e) => update(setOutcome)(e.target.value as OutcomeFilter)}>
            {OUTCOME_FILTERS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--grow">
          <span>Search</span>
          <input
            type="search"
            placeholder="Filename or scan id"
            value={query}
            onChange={(e) => update(setQuery)(e.target.value)}
          />
        </label>
        {filtersActive && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={reset}>
            Clear filters
          </button>
        )}
      </section>

      {data.status === 'error' ? (
        <ErrorState title="Scan history could not be loaded" message={data.error ?? ''} onRetry={data.refresh} />
      ) : data.status === 'loading' ? (
        <LoadingBlock rows={6} label="Loading scans…" />
      ) : (
        <>
          <section className="card" aria-labelledby="tl-trend">
            <header className="card__header">
              <div>
                <h2 className="card__title" id="tl-trend">
                  Detections per {trend.bucket}
                </h2>
                <p className="card__subtitle">
                  {pluralize(rows.length, 'scan')} match · {successful} successful ·{' '}
                  {problems} failed or without a model (never counted as successful)
                </p>
              </div>
            </header>
            <ColumnChart
              label={`Detections per ${trend.bucket} for the filtered scans`}
              columns={trend.points.map((p) => ({
                key: p.key,
                label: formatDate(p.start),
                value: p.detections,
                description: `${formatDate(p.start)}: ${pluralize(p.detections, 'detection')} across ${pluralize(p.analyzedScans, 'successful scan')}`,
              }))}
              height={120}
              emptyText="No analysed scans match these filters."
            />
          </section>

          {waiting > 0 && (
            <p className="fineprint" role="status">
              Loading {pluralize(waiting, 'more scan')} needed for this filter…
            </p>
          )}

          {rows.length === 0 ? (
            data.summaries.length === 0 ? (
              <EmptyState
                title="No scans yet"
                action={
                  data.source.canAnalyze ? (
                    <a className="btn btn--primary" href={href('analyze')}>
                      Analyze a shelf photo
                    </a>
                  ) : undefined
                }
              >
                Scans appear here as soon as they are analysed.
              </EmptyState>
            ) : (
              <EmptyState
                title="No scans match"
                action={
                  <button type="button" className="btn btn--ghost" onClick={reset}>
                    Clear filters
                  </button>
                }
              >
                Try a wider date range or a different category.
              </EmptyState>
            )
          ) : (
            <div className="timeline">
              {groups.map((g) => (
                <section key={g.key} className="timeline__day" aria-label={formatDayHeading(g.date)}>
                  <h2 className="timeline__heading">
                    {formatDayHeading(g.date)}
                    <span className="timeline__count">{pluralize(g.rows.length, 'scan')}</span>
                  </h2>
                  <ol className="timeline__list">
                    {g.rows.map((row) => (
                      <TimelineRow
                        key={row.summary.analysis_id}
                        row={row}
                        previousId={previousOf.get(row.summary.analysis_id)}
                        now={now}
                      />
                    ))}
                  </ol>
                </section>
              ))}

              {pageCount > 1 && (
                <nav className="pager" aria-label="Timeline pages">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={current === 0}
                    onClick={() => setPage(current - 1)}
                  >
                    ← Newer
                  </button>
                  <span>
                    Page {current + 1} of {pageCount}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={current >= pageCount - 1}
                    onClick={() => setPage(current + 1)}
                  >
                    Older →
                  </button>
                </nav>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function TimelineRow({ row, previousId, now }: { row: Row; previousId?: string; now: Date }) {
  const { summary, record, outcome } = row
  const id = summary.analysis_id
  const low = record?.detection?.detections.filter((d) => d.confidence < LOW_CONFIDENCE).length ?? 0
  const ran = outcome === 'analyzed' || outcome === 'empty'

  return (
    <li className="timeline__item">
      <span className={`timeline__dot timeline__dot--${outcome ?? 'loading'}`} aria-hidden="true" />
      <div className="timeline__main">
        <a className="timeline__name" href={href('analyze', { id })}>
          {summary.filename}
        </a>
        {isRecent(summary.created_at, now) && <span className="tag tag--new">New</span>}
        <div className="timeline__meta">
          <span>{formatTime(summary.created_at)}</span>
          <span className={`tag tag--${outcome ?? 'loading'}`}>{outcome ? OUTCOME_LABEL[outcome] : 'Loading…'}</span>
          {ran && <span>{pluralize(summary.detection_count, 'detection')}</span>}
          {summary.top_labels.length > 0 && <span className="muted">{summary.top_labels.join(', ')}</span>}
          {low > 0 && <span className="text-warn">{low} below 50%</span>}
          {summary.execution_mode === 'demo' && <span className="tag">demo</span>}
        </div>
      </div>
      <div className="timeline__actions">
        <a className="btn btn--ghost btn--sm" href={href('analyze', { id })}>
          Open
        </a>
        {ran && previousId && (
          <a
            className="btn btn--ghost btn--sm"
            href={href('compare', { params: { a: previousId, b: id } })}
            title="Compare with the previous successful scan"
          >
            Compare ↔ prev
          </a>
        )}
        <a className="btn btn--ghost btn--sm" href={href('reports', { params: { scan: id } })}>
          Report
        </a>
      </div>
    </li>
  )
}

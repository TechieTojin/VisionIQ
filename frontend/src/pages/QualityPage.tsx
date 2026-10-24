import { useMemo, useState } from 'react'
import { ApiError, validateFile } from '../api/client'
import { quality, type QualityLevel, type QualityReport } from '../api/workbench'
import { QualityBadge, QualityCard } from '../components/analyze/QualityCard'
import { BarList } from '../components/charts/Charts'
import { Dropzone } from '../components/Dropzone'
import { Segmented } from '../components/ui/Controls'
import { LocalOnly, PageHead, Thumb } from '../components/ui/Page'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/States'
import { useAsync } from '../hooks/useAsync'
import { useWorkbenchAvailable } from '../hooks/useWorkbench'
import { formatDateTime } from '../lib/format'
import { href } from '../lib/router'

type Filter = 'all' | QualityLevel

/**
 * Image Quality Inspector. Two jobs: check a photo BEFORE analysing it (the
 * file is inspected and discarded — nothing is stored), and review the
 * quality of every stored scan.
 */
export function QualityPage() {
  const available = useWorkbenchAvailable()
  const list = useAsync(() => (available ? quality.list() : Promise.resolve(null)), [available])
  const [pre, setPre] = useState<{ name: string; report?: QualityReport; error?: string; busy?: boolean } | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [backfill, setBackfill] = useState<{ busy: boolean; message?: string }>({ busy: false })

  const items = useMemo(() => list.data?.items ?? [], [list.data])
  const counts = useMemo(() => {
    const c = { good: 0, warn: 0, poor: 0 }
    for (const i of items) c[i.report.overall]++
    return c
  }, [items])
  const issueCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of items) for (const issue of i.report.issues) m.set(issue.key, (m.get(issue.key) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [items])
  const shown = items.filter((i) => filter === 'all' || i.report.overall === filter).sort((a, b) => b.created_at.localeCompare(a.created_at))

  if (!available) {
    return (
      <div className="page">
        <PageHead eyebrow="Image quality" title="Image quality inspector" />
        <LocalOnly feature="Image quality inspection" />
      </div>
    )
  }

  const inspect = (file: File) => {
    const problem = validateFile(file)
    if (problem) return setPre({ name: file.name, error: problem })
    setPre({ name: file.name, busy: true })
    quality
      .inspect(file)
      .then((report) => setPre({ name: file.name, report }))
      .catch((e: unknown) => setPre({ name: file.name, error: e instanceof ApiError ? e.message : 'Inspection failed.' }))
  }

  const runBackfill = () => {
    setBackfill({ busy: true })
    quality
      .backfill(25)
      .then((r) => {
        setBackfill({ busy: false, message: `Inspected ${r.computed} scans${r.failed.length ? `, ${r.failed.length} without a readable image` : ''}. ${r.remaining} remaining.` })
        list.reload()
      })
      .catch((e: unknown) => setBackfill({ busy: false, message: e instanceof Error ? e.message : 'Failed.' }))
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="Image quality"
        title="Image quality inspector"
        subtitle="Deterministic checks for blur, exposure, contrast and resolution. Warnings explain why detection may struggle — they never block analysis."
      />

      <div className="quality-grid">
        <section className="card" aria-labelledby="precheck">
          <header className="card__header">
            <div>
              <h2 className="card__title" id="precheck">Check a photo before analysing</h2>
              <p className="card__subtitle">Inspected on the local backend and discarded — not stored, no scan created.</p>
            </div>
          </header>
          <Dropzone onFileSelected={inspect} disabled={pre?.busy} />
          {pre && (
            <div className="stack-sm precheck">
              <strong>{pre.name}</strong>
              {pre.busy && <LoadingBlock rows={2} label="Inspecting…" />}
              {pre.error && <p className="callout callout--error" role="alert">{pre.error}</p>}
              {pre.report && <QualityCard report={pre.report} />}
            </div>
          )}
        </section>

        <section className="card" aria-labelledby="method">
          <h2 className="card__title" id="method">How it is measured</h2>
          <dl className="kv">
            <div className="kv__row"><dt>Sharpness</dt><dd>Variance of the Laplacian at 1024 px. Warn &lt; 120, poor &lt; 50.</dd></div>
            <div className="kv__row"><dt>Brightness</dt><dd>Mean luminance 0–255. Good 70–215.</dd></div>
            <div className="kv__row"><dt>Contrast</dt><dd>Luminance standard deviation. Warn &lt; 35, poor &lt; 20.</dd></div>
            <div className="kv__row"><dt>Clipping</dt><dd>Share of pixels ≤ 5 (warn &gt; 35%) or ≥ 250 (warn &gt; 25%).</dd></div>
            <div className="kv__row"><dt>Resolution</dt><dd>Shortest side. Warn &lt; 640 px, poor &lt; 320 px.</dd></div>
          </dl>
          <p className="fineprint">
            Rules of thumb for shelf photos, not a calibrated score. A plain, evenly lit surface can read as “blurry” because it
            has few edges.
          </p>
        </section>
      </div>

      <section className="card" aria-labelledby="stored-q">
        <header className="card__header">
          <div>
            <h2 className="card__title" id="stored-q">Stored scans</h2>
            <p className="card__subtitle">
              {list.data ? `${items.length} of ${list.data.scans} scans inspected.` : 'Loading…'} New scans are inspected automatically after analysis.
            </p>
          </div>
          <div className="page-head__actions">
            <Segmented<Filter>
              label="Quality filter"
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: `All (${items.length})` },
                { value: 'poor', label: `Poor (${counts.poor})` },
                { value: 'warn', label: `Check (${counts.warn})` },
                { value: 'good', label: `Good (${counts.good})` },
              ]}
            />
            {list.data && list.data.missing.length > 0 && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={runBackfill} disabled={backfill.busy}>
                {backfill.busy ? 'Inspecting…' : `Inspect ${Math.min(25, list.data.missing.length)} older scans`}
              </button>
            )}
          </div>
        </header>
        {backfill.message && <p className="fineprint" role="status">{backfill.message}</p>}
        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : !list.data ? (
          <LoadingBlock rows={4} />
        ) : items.length === 0 ? (
          <EmptyState title="No inspected scans yet" compact>
            Analyze a photo, or inspect older scans with the button above.
          </EmptyState>
        ) : (
          <div className="quality-list-grid">
            <ul className="quality-list">
              {shown.slice(0, 60).map((i) => (
                <li key={i.analysis_id} className="quality-list__row">
                  <Thumb analysisId={i.analysis_id} alt="" size={96} />
                  <div className="quality-list__main">
                    <a href={href('analyze', { id: i.analysis_id })} className="quality-list__name">{i.filename}</a>
                    <span className="muted">{formatDateTime(i.created_at)}</span>
                    {i.report.issues.length > 0 && (
                      <span className="quality-list__issues">{i.report.issues.map((x) => x.message).join(' ')}</span>
                    )}
                  </div>
                  <QualityBadge level={i.report.overall} />
                </li>
              ))}
            </ul>
            <aside>
              <h3 className="section-title">Most common issues</h3>
              <BarList
                label="Issues across inspected scans"
                items={issueCounts.map(([k, v]) => ({ key: k, label: k.replace('_', ' '), value: v }))}
                emptyText="No issues found."
              />
            </aside>
          </div>
        )}
      </section>
    </div>
  )
}

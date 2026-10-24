import { useMemo } from 'react'
import { alerts as alertsApi } from '../api/workbench'
import { BarList, ColumnChart } from '../components/charts/Charts'
import { useAsync } from '../hooks/useAsync'
import { Segmented } from '../components/ui/Controls'
import { KpiCard } from '../components/ui/KpiCard'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/States'
import { useScanData } from '../data/useScanData'
import {
  DATE_RANGES,
  datasetStats,
  detectionTrend,
  inRange,
  inspectionAlerts,
  parseDateRange,
  type AlertSeverity,
} from '../lib/analytics'
import {
  formatCount,
  formatDate,
  formatPercent,
  formatRelative,
  isRecent,
  pluralize,
} from '../lib/format'
import { href, navigate } from '../lib/router'
import { buildColorMap, colorFor } from '../utils/colors'

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Review',
}

/**
 * AI Retail Command Center.
 *
 * Every number is computed by `datasetStats` / `detectionTrend` /
 * `inspectionAlerts` from the scans actually stored — nothing is seeded, and
 * a dataset with no scans shows an empty state, not zeros dressed up as data.
 */
export function DashboardPage({ params }: { params: URLSearchParams }) {
  const data = useScanData()
  const smart = useAsync(
    () => (data.source.mode === 'local' ? alertsApi.summary() : Promise.resolve(null)),
    [data.source.mode, data.records.length],
  )
  const range = parseDateRange(params.get('range'))
  // One clock per render so every figure on the page uses the same "now".
  const now = useMemo(() => new Date(), [])

  const scoped = useMemo(() => data.records.filter((r) => inRange(r, range, now)), [data.records, range, now])
  const stats = useMemo(() => datasetStats(data.records, range, now), [data.records, range, now])
  const trend = useMemo(() => detectionTrend(scoped), [scoped])
  const alerts = useMemo(() => inspectionAlerts(scoped), [scoped])
  const colors = useMemo(() => buildColorMap(stats.categories.map((c) => c.label)), [stats.categories])
  const recent = scoped.slice(0, 6)

  const loading = data.status === 'loading'
  // Record-derived KPIs wait for every record, so a half-loaded dataset
  // never shows a misleadingly low total.
  const partial = loading || data.recordsLoading
  const tl = (params: Record<string, string>) => href('timeline', { params: { range, ...params } })
  const rangeLabel = DATE_RANGES.find((r) => r.value === range)?.label.toLowerCase() ?? range

  const head = (
    <header className="page-head">
      <div>
        <p className="eyebrow">Command center</p>
        <h1 className="page-title">AI Retail Command Center</h1>
        <p className="page-subtitle">
          Live figures from {data.source.mode === 'demo' ? 'the recorded demo scans' : 'your stored scans'}.
          Counts are model detections, not inventory.
        </p>
      </div>
      <div className="page-head__actions">
        <Segmented
          label="Date range"
          options={DATE_RANGES}
          value={range}
          onChange={(r) => navigate(href('dashboard', { params: { range: r } }))}
        />
        <button type="button" className="btn btn--ghost" onClick={data.refresh} disabled={loading}>
          Refresh
        </button>
      </div>
    </header>
  )

  if (data.status === 'error') {
    return (
      <div className="page">
        {head}
        <ErrorState title="Scan history could not be loaded" message={data.error ?? ''} onRetry={data.refresh} />
      </div>
    )
  }

  if (!loading && data.summaries.length === 0) {
    return (
      <div className="page">
        {head}
        <EmptyState
          title="No scans yet"
          icon="◎"
          action={
            data.source.canAnalyze ? (
              <a className="btn btn--primary" href={href('analyze')}>
                Analyze a shelf photo
              </a>
            ) : undefined
          }
        >
          The command center fills in from real analyses. Run your first scan to see detections,
          categories and trends here.
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="page">
      {head}

      <section className="kpi-grid" aria-label="Key figures">
        <KpiCard
          label="Scans"
          value={formatCount(stats.totalScans)}
          hint={range === 'all' ? 'all time' : `in the last ${rangeLabel}`}
          href={tl({})}
          loading={partial}
        />
        <KpiCard
          label="Successful analyses"
          value={formatCount(stats.analyzedScans)}
          hint={`${stats.emptyScans} with nothing above threshold`}
          tone="ok"
          href={tl({ outcome: 'analyzed' })}
          loading={partial}
        />
        <KpiCard
          label="Model detections"
          value={formatCount(stats.totalDetections)}
          hint="objects detected, not stock"
          tone="accent"
          href={tl({})}
          loading={partial}
        />
        <KpiCard
          label="Mean confidence"
          value={stats.meanConfidence === null ? null : formatPercent(stats.meanConfidence, 1)}
          hint="model score, uncalibrated"
          loading={partial}
        />
        <KpiCard
          label="Scans to review"
          value={formatCount(stats.scansNeedingReview)}
          hint={`${pluralize(stats.lowConfidenceCount, 'detection')} below 50%`}
          tone={stats.scansNeedingReview ? 'warn' : 'neutral'}
          href={tl({ outcome: 'review' })}
          loading={partial}
        />
        <KpiCard
          label="Failed / no model"
          value={formatCount(stats.failedScans + stats.unavailableScans)}
          hint="not counted as successful"
          tone={stats.failedScans + stats.unavailableScans ? 'error' : 'neutral'}
          href={tl({ outcome: 'problem' })}
          loading={partial}
        />
        {data.source.mode === 'local' && (
          <KpiCard
            label="Open smart alerts"
            value={smart.data ? formatCount(smart.data.open) : null}
            hint={smart.data ? `${smart.data.by_severity.critical} critical · ${smart.data.by_severity.warning} warning` : 'rule-based, from Alerts'}
            tone={smart.data?.by_severity.critical ? 'error' : smart.data?.open ? 'warn' : 'neutral'}
            href={href('alerts')}
            loading={smart.loading && !smart.data}
          />
        )}
      </section>

      {data.truncated && (
        <p className="fineprint">
          Showing the {data.cap} most recent scans. Older scans exist but are not included in these figures.
        </p>
      )}

      <div className="dash-grid">
        <section className="card dash-grid__wide" aria-labelledby="trend-title">
          <header className="card__header">
            <div>
              <h2 className="card__title" id="trend-title">
                Detections over time
              </h2>
              <p className="card__subtitle">
                Per {trend.bucket}, successful analyses only. Select a column to open that{' '}
                {trend.bucket} in the timeline.
              </p>
            </div>
          </header>
          {partial ? (
            <LoadingBlock rows={4} />
          ) : (
            <ColumnChart
              label={`Detections per ${trend.bucket}`}
              columns={trend.points.map((p) => ({
                key: p.key,
                label: formatDate(p.start),
                value: p.detections,
                description: `${formatDate(p.start)}: ${pluralize(p.detections, 'detection')} in ${pluralize(p.analyzedScans, 'successful scan')} (${pluralize(p.scans, 'scan')} total)`,
                href:
                  trend.bucket === 'day'
                    ? href('timeline', { params: { from: p.key, to: p.key } })
                    : undefined,
              }))}
              emptyText="No scans in this range."
            />
          )}
        </section>

        <section className="card" aria-labelledby="cat-title">
          <header className="card__header">
            <div>
              <h2 className="card__title" id="cat-title">
                Detected categories
              </h2>
              <p className="card__subtitle">Generic COCO labels — a bottle, not a product.</p>
            </div>
          </header>
          {partial ? (
            <LoadingBlock rows={5} />
          ) : (
            <BarList
              label="Detections by category"
              items={stats.categories.slice(0, 10).map((c) => ({
                key: c.label,
                label: c.label,
                value: c.count,
                detail: formatPercent(c.share),
                color: colorFor(colors, c.label),
                href: tl({ category: c.label }),
              }))}
              emptyText="No detections in this range."
            />
          )}
        </section>

        <section className="card" aria-labelledby="alert-title">
          <header className="card__header">
            <div>
              <h2 className="card__title" id="alert-title">
                Inspection alerts
              </h2>
              <p className="card__subtitle">Derived from what each scan recorded.</p>
            </div>
            {alerts.length > 0 && <span className="badge">{alerts.length}</span>}
          </header>
          {partial ? (
            <LoadingBlock rows={4} />
          ) : alerts.length === 0 ? (
            <EmptyState title="No alerts" compact icon="✓">
              No failed, unavailable or low-confidence scans in this range.
            </EmptyState>
          ) : (
            <ul className="alerts">
              {alerts.slice(0, 8).map((a) => (
                <li key={a.id}>
                  <a className={`alert alert--${a.severity}`} href={href('analyze', { id: a.analysisId })}>
                    <span className="alert__sev">{SEVERITY_LABEL[a.severity]}</span>
                    <span className="alert__body">
                      <strong>{a.title}</strong>
                      <span>
                        {a.filename} · {formatRelative(a.createdAt, now)}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
              {alerts.length > 8 && (
                <li className="fineprint">
                  {alerts.length - 8} more —{' '}
                  <a className="link" href={tl({ outcome: 'review' })}>
                    see timeline
                  </a>
                </li>
              )}
            </ul>
          )}
        </section>

        <section className="card dash-grid__wide" aria-labelledby="recent-title">
          <header className="card__header">
            <h2 className="card__title" id="recent-title">
              Recent activity
            </h2>
            <a className="link" href={tl({})}>
              Full timeline →
            </a>
          </header>
          {partial && recent.length === 0 ? (
            <LoadingBlock rows={3} />
          ) : recent.length === 0 ? (
            <EmptyState title="Nothing in this range" compact>
              Choose a longer date range to see older scans.
            </EmptyState>
          ) : (
            <ul className="activity">
              {recent.map((r) => (
                <li key={r.analysis_id}>
                  <a className="activity__row" href={href('analyze', { id: r.analysis_id })}>
                    <span className="activity__name">
                      {r.image.filename}
                      {isRecent(r.created_at, now) && <span className="tag tag--new">New</span>}
                    </span>
                    <span className="activity__meta">
                      {r.detection ? pluralize(r.detection.detections.length, 'detection') : 'no detections'}
                    </span>
                    <span className="activity__time">{formatRelative(r.created_at, now)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

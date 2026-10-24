import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { Segmented } from '../components/ui/Controls'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/States'
import { useScanData } from '../data/useScanData'
import { useScanImage } from '../data/useScanImage'
import {
  compareRecords,
  filterByThreshold,
  inferenceThreshold,
  scanOutcome,
  summarizeDetections,
} from '../lib/analytics'
import { formatDateTime, formatPercent, formatSigned, pluralize } from '../lib/format'
import { href, navigate } from '../lib/router'
import { isDefaultLayout, loadZones } from '../lib/zones'
import type { AnalysisRecord } from '../types'
import { buildColorMap } from '../utils/colors'
import { ReportButton } from './reportActions'

type Kind = 'single' | 'comparison'

const KINDS: { value: Kind; label: string }[] = [
  { value: 'single', label: 'Single scan' },
  { value: 'comparison', label: 'Comparison' },
]

/**
 * Report builder. The PDF is generated in the browser from the stored scan,
 * so nothing is uploaded and nothing costs money.
 */
export function ReportsPage({ params }: { params: URLSearchParams }) {
  const data = useScanData()
  const scan = params.get('scan') ?? ''
  const a = params.get('a') ?? ''
  const b = params.get('b') ?? ''
  const kind: Kind = a || b || params.get('kind') === 'comparison' ? 'comparison' : 'single'
  const options = useMemo(() => data.summaries.filter((s) => s.status === 'completed'), [data.summaries])

  const go = (next: Record<string, string>) => navigate(href('reports', { params: next }))

  const select = (label: string, value: string, onChange: (id: string) => void, exclude?: string) => (
    <label className="field field--grow">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select a scan…</option>
        {value && !options.some((o) => o.analysis_id === value) && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.analysis_id} value={o.analysis_id} disabled={o.analysis_id === exclude}>
            {o.filename} — {formatDateTime(o.created_at)}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Reports</p>
          <h1 className="page-title">Inspection reports</h1>
          <p className="page-subtitle">
            A multi-page PDF built in your browser from the stored scan: annotated image, model details,
            categories, confidence, zones, warnings and disclaimers.
          </p>
        </div>
      </header>

      <section className="card filters" aria-label="Report contents">
        <Segmented
          label="Report type"
          options={KINDS}
          value={kind}
          onChange={(k) => go(k === 'single' ? { scan: b || scan } : { a: '', b: scan || b, kind: 'comparison' })}
          size="sm"
        />
        {kind === 'single' ? (
          select('Scan', scan, (id) => go({ scan: id }))
        ) : (
          <>
            {select('Before (base)', a, (id) => go({ a: id, b, kind: 'comparison' }), b)}
            {select('After (reported scan)', b, (id) => go({ a, b: id, kind: 'comparison' }), a)}
          </>
        )}
      </section>

      {data.status === 'loading' ? (
        <LoadingBlock rows={4} />
      ) : data.status === 'error' ? (
        <ErrorState message={data.error ?? 'Scans could not be loaded.'} onRetry={data.refresh} />
      ) : options.length === 0 ? (
        <EmptyState title="No completed scans" icon="▤">
          Analyze a shelf photo first; its report can then be exported here.
        </EmptyState>
      ) : kind === 'single' ? (
        scan ? (
          <Loader key={scan} ids={[scan]} />
        ) : (
          <EmptyState title="Choose a scan" icon="▤">
            Pick the scan to report on above.
          </EmptyState>
        )
      ) : a && b && a !== b ? (
        <Loader key={`${a}|${b}`} ids={[a, b]} />
      ) : (
        <EmptyState title="Choose two different scans" icon="⇄">
          The report covers the <strong>after</strong> scan and adds a comparison against the{' '}
          <strong>before</strong> scan.
        </EmptyState>
      )}
    </div>
  )
}

function Loader({ ids }: { ids: string[] }) {
  const { ensureRecord } = useScanData()
  const [state, setState] = useState<{ records?: AnalysisRecord[]; error?: string }>({})

  useEffect(() => {
    let cancelled = false
    Promise.all(ids.map((id) => ensureRecord(id)))
      .then((records) => {
        if (!cancelled) setState({ records })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            error:
              err instanceof ApiError && err.code === '404'
                ? 'This scan does not exist or was deleted.'
                : 'The scan could not be loaded.',
          })
      })
    return () => {
      cancelled = true
    }
    // ids is recreated each render; the parent keys this component by id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureRecord])

  if (state.error) return <ErrorState title="Report unavailable" message={state.error} />
  if (!state.records) return <LoadingBlock rows={4} label="Loading scan…" />
  const [first, second] = state.records
  return second ? <Preview record={second} base={first} /> : <Preview record={first} />
}

function Preview({ record, base }: { record: AnalysisRecord; base?: AnalysisRecord }) {
  const { source } = useScanData()
  const image = useScanImage(record)
  const threshold = inferenceThreshold(record)
  const zones = useMemo(() => loadZones(), [])
  const visible = useMemo(() => filterByThreshold(record.detection?.detections ?? [], threshold), [record, threshold])
  const summary = useMemo(() => summarizeDetections(visible), [visible])
  const colors = useMemo(() => buildColorMap(summary.categories.map((c) => c.label)), [summary])
  const comparison = useMemo(() => (base ? compareRecords(base, record) : null), [base, record])
  const outcome = scanOutcome(record)

  const imageLine =
    image.status === 'ready'
      ? 'Annotated image with bounding boxes'
      : image.status === 'unavailable'
        ? source.mode === 'cloud'
          ? 'Image not embedded (not served in cloud mode) — stated in the report'
          : 'Image not found — stated in the report'
        : 'Annotated image (loading…)'

  return (
    <section className="card report-preview" aria-labelledby="report-title">
      <header className="card__header">
        <div>
          <h2 className="card__title" id="report-title">
            {record.image.filename}
          </h2>
          <p className="card__subtitle">
            {formatDateTime(record.created_at)} · {record.detection?.model.name ?? 'no model'} ·{' '}
            {pluralize(summary.count, 'detection')} at ≥{formatPercent(threshold)}
          </p>
        </div>
        <ReportButton
          record={record}
          base={base}
          imageUrl={image.url}
          threshold={threshold}
          zones={zones}
          colors={colors}
          label="Download PDF"
          className="btn btn--primary"
        />
      </header>

      {outcome !== 'analyzed' && outcome !== 'empty' && (
        <div className="callout callout--warn" role="note">
          This scan has no model results ({outcome}). The report will say so rather than show any counts.
        </div>
      )}

      <h3 className="section-title">The report will contain</h3>
      <ul className="checklist">
        <li>Scan identity, capture time and execution mode{record.execution_mode === 'demo' && ' (marked as a recorded demo)'}</li>
        <li>{imageLine}</li>
        <li>
          Detection summary — {summary.count} detections, {summary.categories.length} categories, mean confidence{' '}
          {formatPercent(summary.meanConfidence, 1)}
        </li>
        <li>Model details: name, version, provider, device, inference time</li>
        <li>Category chart and table, confidence histogram, size distribution</li>
        <li>
          Zone breakdown using your {isDefaultLayout(zones) ? 'default top / middle / bottom' : `${zones.length} custom`}{' '}
          zones
        </li>
        <li>Warnings ({summary.lowConfidenceCount} low-confidence detections) and full detection list</li>
        {comparison && base && (
          <li>
            Comparison with {base.image.filename}: {comparison.total_before} → {comparison.total_after} detections (
            {formatSigned(comparison.total_delta)}), per-category changes and caveats
          </li>
        )}
        <li>Limitations and disclaimers — detections are not inventory; confidence is not calibrated</li>
      </ul>
      <p className="fineprint">
        Generated locally in your browser. Nothing is uploaded. Uses the scan&apos;s inference threshold (
        {formatPercent(threshold)}); to report at a stricter threshold, export from the scan view after moving the
        confidence slider.
      </p>
    </section>
  )
}

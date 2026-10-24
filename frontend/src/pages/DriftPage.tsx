import { useState } from 'react'
import { alerts as alertsApi, driftApi, savedApi, type DriftMetric, type DriftResult, type DriftStatus } from '../api/workbench'
import { ColumnChart } from '../components/charts/Charts'
import { Segmented } from '../components/ui/Controls'
import { LocalOnly, PageHead, Pill } from '../components/ui/Page'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/States'
import { useAsync } from '../hooks/useAsync'
import { useWorkbenchAvailable } from '../hooks/useWorkbench'
import { formatDate, formatDateTime } from '../lib/format'
import { href } from '../lib/router'

interface Preset {
  id: string
  label: string
  comparison_days: number
  baseline_days: number
}

const PRESETS: Preset[] = [
  { id: '7v30', label: 'Last 7 days vs previous 30', comparison_days: 7, baseline_days: 30 },
  { id: '1v7', label: 'Last day vs previous 7', comparison_days: 1, baseline_days: 7 },
  { id: '30v60', label: 'Last 30 days vs previous 60', comparison_days: 30, baseline_days: 60 },
]

const TONE: Record<DriftStatus, 'ok' | 'warn' | 'error' | 'neutral'> = { stable: 'ok', moderate: 'warn', major: 'error', insufficient: 'neutral' }

function windowsFor(comparisonDays: number, baselineDays: number, now = new Date()) {
  const end = now
  const cmpStart = new Date(end.getTime() - comparisonDays * 86_400_000)
  const baseStart = new Date(cmpStart.getTime() - baselineDays * 86_400_000)
  return {
    baseline_start: baseStart.toISOString(),
    baseline_end: cmpStart.toISOString(),
    comparison_start: cmpStart.toISOString(),
    comparison_end: end.toISOString(),
  }
}

const dateInput = (iso: string) => iso.slice(0, 10)

export function DriftPage() {
  const available = useWorkbenchAvailable()
  const [mode, setMode] = useState<'preset' | 'custom'>('preset')
  const [preset, setPreset] = useState<Preset>(PRESETS[0])
  const [custom, setCustom] = useState(() => windowsFor(7, 30))
  const [result, setResult] = useState<DriftResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const saved = useAsync(() => (available ? savedApi.list<Preset>('drift_config') : Promise.resolve([])), [available])

  if (!available) {
    return (
      <div className="page">
        <PageHead eyebrow="Drift monitor" title="Model drift monitoring" />
        <LocalOnly feature="Drift monitoring" />
      </div>
    )
  }

  const run = (windows = mode === 'preset' ? windowsFor(preset.comparison_days, preset.baseline_days) : custom) => {
    setBusy(true)
    setError(null)
    driftApi
      .analyze(windows)
      .then(setResult)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Analysis failed.'))
      .finally(() => setBusy(false))
  }

  const saveConfig = () => {
    const id = `cfg${preset.comparison_days}v${preset.baseline_days}`
    savedApi.put('drift_config', id, preset).then(() => {
      setNotice(`Saved “${preset.label}”.`)
      saved.reload()
    })
  }

  const createAlert = (metric: 'category' | 'confidence' | 'count') => {
    alertsApi
      .createRule({
        name: `${metric} drift (${preset.comparison_days}d vs ${preset.baseline_days}d)`,
        severity: 'warning',
        enabled: true,
        params: { type: 'drift', metric, comparison_days: preset.comparison_days, baseline_days: preset.baseline_days },
      })
      .then(() => setNotice('Alert rule created — it is evaluated with the other rules on the Alerts page.'))
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : 'Could not create the rule.'))
  }

  const savedPresets = (saved.data ?? []).map((s) => s.data)

  return (
    <div className="page">
      <PageHead
        eyebrow="Drift monitor"
        title="Model drift monitoring"
        subtitle="Compare the distribution of model inputs and outputs between two windows of real scans. Distribution shift is a signal to investigate — not proof that accuracy changed."
      />

      <section className="card">
        <div className="filters filters--inline">
          <Segmented<'preset' | 'custom'>
            label="Window selection"
            size="sm"
            value={mode}
            onChange={setMode}
            options={[{ value: 'preset', label: 'Presets' }, { value: 'custom', label: 'Custom dates' }]}
          />
          {mode === 'preset' ? (
            <label className="field field--grow">
              <span>Windows</span>
              <select
                value={preset.id}
                onChange={(e) => setPreset([...PRESETS, ...savedPresets].find((p) => p.id === e.target.value) ?? PRESETS[0])}
              >
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                {savedPresets.filter((p) => !PRESETS.some((x) => x.id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.label} (saved)</option>)}
              </select>
            </label>
          ) : (
            <>
              {(['baseline_start', 'baseline_end', 'comparison_start', 'comparison_end'] as const).map((k) => (
                <label key={k} className="field">
                  <span>{k.replace('_', ' ')}</span>
                  <input type="date" value={dateInput(custom[k])} onChange={(e) => e.target.value && setCustom({ ...custom, [k]: new Date(`${e.target.value}T00:00:00`).toISOString() })} />
                </label>
              ))}
            </>
          )}
          <button type="button" className="btn btn--primary" onClick={() => run()} disabled={busy}>
            {busy ? 'Analysing…' : 'Analyse drift'}
          </button>
          {mode === 'preset' && <button type="button" className="btn btn--ghost btn--sm" onClick={saveConfig}>Save configuration</button>}
        </div>
        {mode === 'preset' && (
          <div className="row-actions">
            <label className="field">
              <span>Custom preset: recent days</span>
              <input type="number" min={1} max={90} value={preset.comparison_days} onChange={(e) => {
                const c = Math.min(90, Math.max(1, Number(e.target.value) || 1))
                setPreset({ id: `c${c}v${preset.baseline_days}`, label: `Last ${c} days vs previous ${preset.baseline_days}`, comparison_days: c, baseline_days: preset.baseline_days })
              }} />
            </label>
            <label className="field">
              <span>baseline days</span>
              <input type="number" min={1} max={365} value={preset.baseline_days} onChange={(e) => {
                const b = Math.min(365, Math.max(1, Number(e.target.value) || 1))
                setPreset({ id: `c${preset.comparison_days}v${b}`, label: `Last ${preset.comparison_days} days vs previous ${b}`, comparison_days: preset.comparison_days, baseline_days: b })
              }} />
            </label>
          </div>
        )}
        {notice && <p className="fineprint" role="status">{notice}</p>}
      </section>

      {error && <ErrorState message={error} />}
      {busy && !result && <LoadingBlock rows={4} />}
      {!result && !busy && !error && (
        <EmptyState title="Choose two windows and analyse" icon="∿">
          Uses every stored scan in each window. Fewer than 5 successful scans (or 30 detections) in a window reports “insufficient data”, never “stable”.
        </EmptyState>
      )}
      {result && <Results r={result} onAlert={createAlert} canAlert={mode === 'preset'} />}
    </div>
  )
}

function Results({ r, onAlert, canAlert }: { r: DriftResult; onAlert: (m: 'category' | 'confidence' | 'count') => void; canAlert: boolean }) {
  const metrics = Object.values(r.metrics)
  return (
    <div className="stack">
      <div className={`callout ${r.compatibility === 'compatible' ? '' : 'callout--warn'}`} role="note">
        <strong>
          {r.compatibility === 'compatible'
            ? 'Comparable windows. '
            : r.compatibility === 'unknown'
              ? 'Compatibility unknown. '
              : 'Incompatible windows. '}
        </strong>
        {r.compatibility_note}
      </div>
      <section className="drift-windows">
        {(['baseline', 'comparison'] as const).map((k) => {
          const w = r[k]
          return (
            <div key={k} className="card drift-window">
              <span className="eyebrow">{k}</span>
              <strong>{formatDate(new Date(w.start))} – {formatDate(new Date(w.end))}</strong>
              <span className="muted">{w.scans} successful of {w.all_scans} scans · {w.detections} detections · quality for {w.quality_coverage}</span>
              <span className="muted">{Object.keys(w.configs).join(', ') || 'no model runs'}</span>
            </div>
          )
        })}
      </section>

      <section className="drift-cards">
        {metrics.map((m) => <MetricCard key={m.key} m={m} onAlert={canAlert && ['category', 'confidence', 'count'].includes(m.key) ? () => onAlert(m.key as 'category' | 'confidence' | 'count') : undefined} />)}
      </section>

      {r.metrics.category?.changes && r.metrics.category.changes.length > 0 && (
        <section className="card">
          <h2 className="card__title">Category share changes</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Category</th><th scope="col" className="num">Baseline share</th><th scope="col" className="num">Recent share</th><th scope="col" className="num">Change</th></tr></thead>
              <tbody>
                {r.metrics.category.changes.map((c) => (
                  <tr key={c.label}>
                    <th scope="row">{c.label}</th>
                    <td className="num">{(c.baseline_share * 100).toFixed(1)}%</td>
                    <td className="num">{(c.comparison_share * 100).toFixed(1)}%</td>
                    <td className="num">{((c.comparison_share - c.baseline_share) * 100).toFixed(1)} pts</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2 className="card__title">Daily trend (UTC days)</h2>
        <div className="drift-trends">
          <div>
            <h3 className="section-title">Detections per scan</h3>
            <ColumnChart label="Detections per scan by day" height={120} columns={r.trend.map((t) => ({ key: t.date, label: t.date.slice(5), value: t.detections_per_scan, description: `${t.date}: ${t.detections_per_scan} detections/scan over ${t.scans} scans` }))} emptyText="No successful scans in these windows." />
          </div>
          <div>
            <h3 className="section-title">Mean confidence (%)</h3>
            <ColumnChart label="Mean confidence by day" height={120} columns={r.trend.map((t) => ({ key: t.date, label: t.date.slice(5), value: t.mean_confidence === null ? 0 : Math.round(t.mean_confidence * 100), description: `${t.date}: ${t.mean_confidence === null ? 'no detections' : `${(t.mean_confidence * 100).toFixed(1)}%`}` }))} emptyText="No detections." />
          </div>
        </div>
      </section>

      <section className="drift-windows">
        {(['baseline', 'comparison'] as const).map((k) => (
          <div key={k} className="card">
            <h2 className="card__title">Evidence · {k}</h2>
            {r[k].evidence.length === 0 ? <p className="note">No scans.</p> : (
              <ul className="evidence-list">
                {r[k].evidence.map((e) => (
                  <li key={e.analysis_id}><a className="link" href={href('analyze', { id: e.analysis_id })}>{e.filename}</a> <span className="muted">{formatDateTime(e.created_at)}</span></li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>

      <section className="card">
        <h2 className="card__title">Method</h2>
        <ul className="bullets">
          <li>Category mix: Population Stability Index over label shares (bands {r.method.psi_bands.join(' / ')}), with Jensen–Shannon distance alongside.</li>
          <li>Confidence, detections per scan and image quality: two-sample Kolmogorov–Smirnov test; flagged when p &lt; {r.method.ks_p_threshold} and D ≥ {r.method.ks_d_bands[0]} (major ≥ {r.method.ks_d_bands[1]}).</li>
          <li>Minimum sample: {r.method.min_scans} successful scans and {r.method.min_detections} detections per window.</li>
          <li>{r.disclaimer}</li>
        </ul>
      </section>
    </div>
  )
}

function MetricCard({ m, onAlert }: { m: DriftMetric; onAlert?: () => void }) {
  return (
    <article className={`card drift-card drift-card--${m.status}`}>
      <header className="drift-card__head">
        <h3 className="card__title">{m.label}</h3>
        <Pill tone={TONE[m.status]}>{m.status}</Pill>
      </header>
      <p className="drift-card__value">
        {m.value === null ? '—' : `${m.statistic} ${m.value}`}
        {m.p_value !== undefined && m.p_value !== null && <span className="muted"> · p {m.p_value < 0.0001 ? '< 0.0001' : m.p_value.toFixed(4)}</span>}
        {m.js_distance !== undefined && <span className="muted"> · JS {m.js_distance}</span>}
      </p>
      <p className="drift-card__summary">{m.summary}</p>
      <p className="fineprint">n = {m.baseline_n} baseline · {m.comparison_n} recent</p>
      {onAlert && <button type="button" className="btn btn--ghost btn--sm" onClick={onAlert}>Alert on this</button>}
    </article>
  )
}

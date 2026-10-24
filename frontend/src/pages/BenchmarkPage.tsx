import { useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { benchmarksApi, jobsApi, modelsApi, type BenchConfigResult, type BenchmarkRun } from '../api/workbench'
import { BarList } from '../components/charts/Charts'
import { JobPanel } from '../components/ui/JobPanel'
import { ConfirmDialog, LocalOnly, PageHead, Pill } from '../components/ui/Page'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/States'
import { useScanData } from '../data/useScanData'
import { useAsync } from '../hooks/useAsync'
import { useWorkbenchAvailable } from '../hooks/useWorkbench'
import { formatDateTime, pluralize } from '../lib/format'
import { href, navigate } from '../lib/router'

const SIZES = [320, 416, 512, 640, 768]

interface ConfigDraft {
  model_id: string
  confidence: number
  image_size: number
}

const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toLocaleString(undefined, { maximumFractionDigits: 0 })} ms`)

export function BenchmarkPage({ runId }: { runId?: string }) {
  const available = useWorkbenchAvailable()
  if (!available) {
    return (
      <div className="page">
        <PageHead eyebrow="Benchmark Lab" title="Model benchmark lab" />
        <LocalOnly feature="Benchmarking" />
      </div>
    )
  }
  return runId ? <RunView key={runId} id={runId} /> : <Lab />
}

function Lab() {
  const data = useScanData()
  const models = useAsync(() => modelsApi.list(), [])
  const runs = useAsync(() => benchmarksApi.list(), [])
  const status = useAsync(() => jobsApi.status(), [])
  const [configs, setConfigs] = useState<ConfigDraft[]>([])
  const [images, setImages] = useState<string[]>([])
  const [repeats, setRepeats] = useState(3)
  const [name, setName] = useState('Benchmark')
  const [confirming, setConfirming] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const candidates = data.summaries.filter((s) => s.status === 'completed').slice(0, 60)
  const modelList = models.data ?? []
  const defaultModel = modelList.find((m) => m.production)?.model_id ?? modelList[0]?.model_id
  const effectiveConfigs = configs.length ? configs : defaultModel ? [{ model_id: defaultModel, confidence: 0.25, image_size: 640 }] : []
  const runsTotal = effectiveConfigs.length * images.length * repeats
  const distinctModels = new Set(effectiveConfigs.map((c) => c.model_id)).size

  const start = () => {
    setError(null)
    benchmarksApi
      .start({ name, configs: effectiveConfigs, analysis_ids: images, repeats, confirm: true })
      .then((job) => {
        setConfirming(false)
        setJobId(job.job_id)
      })
      .catch((e: unknown) => {
        setConfirming(false)
        setError(e instanceof ApiError ? e.message : 'Could not start the benchmark.')
      })
  }

  const update = (i: number, patch: Partial<ConfigDraft>) => {
    const base = configs.length ? configs : effectiveConfigs
    setConfigs(base.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="Benchmark Lab"
        title="Model benchmark lab"
        subtitle="Measure real inference latency and outputs of local model configurations on your own scans. Every number is a wall-clock measurement on this machine."
      />
      {status.data?.active_job && !jobId && (
        <p className="callout callout--warn">A {status.data.active_job.kind} job is running. Benchmarks wait their turn — heavy jobs run one at a time.</p>
      )}

      <div className="bench-grid">
        <section className="card" aria-labelledby="bench-configs">
          <header className="card__header">
            <div>
              <h2 className="card__title" id="bench-configs">Configurations</h2>
              <p className="card__subtitle">
                {modelList.length} local model{modelList.length === 1 ? '' : 's'} available. Nothing is downloaded.
              </p>
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={effectiveConfigs.length >= 4 || !defaultModel}
              onClick={() => setConfigs([...effectiveConfigs, { model_id: defaultModel!, confidence: 0.5, image_size: 640 }])}
            >
              Add configuration
            </button>
          </header>
          {models.error && <ErrorState message={models.error} onRetry={models.reload} />}
          <ol className="config-list">
            {effectiveConfigs.map((c, i) => (
              <li key={i} className="config-row">
                <span className="config-row__n">{String.fromCharCode(65 + i)}</span>
                <label className="field field--grow">
                  <span>Model</span>
                  <select value={c.model_id} onChange={(e) => update(i, { model_id: e.target.value })}>
                    {modelList.map((m) => (
                      <option key={m.model_id} value={m.model_id}>
                        {m.name} {m.source === 'trained' ? '(trained)' : m.production ? '(production)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Confidence</span>
                  <input type="number" min={0.01} max={0.95} step={0.05} value={c.confidence} onChange={(e) => update(i, { confidence: Number(e.target.value) || 0.25 })} />
                </label>
                <label className="field">
                  <span>Input size</span>
                  <select value={c.image_size} onChange={(e) => update(i, { image_size: Number(e.target.value) })}>
                    {SIZES.map((s) => <option key={s} value={s}>{s}px</option>)}
                  </select>
                </label>
                {effectiveConfigs.length > 1 && (
                  <button type="button" className="btn btn--ghost btn--sm" aria-label={`Remove configuration ${String.fromCharCode(65 + i)}`} onClick={() => setConfigs(effectiveConfigs.filter((_, j) => j !== i))}>✕</button>
                )}
              </li>
            ))}
          </ol>
          {distinctModels === 1 && effectiveConfigs.length > 1 && (
            <p className="fineprint">Only one weights file is selected, so this will be a <strong>configuration comparison</strong>, not a model comparison.</p>
          )}
        </section>

        <section className="card" aria-labelledby="bench-images">
          <header className="card__header">
            <div>
              <h2 className="card__title" id="bench-images">Images</h2>
              <p className="card__subtitle">Pick 1–10 stored scans. {images.length} selected.</p>
            </div>
          </header>
          {candidates.length === 0 ? (
            <p className="note">Analyze a photo first — benchmarks run on stored scans.</p>
          ) : (
            <ul className="pick-list pick-list--short">
              {candidates.map((s) => (
                <li key={s.analysis_id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={images.includes(s.analysis_id)}
                      disabled={!images.includes(s.analysis_id) && images.length >= 10}
                      onChange={(e) => setImages(e.target.checked ? [...images, s.analysis_id] : images.filter((x) => x !== s.analysis_id))}
                    />
                    <span>{s.filename}</span>
                    <span className="muted">{pluralize(s.detection_count, 'detection')}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="form-grid">
            <label className="field"><span>Repeats per image</span><input type="number" min={1} max={5} value={repeats} onChange={(e) => setRepeats(Math.min(5, Math.max(1, Number(e.target.value) || 1)))} /></label>
            <label className="field field--grow"><span>Run name</span><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
          </div>
          <button type="button" className="btn btn--primary" disabled={!images.length || !effectiveConfigs.length || !!jobId} onClick={() => setConfirming(true)}>
            Run benchmark ({pluralize(runsTotal, 'inference')})
          </button>
          {error && <p className="callout callout--error" role="alert">{error}</p>}
        </section>
      </div>

      {jobId && (
        <section className="card">
          <h2 className="card__title">Running</h2>
          <JobPanel
            jobId={jobId}
            cancelNote="Stops after the inference in progress — a running CPU inference cannot be interrupted."
            onDone={(job) => {
              runs.reload()
              setJobId(null)
              if (job.status === 'completed' || job.status === 'cancelled') navigate(href('benchmark', { id: job.job_id }))
            }}
          />
        </section>
      )}

      <section className="card" aria-labelledby="bench-runs">
        <h2 className="card__title" id="bench-runs">Saved runs</h2>
        {runs.error ? (
          <ErrorState message={runs.error} onRetry={runs.reload} />
        ) : !runs.data ? (
          <LoadingBlock rows={3} />
        ) : runs.data.length === 0 ? (
          <EmptyState title="No benchmark runs" compact>Results are saved with full provenance when a run finishes.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Run</th><th scope="col">Type</th><th scope="col" className="num">Configs</th><th scope="col" className="num">Images</th><th scope="col" className="num">Repeats</th><th scope="col">When</th></tr></thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.run_id}>
                    <th scope="row"><a className="link" href={href('benchmark', { id: r.run_id })}>{r.name}</a>{!r.complete && <Pill tone="warn">partial</Pill>}</th>
                    <td>{r.comparison_type} comparison</td>
                    <td className="num">{r.configs}</td>
                    <td className="num">{r.images}</td>
                    <td className="num">{r.repeats}</td>
                    <td>{formatDateTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog open={confirming} title="Run this benchmark?" confirmLabel="Start benchmark" onCancel={() => setConfirming(false)} onConfirm={start}>
        <p>
          This runs <strong>{pluralize(runsTotal, 'real CPU inference')}</strong> ({effectiveConfigs.length} configuration{effectiveConfigs.length === 1 ? '' : 's'} ×{' '}
          {pluralize(images.length, 'image')} × {repeats} repeats). Expect roughly 1–3 s per inference on CPU, plus a model load if a non-production model is chosen.
        </p>
        <p className="fineprint">Live scans share the same inference lock, so they will wait between benchmark images.</p>
      </ConfirmDialog>
    </div>
  )
}

function RunView({ id }: { id: string }) {
  const run = useAsync(() => benchmarksApi.get(id), [id])
  if (run.error) return <div className="page"><ErrorState message={run.error} onRetry={() => navigate(href('benchmark'))} /></div>
  if (!run.data) return <div className="page"><LoadingBlock rows={6} /></div>
  return <RunResults run={run.data} />
}

function RunResults({ run }: { run: BenchmarkRun }) {
  const fastest = Math.min(...run.configs.map((c) => c.warm.median ?? c.first_ms ?? Infinity))
  const allLabels = useMemo(() => [...new Set(run.configs.flatMap((c) => Object.keys(c.categories)))], [run])
  return (
    <div className="page">
      <PageHead
        eyebrow="Benchmark run"
        title={run.name}
        badge={<Pill tone="accent">{run.comparison_type} comparison</Pill>}
        subtitle={`${formatDateTime(run.created_at)} · ${pluralize(run.images.length, 'image')} × ${run.repeats} repeats · ${run.comparison_note}`}
        actions={<a className="btn btn--ghost" href={href('benchmark')}>Benchmark Lab</a>}
      />
      {!run.complete && <p className="callout callout--warn">This run was cancelled; figures cover only the inferences that finished.</p>}

      <section className="bench-cards">
        {run.configs.map((c, i) => <ConfigCard key={i} c={c} label={String.fromCharCode(65 + i)} fastest={fastest} />)}
      </section>

      <section className="card">
        <h2 className="card__title">Latency (warm median)</h2>
        <BarList
          label="Warm median latency per configuration"
          items={run.configs.map((c, i) => ({
            key: String(i),
            label: `${String.fromCharCode(65 + i)} · ${c.image_size}px @ ${c.confidence}`,
            value: Math.round(c.warm.median ?? c.first_ms ?? 0),
            detail: c.warm.stdev !== null ? `± ${Math.round(c.warm.stdev)} ms` : 'single run',
          }))}
          formatValue={(v) => `${v} ms`}
        />
        <p className="fineprint">Warm statistics exclude each configuration’s first inference. Lower latency says nothing about accuracy.</p>
      </section>

      <section className="card">
        <h2 className="card__title">Outputs side by side</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Image</th>
                {run.configs.map((_, i) => <th key={i} scope="col" className="num">{String.fromCharCode(65 + i)} detections</th>)}
              </tr>
            </thead>
            <tbody>
              {run.images.map((img) => (
                <tr key={img.analysis_id}>
                  <th scope="row"><a className="link" href={href('analyze', { id: img.analysis_id })}>{img.filename}</a></th>
                  {run.configs.map((c, i) => <td key={i} className="num">{c.per_image.find((p) => p.analysis_id === img.analysis_id)?.detections ?? '—'}</td>)}
                </tr>
              ))}
              {allLabels.map((label) => (
                <tr key={label} className="table__sub">
                  <th scope="row">· {label}</th>
                  {run.configs.map((c, i) => <td key={i} className="num">{c.categories[label] ?? 0}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Provenance</h2>
        <dl className="kv">
          {Object.entries(run.runtime).map(([k, v]) => <div key={k} className="kv__row"><dt>{k}</dt><dd>{String(v ?? '—')}</dd></div>)}
        </dl>
        <ul className="bullets bullets--muted">{run.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
      </section>
    </div>
  )
}

function ConfigCard({ c, label, fastest }: { c: BenchConfigResult; label: string; fastest: number }) {
  const median = c.warm.median ?? c.first_ms
  return (
    <article className="card bench-card">
      <header className="bench-card__head">
        <span className="config-row__n">{label}</span>
        <div>
          <h3 className="card__title">{c.model_id.replace(/^pretrained:|^trained:/, '')}</h3>
          <p className="card__subtitle">{c.image_size}px · confidence ≥ {c.confidence} · {c.taxonomy_size} classes</p>
        </div>
        {median === fastest && Number.isFinite(fastest) && <Pill tone="ok">fastest</Pill>}
      </header>
      <dl className="bench-card__stats">
        <div><dt>Warm median</dt><dd>{ms(c.warm.median)}</dd></div>
        <div><dt>Warm range</dt><dd>{c.warm.min !== null ? `${ms(c.warm.min)}–${ms(c.warm.max)}` : '—'}</dd></div>
        <div><dt>Std dev</dt><dd>{ms(c.warm.stdev)}</dd></div>
        <div><dt>First inference</dt><dd>{ms(c.first_ms)}</dd></div>
        <div><dt>Model load</dt><dd>{c.load_ms === null ? 'already loaded' : ms(c.load_ms)}</dd></div>
        <div><dt>Runs</dt><dd>{c.all.n}</dd></div>
        <div><dt>Detections</dt><dd>{c.detections_total}</dd></div>
        <div><dt>Mean confidence</dt><dd>{c.confidence_stats.mean !== null ? `${(c.confidence_stats.mean * 100).toFixed(1)}%` : '—'}</dd></div>
        <div><dt>Below 50%</dt><dd>{c.confidence_stats.below_50}</dd></div>
      </dl>
    </article>
  )
}

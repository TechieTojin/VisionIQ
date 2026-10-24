import { useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { datasetsApi, evaluationsApi, modelsApi, type EvalBody, type EvaluationRun, type EvalExample } from '../api/workbench'
import { JobPanel } from '../components/ui/JobPanel'
import { ConfirmDialog, LocalOnly, PageHead, Pill } from '../components/ui/Page'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/States'
import { useAsync } from '../hooks/useAsync'
import { useImageUrl } from '../hooks/useImageUrl'
import { useWorkbenchAvailable } from '../hooks/useWorkbench'
import { formatDateTime, pluralize } from '../lib/format'
import { href, navigate } from '../lib/router'

const m = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? 'undefined' : `${(v * 100).toFixed(d)}%`)

export function EvaluationPage({ runId, params }: { runId?: string; params: URLSearchParams }) {
  const available = useWorkbenchAvailable()
  if (!available) {
    return (
      <div className="page">
        <PageHead eyebrow="Evaluation" title="Model evaluation center" />
        <LocalOnly feature="Model evaluation" />
      </div>
    )
  }
  return runId ? <RunView key={runId} id={runId} compareTo={params.get('vs')} /> : <Center />
}

function Center() {
  const versions = useAsync(() => datasetsApi.versions(), [])
  const models = useAsync(() => modelsApi.list(), [])
  const runs = useAsync(() => evaluationsApi.list(), [])
  const [versionId, setVersionId] = useState('')
  const [split, setSplit] = useState('test')
  const [modelId, setModelId] = useState('')
  const [conf, setConf] = useState(0.25)
  const [pre, setPre] = useState<Awaited<ReturnType<typeof evaluationsApi.preflight>> | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [compare, setCompare] = useState<string[]>([])

  const evalReady = (versions.data ?? []).filter((v) => v.readiness.evaluation_ready)
  const version = evalReady.find((v) => v.version_id === versionId) ?? evalReady[0]
  const model = modelId || models.data?.find((x) => x.production)?.model_id || models.data?.[0]?.model_id || ''
  const body: EvalBody | null = version && model ? { dataset_id: version.dataset_id, version: version.version, split, model_id: model, operating_confidence: conf, image_size: 640 } : null

  const check = () => {
    if (!body) return
    setError(null)
    evaluationsApi.preflight(body).then(setPre).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Preflight failed.'))
  }
  const start = () => {
    if (!body) return
    evaluationsApi
      .start(body)
      .then((j) => { setConfirming(false); setJobId(j.job_id) })
      .catch((e: unknown) => { setConfirming(false); setError(e instanceof ApiError ? e.message : 'Could not start.') })
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="Evaluation"
        title="Model evaluation center"
        subtitle="Precision, recall, F1 and mAP against human-reviewed ground truth from a frozen dataset version. Detection confidence is not accuracy — these metrics are."
      />

      {versions.error ? (
        <ErrorState message={versions.error} onRetry={versions.reload} />
      ) : !versions.data ? (
        <LoadingBlock rows={3} />
      ) : evalReady.length === 0 ? (
        <section className="card">
          <EmptyState
            title="Evaluation needs labelled ground truth"
            icon="⚖"
            action={<a className="btn btn--primary" href={href('datasets')}>Open datasets</a>}
          >
            No dataset version contains reviewed annotations yet. Review images in the Annotation Studio, add them to a dataset and
            freeze a version. Evaluation stays disabled until then — predictions are never scored against themselves.
          </EmptyState>
        </section>
      ) : (
        <section className="card">
          <h2 className="card__title">New evaluation</h2>
          <div className="form-grid">
            <label className="field field--grow">
              <span>Dataset version (ground truth)</span>
              <select value={version?.version_id} onChange={(e) => { setVersionId(e.target.value); setPre(null) }}>
                {evalReady.map((v) => <option key={v.version_id} value={v.version_id}>{v.dataset_name} v{v.version} — {v.stats.labeled_images} labelled images</option>)}
              </select>
            </label>
            <label className="field">
              <span>Split</span>
              <select value={split} onChange={(e) => { setSplit(e.target.value); setPre(null) }}>
                {(['test', 'val', 'train', 'all'] as const).map((s) => <option key={s} value={s}>{s} {s !== 'all' && version ? `(${version.stats.splits[s].images})` : ''}</option>)}
              </select>
            </label>
            <label className="field field--grow">
              <span>Model</span>
              <select value={model} onChange={(e) => { setModelId(e.target.value); setPre(null) }}>
                {(models.data ?? []).map((x) => <option key={x.model_id} value={x.model_id}>{x.name}{x.source === 'trained' ? ' (trained)' : ''}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Operating confidence</span>
              <input type="number" min={0.01} max={0.95} step={0.05} value={conf} onChange={(e) => { setConf(Number(e.target.value) || 0.25); setPre(null) }} />
            </label>
          </div>
          {split === 'train' && <p className="text-warn">Evaluating on the training split measures fit, not generalisation.</p>}
          <div className="row-actions">
            <button type="button" className="btn btn--ghost" onClick={check} disabled={!body}>Check readiness</button>
            <button type="button" className="btn btn--primary" disabled={!pre?.ok || !!jobId} onClick={() => setConfirming(true)}>Run evaluation</button>
          </div>
          {pre && (
            <div className={`callout ${pre.ok ? '' : 'callout--error'}`} role="status">
              {pre.ok ? (
                <>
                  Ready: {pluralize(pre.images, 'image')}, {pre.bias.gt_boxes} ground-truth boxes, classes {pre.classes.join(', ')}.
                  {pre.bias.biased && (
                    <strong className="text-warn">
                      {' '}{Math.round(pre.bias.unedited_share * 100)}% of the labels are unedited predictions of {pre.model_file}; scores will be biased upwards.
                    </strong>
                  )}
                </>
              ) : (
                <>Blocked: {pre.reasons.join(' ')}</>
              )}
            </div>
          )}
          {error && <p className="callout callout--error" role="alert">{error}</p>}
        </section>
      )}

      {jobId && (
        <section className="card">
          <h2 className="card__title">Evaluating</h2>
          <JobPanel
            jobId={jobId}
            cancelNote="Stops after the image in progress."
            onDone={(job) => {
              runs.reload()
              setJobId(null)
              if (job.status === 'completed') navigate(href('evaluation', { id: job.job_id }))
            }}
          />
        </section>
      )}

      <section className="card">
        <header className="card__header">
          <h2 className="card__title">Saved evaluations</h2>
          {compare.length === 2 && (
            <a className="btn btn--ghost btn--sm" href={href('evaluation', { id: compare[0], params: { vs: compare[1] } })}>Compare selected</a>
          )}
        </header>
        {!runs.data ? (
          <LoadingBlock rows={2} />
        ) : runs.data.length === 0 ? (
          <p className="note">No evaluations yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col"><span className="sr-only">Compare</span></th><th scope="col">Model</th><th scope="col">Ground truth</th><th scope="col" className="num">Images</th><th scope="col" className="num">mAP@0.5</th><th scope="col" className="num">mAP@.5:.95</th><th scope="col" className="num">F1</th><th scope="col">When</th></tr></thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.run_id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.model_id} on ${r.dataset_name} for comparison`}
                        checked={compare.includes(r.run_id)}
                        onChange={(e) => setCompare(e.target.checked ? [...compare, r.run_id].slice(-2) : compare.filter((x) => x !== r.run_id))}
                      />
                    </td>
                    <th scope="row"><a className="link" href={href('evaluation', { id: r.run_id })}>{r.model_id.replace(/^\w+:/, '')}</a>{r.biased && <Pill tone="warn">biased labels</Pill>}</th>
                    <td>{r.dataset_name} v{r.version} · {r.split}</td>
                    <td className="num">{r.images}</td>
                    <td className="num">{m(r.map50)}</td>
                    <td className="num">{m(r.map50_95)}</td>
                    <td className="num">{m(r.f1)}</td>
                    <td>{formatDateTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmDialog open={confirming} title="Run evaluation?" confirmLabel="Start evaluation" onCancel={() => setConfirming(false)} onConfirm={start}>
        Runs one inference per image ({pre ? pluralize(pre.images, 'image') : ''}) at a very low confidence (0.001) so the full precision–recall curve is available, then scores against the reviewed labels.
      </ConfirmDialog>
    </div>
  )
}

function RunView({ id, compareTo }: { id: string; compareTo: string | null }) {
  const run = useAsync(() => evaluationsApi.get(id), [id])
  const other = useAsync(() => (compareTo ? evaluationsApi.get(compareTo) : Promise.resolve(null)), [compareTo])
  if (run.error) return <div className="page"><ErrorState message={run.error} onRetry={() => navigate(href('evaluation'))} /></div>
  if (!run.data) return <div className="page"><LoadingBlock rows={6} /></div>
  return <RunResults run={run.data} other={other.data ?? null} />
}

function RunResults({ run, other }: { run: EvaluationRun; other: EvaluationRun | null }) {
  const r = run.metrics
  const [example, setExample] = useState(0)
  const worst = useMemo(() => [...r.examples].sort((a, b) => b.fp.length + b.fn.length - (a.fp.length + a.fn.length)), [r.examples])
  const ex = worst[example]
  const labels = r.confusion.labels

  return (
    <div className="page">
      <PageHead
        eyebrow="Evaluation run"
        title={`${run.model_file} on ${run.dataset_name} v${run.version}`}
        subtitle={`${formatDateTime(run.created_at)} · ${run.split} split · ${pluralize(r.images, 'image')} · ${r.gt_instances} ground-truth boxes`}
        badge={run.bias.biased ? <Pill tone="warn">biased labels</Pill> : undefined}
        actions={<a className="btn btn--ghost" href={href('evaluation')}>Evaluation center</a>}
      />
      {run.bias.biased && (
        <p className="callout callout--warn">
          {Math.round(run.bias.unedited_share * 100)}% of ground-truth boxes are this model’s own predictions accepted without edits. Scores are biased upwards — review and correct more boxes for a fair measure.
        </p>
      )}
      {!run.complete && <p className="callout callout--warn">Cancelled — metrics cover only the images processed.</p>}

      <section className="kpi-grid" aria-label="Headline metrics">
        <Metric label="mAP@0.5" v={r.map50} other={other?.metrics.map50} />
        <Metric label="mAP@0.5:0.95" v={r.map50_95} other={other?.metrics.map50_95} />
        <Metric label={`Precision @ ${r.operating_confidence}`} v={r.micro.precision} other={other?.metrics.micro.precision} />
        <Metric label={`Recall @ ${r.operating_confidence}`} v={r.micro.recall} other={other?.metrics.micro.recall} />
        <Metric label="F1 (micro)" v={r.micro.f1} other={other?.metrics.micro.f1} />
        <div className="kpi"><span className="kpi__label">TP / FP / FN</span><span className="kpi__value">{r.micro.tp} / {r.micro.fp} / {r.micro.fn}</span></div>
      </section>
      {other && <p className="fineprint">Δ compares with {other.model_file} on {other.dataset_name} v{other.version} ({other.split}). Only meaningful when both use the same ground truth.</p>}

      <section className="card">
        <h2 className="card__title">Per-class metrics</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Class</th><th scope="col" className="num">GT</th><th scope="col" className="num">TP</th><th scope="col" className="num">FP</th><th scope="col" className="num">FN</th><th scope="col" className="num">Precision</th><th scope="col" className="num">Recall</th><th scope="col" className="num">F1</th><th scope="col" className="num">AP@0.5</th><th scope="col" className="num">AP@.5:.95</th></tr></thead>
            <tbody>
              {r.per_class.map((c) => (
                <tr key={c.class_id}>
                  <th scope="row">{c.label}</th>
                  <td className="num">{c.gt_instances}</td><td className="num">{c.tp}</td><td className="num">{c.fp}</td><td className="num">{c.fn}</td>
                  <td className="num">{m(c.precision)}</td><td className="num">{m(c.recall)}</td><td className="num">{m(c.f1)}</td>
                  <td className="num">{m(c.ap50)}</td><td className="num">{m(c.ap50_95)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fineprint">“undefined” means the ratio has no denominator (e.g. a class with no ground truth has no recall or AP) — it is not zero. Macro F1 {m(r.macro.f1)} averages defined classes only.</p>
      </section>

      <div className="eval-grid">
        <section className="card">
          <h2 className="card__title">Confusion matrix</h2>
          <p className="card__subtitle">Rows: ground truth. Columns: prediction. IoU ≥ 0.5, confidence ≥ {r.operating_confidence}.</p>
          <div className="table-wrap">
            <table className="table confusion">
              <thead><tr><th scope="col">GT \ Pred</th>{labels.map((l) => <th key={l} scope="col" className="num">{l}</th>)}</tr></thead>
              <tbody>
                {r.confusion.matrix.map((row, i) => {
                  const max = Math.max(1, ...r.confusion.matrix.flat())
                  return (
                    <tr key={labels[i]}>
                      <th scope="row">{labels[i]}</th>
                      {row.map((v, j) => (
                        <td key={j} className={`num confusion__cell${i === j && i < labels.length - 1 ? ' is-diag' : ''}`} style={{ '--heat': v / max } as React.CSSProperties}>
                          {v}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <h2 className="card__title">Mistakes to review</h2>
          {!ex ? (
            <p className="note">No images.</p>
          ) : (
            <>
              <div className="row-actions">
                <button type="button" className="btn btn--ghost btn--sm" disabled={example === 0} onClick={() => setExample(example - 1)}>← Prev</button>
                <span className="muted">{example + 1} / {worst.length} · worst first</span>
                <button type="button" className="btn btn--ghost btn--sm" disabled={example >= worst.length - 1} onClick={() => setExample(example + 1)}>Next →</button>
              </div>
              <ExampleView ex={ex} labels={labels} />
            </>
          )}
        </section>
      </div>

      <section className="card">
        <h2 className="card__title">Method and provenance</h2>
        <dl className="kv">
          <div className="kv__row"><dt>Matching</dt><dd>{run.iou_policy}</dd></div>
          <div className="kv__row"><dt>Inference confidence</dt><dd>{run.inference_confidence} (for AP curves)</dd></div>
          <div className="kv__row"><dt>Input size</dt><dd>{run.image_size}px</dd></div>
          <div className="kv__row"><dt>Predictions outside dataset classes</dt><dd>{run.out_of_taxonomy_predictions} (not scored)</dd></div>
          <div className="kv__row"><dt>Mean inference</dt><dd>{run.mean_inference_ms ?? '—'} ms</dd></div>
          <div className="kv__row"><dt>Ground-truth edits by humans</dt><dd>{run.bias.human_changes}</dd></div>
        </dl>
        <ul className="bullets bullets--muted">{run.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>
    </div>
  )
}

function Metric({ label, v, other }: { label: string; v: number | null; other?: number | null }) {
  const delta = other !== undefined && other !== null && v !== null ? v - other : null
  return (
    <div className="kpi kpi--accent">
      <span className="kpi__label">{label}</span>
      <span className="kpi__value">{v === null ? 'undefined' : `${(v * 100).toFixed(1)}%`}</span>
      {delta !== null && <span className={`kpi__hint delta delta--${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`}>{delta >= 0 ? '+' : ''}{(delta * 100).toFixed(1)} pts</span>}
    </div>
  )
}

function ExampleView({ ex, labels }: { ex: EvalExample; labels: string[] }) {
  const w = ex.width
  const h = ex.height
  const sw = Math.max(1.5, Math.max(w, h) / 300)
  const url = useImageUrl(`/api/analyses/${encodeURIComponent(ex.image_id)}/image`)
  return (
    <figure className="eval-example">
      <svg viewBox={`0 0 ${w} ${h}`} className="eval-example__svg" role="img" aria-label={`${ex.filename}: ${ex.tp.length} true positives, ${ex.fp.length} false positives, ${ex.fn.length} missed`}>
        <rect x={0} y={0} width={w} height={h} className="eval-example__bg" />
        {url && <image href={url} x={0} y={0} width={w} height={h} preserveAspectRatio="none" />}
        {ex.fn.map((f, i) => <rect key={`fn${i}`} className="eval-box eval-box--fn" x={f.gt.x1} y={f.gt.y1} width={f.gt.x2 - f.gt.x1} height={f.gt.y2 - f.gt.y1} strokeWidth={sw} />)}
        {ex.fp.map((f, i) => <rect key={`fp${i}`} className="eval-box eval-box--fp" x={f.pred.x1} y={f.pred.y1} width={f.pred.x2 - f.pred.x1} height={f.pred.y2 - f.pred.y1} strokeWidth={sw} />)}
        {ex.tp.map((t, i) => <rect key={`tp${i}`} className="eval-box eval-box--tp" x={t.pred.x1} y={t.pred.y1} width={t.pred.x2 - t.pred.x1} height={t.pred.y2 - t.pred.y1} strokeWidth={sw} />)}
      </svg>
      <figcaption>
        <a className="link" href={href('annotate', { id: ex.image_id })}>{ex.filename}</a> · <span className="legend__item legend__item--tp">{ex.tp.length} correct</span>{' '}
        <span className="legend__item legend__item--fp">{ex.fp.length} false positives</span> <span className="legend__item legend__item--fn">{ex.fn.length} missed</span>
        {ex.fp.length > 0 && <span className="muted"> · FP classes: {[...new Set(ex.fp.map((f) => labels[f.class_id]))].join(', ')}</span>}
      </figcaption>
    </figure>
  )
}

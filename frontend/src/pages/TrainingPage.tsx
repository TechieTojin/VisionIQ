import { useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { datasetsApi, modelsApi, trainingApi, type TrainingPlan, type TrainingRun, type TrainParams } from '../api/workbench'
import { AnnotatedImage } from '../components/AnnotatedImage'
import { ColumnChart } from '../components/charts/Charts'
import { JobPanel } from '../components/ui/JobPanel'
import { ConfirmDialog, LocalOnly, PageHead, Pill } from '../components/ui/Page'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/States'
import { useScanData } from '../data/useScanData'
import { useScanImage } from '../data/useScanImage'
import { useAsync } from '../hooks/useAsync'
import { useWorkbenchAvailable } from '../hooks/useWorkbench'
import { formatDateTime, pluralize } from '../lib/format'
import { downloadBytes } from '../lib/pdf/export'
import { href, navigate } from '../lib/router'
import type { Detection } from '../types'
import { buildColorMap } from '../utils/colors'

const SIZES = [320, 416, 512, 640]
const STATUS_TONE = { running: 'accent', cancelling: 'warn', completed: 'ok', failed: 'error', cancelled: 'neutral', interrupted: 'warn' } as const

function duration(s: number): string {
  if (s < 90) return `${s} s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(1)} h`
}

export function TrainingPage({ runId }: { runId?: string }) {
  const available = useWorkbenchAvailable()
  if (!available) {
    return (
      <div className="page">
        <PageHead eyebrow="Training" title="Retail model training" />
        <LocalOnly feature="Model training" />
      </div>
    )
  }
  return runId ? <RunView key={runId} id={runId} /> : <Experiments />
}

function Experiments() {
  const versions = useAsync(() => datasetsApi.versions(), [])
  const models = useAsync(() => modelsApi.list(), [])
  const runs = useAsync(() => trainingApi.list(), [])
  const ready = (versions.data ?? []).filter((v) => v.readiness.training_ready)
  const pretrained = (models.data ?? []).filter((m) => m.source === 'pretrained')
  const [versionId, setVersionId] = useState('')
  const [form, setForm] = useState({ epochs: 10, image_size: 320, batch: 4, patience: 20, seed: 0, name: 'Retail experiment', base: '' })
  const [plan, setPlan] = useState<TrainingPlan | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [ack, setAck] = useState({ resources: false, dataset: false })
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const version = ready.find((v) => v.version_id === versionId) ?? ready[0]
  const base = form.base || pretrained.find((m) => m.production)?.model_id || pretrained[0]?.model_id || ''
  const params: TrainParams | null = version && base
    ? { dataset_id: version.dataset_id, version: version.version, base_model_id: base, epochs: form.epochs, image_size: form.image_size, batch: form.batch, patience: form.patience, seed: form.seed, name: form.name }
    : null
  const completed = (runs.data ?? []).filter((r) => r.status === 'completed')

  const doPlan = () => {
    if (!params) return
    setError(null)
    trainingApi.plan(params).then(setPlan).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Planning failed.'))
  }
  const start = () => {
    if (!params) return
    trainingApi
      .start(params)
      .then((j) => { setConfirming(false); setJobId(j.job_id) })
      .catch((e: unknown) => { setConfirming(false); setError(e instanceof ApiError ? e.message : 'Could not start training.') })
  }
  const edit = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch })
    setPlan(null)
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="Training"
        title="Retail model training"
        subtitle="Fine-tune a local pretrained detector on your own human-reviewed dataset. Training runs only when you confirm it, in a separate low-priority process."
        badge={<Pill tone={completed.length ? 'ok' : 'neutral'}>{completed.length ? `${pluralize(completed.length, 'completed run')}` : 'No retail model trained yet'}</Pill>}
      />

      {versions.error ? (
        <ErrorState message={versions.error} onRetry={versions.reload} />
      ) : !versions.data ? (
        <LoadingBlock rows={3} />
      ) : ready.length === 0 ? (
        <section className="card">
          <EmptyState title="Dataset required · Training not started" icon="◌" action={<a className="btn btn--primary" href={href('datasets')}>Prepare a dataset</a>}>
            Training needs a frozen dataset version with human-reviewed labels in both the train and validation splits. None exists yet,
            so nothing has been trained — the detector in use is still the generic pretrained {pretrained.find((m) => m.production)?.name ?? 'model'}, not a retail model.
          </EmptyState>
        </section>
      ) : (
        <section className="card">
          <h2 className="card__title">New experiment</h2>
          <div className="form-grid">
            <label className="field field--grow">
              <span>Dataset version</span>
              <select value={version?.version_id} onChange={(e) => { setVersionId(e.target.value); setPlan(null) }}>
                {ready.map((v) => <option key={v.version_id} value={v.version_id}>{v.dataset_name} v{v.version} — {v.stats.splits.train.images} train / {v.stats.splits.val.images} val, {v.classes.length} classes</option>)}
              </select>
            </label>
            <label className="field field--grow">
              <span>Base model (local weights)</span>
              <select value={base} onChange={(e) => edit({ base: e.target.value })}>
                {pretrained.map((m) => <option key={m.model_id} value={m.model_id}>{m.name} · {m.size_mb} MB</option>)}
              </select>
            </label>
            <label className="field field--grow"><span>Experiment name</span><input value={form.name} maxLength={80} onChange={(e) => edit({ name: e.target.value })} /></label>
          </div>
          <div className="form-grid">
            <label className="field"><span>Epochs</span><input type="number" min={1} max={100} value={form.epochs} onChange={(e) => edit({ epochs: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })} /></label>
            <label className="field"><span>Image size</span><select value={form.image_size} onChange={(e) => edit({ image_size: Number(e.target.value) })}>{SIZES.map((s) => <option key={s} value={s}>{s}px</option>)}</select></label>
            <label className="field"><span>Batch</span><input type="number" min={1} max={16} value={form.batch} onChange={(e) => edit({ batch: Math.min(16, Math.max(1, Number(e.target.value) || 1)) })} /></label>
            <label className="field"><span>Early-stop patience</span><input type="number" min={1} max={100} value={form.patience} onChange={(e) => edit({ patience: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })} /></label>
            <label className="field"><span>Seed</span><input type="number" min={0} value={form.seed} onChange={(e) => edit({ seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></label>
          </div>
          <p className="fineprint">CPU-friendly defaults: small images, small batch, workers 0. Nothing is downloaded — the base weights and dataset are local files.</p>
          <div className="row-actions">
            <button type="button" className="btn btn--ghost" onClick={doPlan} disabled={!params}>Check dataset &amp; estimate</button>
            <button type="button" className="btn btn--primary" disabled={!plan?.ready || !!jobId || !!plan?.active_job} onClick={() => { setAck({ resources: false, dataset: false }); setConfirming(true) }}>
              Start training…
            </button>
          </div>
          {plan && <PlanView plan={plan} />}
          {error && <p className="callout callout--error" role="alert">{error}</p>}
        </section>
      )}

      {jobId && (
        <section className="card">
          <h2 className="card__title">Training in progress</h2>
          <JobPanel
            jobId={jobId}
            cancelNote="Cancelling terminates the training process immediately; partial checkpoints are kept but the run is marked cancelled."
            onDone={(job) => { runs.reload(); setJobId(null); navigate(href('training', { id: job.job_id })) }}
          />
        </section>
      )}

      <section className="card">
        <h2 className="card__title">Experiments</h2>
        {!runs.data ? <LoadingBlock rows={2} /> : runs.data.length === 0 ? (
          <p className="note">No training runs. No model has been fine-tuned.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Experiment</th><th scope="col">Status</th><th scope="col">Dataset</th><th scope="col" className="num">Epochs</th><th scope="col" className="num">mAP@0.5 (val)</th><th scope="col" className="num">mAP@.5:.95</th><th scope="col">Model</th><th scope="col">When</th></tr></thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.run_id}>
                    <th scope="row"><a className="link" href={href('training', { id: r.run_id })}>{r.name}</a></th>
                    <td><Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill></td>
                    <td>{r.dataset_name} v{r.version}</td>
                    <td className="num">{r.epochs_completed}/{r.epochs}</td>
                    <td className="num">{r.map50 === null || r.map50 === undefined ? '—' : `${(r.map50 * 100).toFixed(1)}%`}</td>
                    <td className="num">{r.map50_95 === null || r.map50_95 === undefined ? '—' : `${(r.map50_95 * 100).toFixed(1)}%`}</td>
                    <td>{r.registered_model_id ? <Pill tone="ok">registered</Pill> : '—'}</td>
                    <td>{formatDateTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="fineprint">Validation mAP comes from Ultralytics on the version’s val split. For a fair comparison with other models, evaluate registered models in the Evaluation Center on the test split.</p>
      </section>

      <ConfirmDialog
        open={confirming}
        title="Start a local training run?"
        confirmLabel="Start training"
        confirmDisabled={!ack.resources || !ack.dataset}
        onCancel={() => setConfirming(false)}
        onConfirm={start}
      >
        {plan && (
          <>
            <p>
              Trains {plan.base_model} for {form.epochs} epochs on {plan.dataset.train_images} images ({plan.dataset.name} v{plan.dataset.version}).
              Estimated <strong>{duration(plan.estimate.duration_s[0])}–{duration(plan.estimate.duration_s[1])}</strong> and{' '}
              <strong>{plan.estimate.ram_mb[0]}–{plan.estimate.ram_mb[1]} MB</strong> of memory
              {plan.estimate.free_ram_mb !== null && ` (${plan.estimate.free_ram_mb} MB free now)`}, ~{plan.estimate.disk_mb} MB disk.
            </p>
            <p className="fineprint">{plan.estimate.note} The machine may be slow while it runs. Benchmarks and evaluations are blocked until it ends.</p>
            <label className="check"><input type="checkbox" checked={ack.resources} onChange={(e) => setAck({ ...ack, resources: e.target.checked })} /> I understand this is CPU- and memory-heavy and may take a long time.</label>
            <label className="check"><input type="checkbox" checked={ack.dataset} onChange={(e) => setAck({ ...ack, dataset: e.target.checked })} /> I understand a small dataset gives a model useful only for testing the workflow.</label>
          </>
        )}
      </ConfirmDialog>
    </div>
  )
}

function PlanView({ plan }: { plan: TrainingPlan }) {
  return (
    <div className={`callout ${plan.ready ? '' : 'callout--error'}`} role="status">
      <strong>{plan.ready ? 'Dataset validated.' : 'Not ready to train.'}</strong>{' '}
      {plan.ready
        ? `${plan.dataset.train_images} train / ${plan.dataset.val_images} val images · classes ${plan.dataset.classes.join(', ')} · est. ${duration(plan.estimate.duration_s[0])}–${duration(plan.estimate.duration_s[1])}, ${plan.estimate.ram_mb[0]}–${plan.estimate.ram_mb[1]} MB RAM.`
        : plan.blockers.join(' ')}
      {plan.active_job && <p className="text-warn">A {plan.active_job} job is running; training must wait.</p>}
      {plan.warnings.length > 0 && <ul className="bullets bullets--muted">{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
    </div>
  )
}

function RunView({ id }: { id: string }) {
  const run = useAsync(() => trainingApi.get(id), [id])
  if (run.error) return <div className="page"><ErrorState message={run.error} onRetry={() => navigate(href('training'))} /></div>
  if (!run.data) return <div className="page"><LoadingBlock rows={6} /></div>
  return <RunDetail run={run.data} onChanged={run.reload} />
}

function series(metrics: Record<string, number>[], key: string, scale = 1) {
  return metrics
    .filter((m) => typeof m[key] === 'number')
    .map((m) => ({ key: String(m.epoch), label: String(m.epoch), value: Math.round(m[key] * scale * 1000) / 1000, description: `Epoch ${m.epoch}: ${(m[key] * scale).toFixed(3)}` }))
}

function RunDetail({ run, onChanged }: { run: TrainingRun; onChanged: () => void }) {
  const [registering, setRegistering] = useState(false)
  const [regName, setRegName] = useState(run.name)
  const [error, setError] = useState<string | null>(null)
  const last = run.metrics[run.metrics.length - 1]
  const running = run.status === 'running' || run.status === 'cancelling'

  const exportConfig = () =>
    trainingApi.config(run.run_id).then((cfg) => downloadBytes(new TextEncoder().encode(JSON.stringify(cfg, null, 2)), `visioniq-training-${run.run_id}.json`, 'application/json'))

  return (
    <div className="page">
      <PageHead
        eyebrow="Training run"
        title={run.name}
        badge={<Pill tone={STATUS_TONE[run.status]}>{run.status}</Pill>}
        subtitle={`${formatDateTime(run.created_at)} · ${run.dataset_name} v${run.version} · base ${run.base_model_id.replace('pretrained:', '')} · ${run.metrics.length}/${run.config.epochs} epochs recorded`}
        actions={
          <>
            <a className="btn btn--ghost" href={href('training')}>Experiments</a>
            <button type="button" className="btn btn--ghost" onClick={() => void exportConfig()}>Export config</button>
            {run.status === 'completed' && !run.registered_model_id && (
              <button type="button" className="btn btn--primary" onClick={() => setRegistering(true)}>Register model…</button>
            )}
            {running && <button type="button" className="btn btn--ghost" onClick={onChanged}>Refresh</button>}
          </>
        }
      />
      {run.status === 'failed' && <p className="callout callout--error">{run.error}</p>}
      {run.status === 'cancelled' && <p className="callout callout--warn">{run.error ?? 'Cancelled.'} This run did not produce a finished model.</p>}
      {run.status === 'interrupted' && <p className="callout callout--warn">The backend restarted during this run; it did not finish.</p>}
      {run.registered_model_id && (
        <p className="callout" role="note">
          Registered as <code>{run.registered_model_id}</code>. It is available in Benchmark Lab and Evaluation; the production detector is unchanged.
        </p>
      )}

      {last && (
        <section className="kpi-grid kpi-grid--compact">
          {[['metrics/mAP50(B)', 'mAP@0.5 (val)'], ['metrics/mAP50-95(B)', 'mAP@.5:.95 (val)'], ['metrics/precision(B)', 'Precision (val)'], ['metrics/recall(B)', 'Recall (val)']].map(([k, l]) => (
            <div key={k} className="kpi kpi--accent"><span className="kpi__label">{l}</span><span className="kpi__value">{typeof last[k] === 'number' ? `${(last[k] * 100).toFixed(1)}%` : '—'}</span><span className="kpi__hint">epoch {last.epoch}</span></div>
          ))}
        </section>
      )}

      <section className="card">
        <h2 className="card__title">Training curves</h2>
        {run.metrics.length === 0 ? (
          <p className="note">{running ? 'Waiting for the first epoch to finish…' : 'No epochs were recorded.'}</p>
        ) : (
          <div className="drift-trends">
            <div><h3 className="section-title">Box loss (train)</h3><ColumnChart label="Train box loss per epoch" height={120} columns={series(run.metrics, 'train/box_loss')} /></div>
            <div><h3 className="section-title">mAP@0.5 (val, %)</h3><ColumnChart label="Validation mAP50 per epoch" height={120} columns={series(run.metrics, 'metrics/mAP50(B)', 100)} /></div>
          </div>
        )}
        <p className="fineprint">Read directly from Ultralytics’ results.csv for this run — nothing is interpolated.</p>
      </section>

      <div className="eval-grid">
        <section className="card">
          <h2 className="card__title">Configuration</h2>
          <dl className="kv">{Object.entries(run.config).filter(([k]) => !['base_weights', 'data'].includes(k)).map(([k, v]) => <div key={k} className="kv__row"><dt>{k}</dt><dd>{String(v)}</dd></div>)}</dl>
          <h3 className="section-title">Artifacts</h3>
          {run.artifacts.length ? <ul className="bullets">{run.artifacts.map((a) => <li key={a.name}>{a.name} · {a.size_mb} MB</li>)}</ul> : <p className="note">No checkpoints.</p>}
        </section>
        <section className="card">
          <h2 className="card__title">Log (tail)</h2>
          <pre className="log">{run.log_tail || 'No output yet.'}</pre>
        </section>
      </div>

      {run.registered_model_id && <TestInference modelId={run.registered_model_id} classes={run.classes} />}

      <ConfirmDialog
        open={registering}
        title="Register this model?"
        confirmLabel="Register"
        onCancel={() => setRegistering(false)}
        onConfirm={() =>
          trainingApi
            .register(run.run_id, regName)
            .then(() => { setRegistering(false); onChanged() })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed.'))
        }
      >
        <p>Makes best.pt selectable in Benchmark Lab and Evaluation. It does <strong>not</strong> replace the production detector used by Analyze.</p>
        <label className="field field--grow"><span>Model name</span><input data-autofocus value={regName} maxLength={80} onChange={(e) => setRegName(e.target.value)} /></label>
        {error && <p className="callout callout--error">{error}</p>}
      </ConfirmDialog>
    </div>
  )
}

function TestInference({ modelId, classes }: { modelId: string; classes: string[] }) {
  const { summaries, recordFor } = useScanData()
  const candidates = summaries.filter((s) => s.status === 'completed').slice(0, 50)
  const [scanId, setScanId] = useState(candidates[0]?.analysis_id ?? '')
  const [result, setResult] = useState<{ dets: Detection[]; ms: number; w: number; h: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const record = recordFor(scanId)
  const image = useScanImage(record)
  const colors = useMemo(() => buildColorMap(classes), [classes])
  return (
    <section className="card">
      <h2 className="card__title">Test inference with the trained model</h2>
      <p className="card__subtitle">Runs this model on a stored scan. Results are shown only — the scan’s saved predictions are not changed.</p>
      <div className="filters filters--inline">
        <label className="field field--grow"><span>Scan</span><select value={scanId} onChange={(e) => { setScanId(e.target.value); setResult(null) }}>{candidates.map((s) => <option key={s.analysis_id} value={s.analysis_id}>{s.filename}</option>)}</select></label>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!scanId || busy}
          onClick={() => {
            setBusy(true)
            setError(null)
            modelsApi
              .predict(modelId, scanId, 0.25, 640)
              .then((r) => setResult({ dets: r.detections, ms: r.inference_ms, w: r.image_width, h: r.image_height }))
              .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Inference failed.'))
              .finally(() => setBusy(false))
          }}
        >
          {busy ? 'Running…' : 'Run inference'}
        </button>
      </div>
      {error && <p className="callout callout--error">{error}</p>}
      {result && (
        <>
          <p className="note">{pluralize(result.dets.length, 'detection')} in {Math.round(result.ms)} ms.</p>
          {image.url && (
            <AnnotatedImage src={image.url} imageWidth={result.w} imageHeight={result.h} detections={result.dets} colors={colors} showBoxes showLabels={false} selectedId={null} onSelect={() => {}} />
          )}
        </>
      )}
    </section>
  )
}

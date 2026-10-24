import { useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { datasetsApi, type DatasetDetail, type VersionSummary } from '../api/workbench'
import { BarList } from '../components/charts/Charts'
import { Segmented, Tabs } from '../components/ui/Controls'
import { ConfirmDialog, LocalOnly, PageHead, Pill, Thumb } from '../components/ui/Page'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/States'
import { useScanData } from '../data/useScanData'
import { useAsync } from '../hooks/useAsync'
import { useWorkbenchAvailable } from '../hooks/useWorkbench'
import { formatDateTime, formatPercent, pluralize } from '../lib/format'
import { downloadBytes } from '../lib/pdf/export'
import { href, navigate } from '../lib/router'

export function DatasetsPage({ datasetId }: { datasetId?: string }) {
  const available = useWorkbenchAvailable()
  if (!available) {
    return (
      <div className="page">
        <PageHead eyebrow="Datasets" title="Retail dataset manager" />
        <LocalOnly feature="Dataset management" />
      </div>
    )
  }
  return datasetId ? <Detail key={datasetId} id={datasetId} /> : <List />
}

function parseClasses(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((c) => c.trim()).filter(Boolean))]
}

function List() {
  const list = useAsync(() => datasetsApi.list(), [])
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', classes: 'bottle, cup' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = () => {
    setBusy(true)
    setError(null)
    datasetsApi
      .create(form.name, form.description, parseClasses(form.classes))
      .then((d) => navigate(href('datasets', { id: d.dataset_id })))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not create the dataset.'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="Datasets"
        title="Retail dataset manager"
        subtitle="Collect real scans, label them in the Annotation Studio, and freeze immutable, reproducibly split versions for evaluation and training."
        actions={<button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>New dataset</button>}
      />
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <LoadingBlock rows={4} />
      ) : list.data.length === 0 ? (
        <EmptyState title="No datasets yet" icon="▤" action={<button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>Create a dataset</button>}>
          A dataset groups scans and their human-reviewed annotations under a fixed class list.
        </EmptyState>
      ) : (
        <ul className="dataset-cards">
          {list.data.map((d) => (
            <li key={d.dataset_id}>
              <a className="card dataset-card" href={href('datasets', { id: d.dataset_id })}>
                <h2 className="card__title">{d.name}</h2>
                {d.description && <p className="card__subtitle">{d.description}</p>}
                <div className="dataset-card__stats">
                  <span><strong>{d.items}</strong> images</span>
                  <span><strong>{d.classes.length}</strong> classes</span>
                  <span><strong>{d.version_count}</strong> versions</span>
                </div>
                <span className="muted">Updated {formatDateTime(d.updated_at)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={creating} title="New dataset" confirmLabel="Create" busy={busy} confirmDisabled={!form.name.trim()} onCancel={() => setCreating(false)} onConfirm={create}>
        <div className="form-grid">
          <label className="field field--grow"><span>Name</span><input data-autofocus value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Aisle 3 beverages" /></label>
          <label className="field field--grow"><span>Description</span><input value={form.description} maxLength={500} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label className="field field--grow"><span>Classes (comma separated, order = class id)</span><input value={form.classes} onChange={(e) => setForm({ ...form, classes: e.target.value })} /></label>
        </div>
        {error && <p className="callout callout--error" role="alert">{error}</p>}
      </ConfirmDialog>
    </div>
  )
}

type DetailTab = 'images' | 'classes' | 'versions'
type ImageFilter = 'all' | 'reviewed' | 'unreviewed' | 'in_progress' | 'none' | 'duplicates'

function Detail({ id }: { id: string }) {
  const ds = useAsync(() => datasetsApi.get(id), [id])
  const [tab, setTab] = useState<DetailTab>('images')
  const [deleting, setDeleting] = useState(false)

  if (ds.error) return <div className="page"><ErrorState title="Dataset unavailable" message={ds.error} onRetry={() => navigate(href('datasets'))} /></div>
  if (!ds.data) return <div className="page"><LoadingBlock rows={6} /></div>
  const d = ds.data
  const latest = d.versions[0]

  return (
    <div className="page">
      <PageHead
        eyebrow="Dataset"
        title={d.name}
        subtitle={
          <>
            {pluralize(d.items.length, 'image')} · {pluralize(d.classes.length, 'class', 'classes')} · {d.status_counts.reviewed} reviewed ·{' '}
            {latest ? `latest version v${latest.version}` : 'no versions yet'}
          </>
        }
        badge={latest && <Pill tone={latest.readiness.training_ready ? 'ok' : 'warn'}>{latest.readiness.training_ready ? `v${latest.version} training-ready` : `v${latest.version} not training-ready`}</Pill>}
        actions={
          <>
            <a className="btn btn--ghost" href={href('datasets')}>All datasets</a>
            <button type="button" className="btn btn--ghost" onClick={() => setDeleting(true)}>Delete</button>
          </>
        }
      />
      <section className="card">
        <Tabs<DetailTab>
          label="Dataset sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'images', label: 'Images', badge: d.items.length },
            { value: 'classes', label: 'Classes', badge: d.classes.length },
            { value: 'versions', label: 'Versions', badge: d.versions.length },
          ]}
        >
          {tab === 'images' && <Images d={d} onChanged={ds.reload} />}
          {tab === 'classes' && <Classes d={d} onChanged={ds.reload} />}
          {tab === 'versions' && <Versions d={d} onChanged={ds.reload} />}
        </Tabs>
      </section>
      <ConfirmDialog
        open={deleting}
        title="Delete this dataset?"
        confirmLabel="Delete dataset"
        danger
        onCancel={() => setDeleting(false)}
        onConfirm={() => datasetsApi.remove(d.dataset_id).then(() => navigate(href('datasets')))}
      >
        The dataset and its versions are removed. Scans and annotations are not touched.
      </ConfirmDialog>
    </div>
  )
}

const ANN_LABEL: Record<string, string> = { none: 'Not annotated', unreviewed: 'Pre-annotated', in_progress: 'In review', reviewed: 'Reviewed' }
const ANN_TONE: Record<string, 'neutral' | 'warn' | 'accent' | 'ok'> = { none: 'neutral', unreviewed: 'warn', in_progress: 'accent', reviewed: 'ok' }
const PAGE = 24

function Images({ d, onChanged }: { d: DatasetDetail; onChanged: () => void }) {
  const [filter, setFilter] = useState<ImageFilter>('all')
  const [adding, setAdding] = useState(false)
  const [page, setPage] = useState(0)
  const shown = d.items.filter((i) => (filter === 'all' ? true : filter === 'duplicates' ? i.duplicate_of.length > 0 : i.annotation_status === filter))
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const current = Math.min(page, pages - 1)

  return (
    <div className="stack">
      <div className="filters filters--inline">
        <Segmented<ImageFilter>
          label="Annotation status"
          size="sm"
          value={filter}
          onChange={(v) => { setFilter(v); setPage(0) }}
          options={[
            { value: 'all', label: `All (${d.items.length})` },
            { value: 'reviewed', label: `Reviewed (${d.status_counts.reviewed})` },
            { value: 'in_progress', label: `In review (${d.status_counts.in_progress})` },
            { value: 'unreviewed', label: `Pre-annotated (${d.status_counts.unreviewed})` },
            { value: 'none', label: `Not annotated (${d.status_counts.none})` },
            { value: 'duplicates', label: `Duplicates (${d.duplicate_groups.flat().length})` },
          ]}
        />
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setAdding(true)}>Add scans</button>
      </div>
      {d.duplicate_groups.length > 0 && (
        <p className="callout callout--warn" role="note">
          {pluralize(d.duplicate_groups.length, 'group')} of byte-identical images. Versions always place duplicates in the same split, so they can’t leak between train and test.
        </p>
      )}
      {shown.length === 0 ? (
        <EmptyState title={d.items.length ? 'No images match' : 'No images yet'} compact>
          {d.items.length ? 'Choose another filter.' : 'Add analysed scans; uploading a new photo through Analyze or Batch makes it available here.'}
        </EmptyState>
      ) : (
        <>
          <ul className="image-grid">
            {shown.slice(current * PAGE, (current + 1) * PAGE).map((i) => (
              <li key={i.analysis_id} className="image-card">
                <a href={href('annotate', { id: i.analysis_id })} className="image-card__link" title="Open in Annotation Studio">
                  <Thumb analysisId={i.analysis_id} alt={i.filename} size={256} />
                </a>
                <div className="image-card__body">
                  <span className="image-card__name" title={i.filename}>{i.filename}</span>
                  <span className="image-card__meta">
                    <Pill tone={ANN_TONE[i.annotation_status]}>{ANN_LABEL[i.annotation_status]}</Pill>
                    <span className="muted">{pluralize(i.boxes, 'box', 'boxes')}</span>
                    {i.duplicate_of.length > 0 && <Pill tone="warn">duplicate</Pill>}
                  </span>
                </div>
                <button
                  type="button"
                  className="image-card__remove"
                  aria-label={`Remove ${i.filename} (${i.analysis_id.slice(0, 8)}) from dataset`}
                  onClick={() => datasetsApi.removeItem(d.dataset_id, i.analysis_id).then(onChanged)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav className="pager" aria-label="Image pages">
              <button type="button" className="btn btn--ghost btn--sm" disabled={current === 0} onClick={() => setPage(current - 1)}>← Prev</button>
              <span>Page {current + 1} of {pages}</span>
              <button type="button" className="btn btn--ghost btn--sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next →</button>
            </nav>
          )}
        </>
      )}
      {adding && <AddScans d={d} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); onChanged() }} />}
    </div>
  )
}

function AddScans({ d, onClose, onAdded }: { d: DatasetDetail; onClose: () => void; onAdded: () => void }) {
  const { summaries } = useScanData()
  const present = new Set(d.items.map((i) => i.analysis_id))
  const candidates = summaries.filter((s) => s.status === 'completed' && !present.has(s.analysis_id))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const shown = candidates.filter((c) => !q || c.filename.toLowerCase().includes(q.toLowerCase())).slice(0, 100)

  return (
    <ConfirmDialog
      open
      title="Add scans to dataset"
      confirmLabel={`Add ${picked.size}`}
      busy={busy}
      confirmDisabled={picked.size === 0}
      onCancel={onClose}
      onConfirm={() => {
        setBusy(true)
        datasetsApi
          .addItems(d.dataset_id, [...picked].slice(0, 200))
          .then((r) => {
            if (r.skipped.length) setResult(`${r.added} added; ${r.skipped.length} skipped: ${r.skipped.slice(0, 3).map((s) => s.reason).join('; ')}`)
            else onAdded()
          })
          .catch((e: unknown) => setResult(e instanceof Error ? e.message : 'Failed.'))
          .finally(() => setBusy(false))
      }}
    >
      <label className="field field--grow"><span>Filter</span><input data-autofocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filename" /></label>
      <div className="row-actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPicked(new Set(shown.map((s) => s.analysis_id)))}>Select shown ({shown.length})</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPicked(new Set())}>Clear</button>
      </div>
      {candidates.length === 0 ? (
        <p className="note">Every completed scan is already in this dataset.</p>
      ) : (
        <ul className="pick-list">
          {shown.map((s) => (
            <li key={s.analysis_id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={picked.has(s.analysis_id)}
                  onChange={(e) => {
                    const next = new Set(picked)
                    if (e.target.checked) next.add(s.analysis_id)
                    else next.delete(s.analysis_id)
                    setPicked(next)
                  }}
                />
                <span>{s.filename}</span>
                <span className="muted">{formatDateTime(s.created_at)} · {pluralize(s.detection_count, 'detection')}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {result && <p className="callout" role="status">{result}</p>}
    </ConfirmDialog>
  )
}

function Classes({ d, onChanged }: { d: DatasetDetail; onChanged: () => void }) {
  const [classes, setClasses] = useState(d.classes)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const dirty = classes.join('|') !== d.classes.join('|')
  const save = (next = classes) =>
    datasetsApi
      .update(d.dataset_id, d.name, d.description, next)
      .then(() => { setError(null); onChanged() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Invalid classes.'))

  return (
    <div className="classes-grid">
      <div className="stack-sm">
        <p className="fineprint">Class ids are the list order (0, 1, 2…). Changes affect future versions only — existing versions keep their own class list.</p>
        <ol className="class-list">
          {classes.map((c, i) => (
            <li key={c}>
              <span className="class-list__id">{i}</span>
              <span>{c}</span>
              <span className="class-list__actions">
                <button type="button" className="btn btn--ghost btn--sm" disabled={i === 0} onClick={() => { const n = [...classes]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setClasses(n) }} aria-label={`Move ${c} up`}>↑</button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setClasses(classes.filter((x) => x !== c))} aria-label={`Remove ${c}`}>✕</button>
              </span>
            </li>
          ))}
        </ol>
        <div className="add-label">
          <label className="field field--grow"><span>Add class</span><input value={draft} maxLength={40} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { setClasses([...new Set([...classes, draft.trim()])]); setDraft('') } }} /></label>
          <button type="button" className="btn btn--ghost btn--sm" disabled={!draft.trim()} onClick={() => { setClasses([...new Set([...classes, draft.trim()])]); setDraft('') }}>Add</button>
        </div>
        <div className="row-actions">
          <button type="button" className="btn btn--primary btn--sm" disabled={!dirty} onClick={() => void save()}>Save classes</button>
          {dirty && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setClasses(d.classes)}>Revert</button>}
        </div>
        {error && <p className="callout callout--error" role="alert">{error}</p>}
      </div>
      <div>
        <h3 className="section-title">Class distribution (reviewed boxes)</h3>
        <BarList label="Reviewed boxes per class" items={d.class_distribution.map((c) => ({ key: c.label, label: c.label, value: c.count }))} emptyText="No classes." />
        {d.unmapped_labels.length > 0 && (
          <div className="callout callout--warn" role="note">
            Reviewed boxes use labels that are not classes, so versions exclude them:
            <ul className="chips">
              {d.unmapped_labels.map((u) => (
                <li key={u.label}>
                  <button type="button" className="chip-btn" onClick={() => void save([...classes, u.label])}>
                    + {u.label} ({u.count})
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

function Versions({ d, onChanged }: { d: DatasetDetail; onChanged: () => void }) {
  const [form, setForm] = useState({ seed: 42, train: 70, val: 20, test: 10, note: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sum = form.train + form.val + form.test
  const create = () => {
    setBusy(true)
    setError(null)
    datasetsApi
      .createVersion(d.dataset_id, { seed: form.seed, train: form.train / 100, val: form.val / 100, test: form.test / 100, note: form.note })
      .then(onChanged)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not create the version.'))
      .finally(() => setBusy(false))
  }
  return (
    <div className="stack">
      <section className="version-form">
        <h3 className="section-title">Freeze a new version</h3>
        <p className="fineprint">
          Snapshots the class list and every <strong>reviewed</strong> annotation now. Unreviewed images are recorded as excluded. Same seed and data → same split, always.
        </p>
        <div className="form-grid">
          {(['train', 'val', 'test'] as const).map((k) => (
            <label key={k} className="field"><span>{k} %</span><input type="number" min={0} max={100} value={form[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) || 0 })} /></label>
          ))}
          <label className="field"><span>Seed</span><input type="number" min={0} value={form.seed} onChange={(e) => setForm({ ...form, seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></label>
          <label className="field field--grow"><span>Note</span><input value={form.note} maxLength={300} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
        </div>
        {sum !== 100 && <p className="text-warn">Splits add up to {sum}% — they must total 100%.</p>}
        <button type="button" className="btn btn--primary btn--sm" disabled={busy || sum !== 100 || d.items.length === 0} onClick={create}>
          {busy ? 'Creating…' : `Create v${d.versions.length + 1}`}
        </button>
        {error && <p className="callout callout--error" role="alert">{error}</p>}
      </section>
      {d.versions.length === 0 ? (
        <EmptyState title="No versions yet" compact>Versions are immutable snapshots used by evaluation and training.</EmptyState>
      ) : (
        <ul className="version-list">
          {d.versions.map((v) => <VersionCard key={v.version_id} v={v} />)}
        </ul>
      )}
    </div>
  )
}

function VersionCard({ v }: { v: VersionSummary }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const classes = useMemo(() => Object.entries(v.stats.class_counts).sort((a, b) => b[1] - a[1]), [v])
  const exportZip = () => {
    setBusy(true)
    setError(null)
    datasetsApi
      .exportZip(v.dataset_id, v.version)
      .then(async (blob) => {
        if (!blob) throw new Error('Export not found.')
        downloadBytes(new Uint8Array(await blob.arrayBuffer()), `visioniq-${v.dataset_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-v${v.version}-yolo.zip`, 'application/zip')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Export failed.'))
      .finally(() => setBusy(false))
  }
  return (
    <li className="card version-card">
      <header className="card__header">
        <div>
          <h3 className="card__title">
            v{v.version} <Pill tone={v.readiness.training_ready ? 'ok' : 'warn'}>{v.readiness.training_ready ? 'training-ready' : 'not training-ready'}</Pill>
          </h3>
          <p className="card__subtitle">
            {formatDateTime(v.created_at)} · seed {v.split.seed} · {Math.round(v.split.train * 100)}/{Math.round(v.split.val * 100)}/{Math.round(v.split.test * 100)}
            {v.split.note && ` · ${v.split.note}`}
          </p>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={exportZip} disabled={busy || v.stats.labeled_images === 0}>
          {busy ? 'Exporting…' : 'Export YOLO zip'}
        </button>
      </header>
      <div className="version-card__grid">
        <dl className="kv">
          <div className="kv__row"><dt>Labelled images</dt><dd>{v.stats.labeled_images}</dd></div>
          <div className="kv__row"><dt>Excluded (not reviewed)</dt><dd>{v.stats.excluded_images}</dd></div>
          <div className="kv__row"><dt>Boxes</dt><dd>{v.stats.boxes}</dd></div>
          <div className="kv__row"><dt>Train / val / test images</dt><dd>{v.stats.splits.train.images} / {v.stats.splits.val.images} / {v.stats.splits.test.images}</dd></div>
          <div className="kv__row" title="Share of ground-truth boxes that are model predictions accepted without any edit"><dt>Unedited predictions</dt><dd>{formatPercent(v.stats.unedited_prediction_share)}</dd></div>
        </dl>
        <BarList label="Boxes per class" items={classes.map(([k, n]) => ({ key: k, label: k, value: n }))} emptyText="No boxes." />
      </div>
      {v.readiness.blockers.length > 0 && (
        <ul className="bullets bullets--error">{v.readiness.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
      )}
      {v.readiness.warnings.length > 0 && (
        <ul className="bullets bullets--muted">{v.readiness.warnings.map((b) => <li key={b}>{b}</li>)}</ul>
      )}
      {error && <p className="callout callout--error" role="alert">{error}</p>}
    </li>
  )
}

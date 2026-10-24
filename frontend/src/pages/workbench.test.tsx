import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScanDataProvider } from '../data/ScanDataProvider'
import { clearRecordCache } from '../data/recordCache'
import { clearImageCache } from '../data/useScanImage'
import { FakeSource, stubApi } from '../test/fakeBackend'
import { makeDetection, makeRecord } from '../test/fixtures'
import type { AnalysisRecord } from '../types'
import { AlertsPage } from './AlertsPage'
import { AnnotatePage } from './AnnotatePage'
import { AskPage } from './AskPage'
import { BenchmarkPage } from './BenchmarkPage'
import { DatasetsPage } from './DatasetsPage'
import { DriftPage } from './DriftPage'
import { EvaluationPage } from './EvaluationPage'
import { QualityPage } from './QualityPage'
import { TrainingPage } from './TrainingPage'

function scan(id: string, dets = [makeDetection(0, 'bottle', 0.9, [10, 10, 50, 50]), makeDetection(1, 'cup', 0.4, [100, 100, 150, 150])]): AnalysisRecord {
  const r = makeRecord(dets)
  return { ...r, analysis_id: id, image: { ...r.image, filename: `${id}.jpg` } }
}

function renderWith(ui: React.ReactNode, records = [scan('s1'), scan('s2')], mode: 'local' | 'cloud' | 'demo' = 'local') {
  return render(<ScanDataProvider source={new FakeSource(records, mode)}>{ui}</ScanDataProvider>)
}

beforeEach(() => {
  clearRecordCache()
  clearImageCache()
  window.localStorage.clear()
  window.location.hash = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------

describe('Ask VisionIQ page', () => {
  it('answers a suggested question from the scan data with scope and evidence', async () => {
    renderWith(<AskPage />)
    const suggestion = await screen.findByRole('button', { name: 'Which category appears most frequently?' })
    await waitFor(() => expect(suggestion).toBeEnabled())
    await userEvent.click(suggestion)
    const card = screen.getByText('Computed answer').closest('article')!
    expect(within(card).getByText("'bottle' — 2 detections")).toBeInTheDocument()
    expect(within(card).getByText(/Scope: all time · 2 scans · Stored scans \(local backend\)/)).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: /Timeline · bottle/ })).toHaveAttribute('href', expect.stringContaining('category=bottle'))
    expect(screen.getByText('Rule-based · no LLM')).toBeInTheDocument()
  })

  it('declines unsupported questions and keeps only questions in history', async () => {
    renderWith(<AskPage />)
    const box = await screen.findByLabelText('Question')
    await waitFor(() => expect(box).toBeEnabled())
    await userEvent.type(box, 'Are bottles out of stock?{Enter}')
    expect(screen.getByText('Not supported')).toBeInTheDocument()
    const saved = JSON.parse(window.localStorage.getItem('visioniq.ask.history.v1')!)
    expect(saved).toHaveLength(1)
    expect(saved[0]).not.toHaveProperty('answer')
  })
})

// ---------------------------------------------------------------------------

const RULES = [
  { rule_id: 'rule_0000000000000001', name: 'Failed scans', severity: 'critical', enabled: true, params: { type: 'scan_status', statuses: ['failed'] }, revision: 1, default: true, created_at: '', updated_at: '' },
]
const EVENT = {
  alert_id: 'alert_0000000000000001', rule_id: 'rule_0000000000000001', rule_name: 'Failed scans', rule_revision: 1,
  rule_type: 'scan_status', severity: 'critical', analysis_id: 's1', filename: 's1.jpg', subject: 's1',
  title: 'Scan failed', reason: 'The analysis failed: boom.', evidence: {}, status: 'open', note: '',
  first_seen_at: new Date().toISOString(), last_evaluated_at: '', condition_active: true, scan_missing: false, superseded: false,
}
const SUMMARY = { open: 1, by_severity: { critical: 1, warning: 0, info: 0 }, acknowledged: 0, resolved: 0, total: 1 }

describe('Alerts page', () => {
  it('lists alerts with evidence and records an acknowledgement', async () => {
    const api = stubApi({
      'GET /api/alerts/rules': RULES,
      'GET /api/alerts': { items: [EVENT], summary: SUMMARY },
      'PATCH /api/alerts/': (c) => ({ body: { ...EVENT, status: (c.body as { status: string }).status } }),
    })
    renderWith(<AlertsPage />)
    expect(await screen.findByText('Scan failed')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 's1.jpg →' })).toHaveAttribute('href', '#/analyze/s1')
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true))
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ status: 'acknowledged', note: '' })
  })

  it('creates a rule with validated parameters', async () => {
    const api = stubApi({
      'GET /api/alerts/rules': RULES,
      'GET /api/alerts': { items: [], summary: { ...SUMMARY, open: 0 } },
      'POST /api/alerts/rules': (c) => ({ status: 201, body: { ...RULES[0], ...(c.body as object) } }),
    })
    renderWith(<AlertsPage />)
    await userEvent.click(await screen.findByRole('tab', { name: /Rules/ }))
    await userEvent.click(screen.getByRole('button', { name: 'New rule' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Condition'), { target: { value: 'category_count' } })
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: '3' } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }))
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/alerts/rules')).toBe(true))
    const body = api.calls.find((c) => c.method === 'POST')!.body as { params: Record<string, unknown> }
    expect(body.params).toMatchObject({ type: 'category_count', label: 'bottle', op: 'lt', value: 3 })
  })

  it('explains that alerts need the local backend in demo mode', () => {
    renderWith(<AlertsPage />, [], 'demo')
    expect(screen.getByText(/runs on the local backend/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------

const REPORT = {
  version: 1, overall: 'poor', width: 200, height: 150, format: 'JPEG', megapixels: 0.03, analysed_edge: 200,
  disclaimer: 'Heuristic checks with fixed thresholds — not a calibrated quality score.',
  metrics: [
    { key: 'sharpness', label: 'Sharpness', value: 40, unit: 'Laplacian variance', level: 'poor', detail: '' },
    { key: 'resolution', label: 'Resolution', value: 150, unit: 'shortest side (px)', level: 'poor', detail: '' },
  ],
  issues: [{ key: 'sharpness', level: 'poor', message: 'The image looks soft or blurred.', suggestion: 'Hold the camera steady.' }],
}

describe('Image quality page', () => {
  it('lists stored scan quality and offers to inspect older scans', async () => {
    stubApi({ 'GET /api/quality': { items: [{ analysis_id: 's1', created_at: new Date().toISOString(), filename: 's1.jpg', report: REPORT }], scans: 2, missing: ['s2'] } })
    renderWith(<QualityPage />)
    expect(await screen.findByText('s1.jpg')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 scans inspected.', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Inspect 1 older scans' })).toBeInTheDocument()
    expect(screen.getByText(/rules of thumb for shelf photos/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------

const DOC = {
  analysis_id: 's1', filename: 's1.jpg', image_width: 400, image_height: 300, status: 'unreviewed',
  boxes: [
    { id: 'p0', label: 'bottle', x1: 10, y1: 10, x2: 50, y2: 50, source: 'model', origin_detection_id: 0, model_label: 'bottle', model_confidence: 0.9, edited: false },
    { id: 'p1', label: 'cup', x1: 100, y1: 100, x2: 150, y2: 150, source: 'model', origin_detection_id: 1, model_label: 'cup', model_confidence: 0.4, edited: false },
  ],
  imported_detection_ids: [0, 1], import_min_confidence: 0.25, prediction_model: { name: 'yolov8n.pt', version: '8' },
  stats: { boxes: 2, accepted_unmodified: 2, edited_predictions: 0, human_added: 0, deleted_predictions: 0, imported_predictions: 2 },
  reviewed_at: null, created_at: '', revision: 3, updated_at: '',
}

describe('Annotation Studio', () => {
  it('offers to pre-annotate a scan that has no annotations', async () => {
    const api = stubApi({
      'GET /api/annotations/labels': ['bottle'],
      'GET /api/annotations/s1': { status: 404, body: { success: false, error: 'not_annotated', detail: 'none' } },
      'POST /api/annotations/s1/import': { ...DOC, revision: 1 },
    })
    renderWith(<AnnotatePage scanId="s1" />)
    const btn = await screen.findByRole('button', { name: 'Import 2 predictions' })
    await userEvent.click(btn)
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/annotations/s1/import')).toBe(true))
    expect(api.calls.find((c) => c.path.endsWith('/import'))!.body).toEqual({ min_confidence: 0.25 })
  })

  it('deletes a box from the keyboard and saves against the loaded revision', async () => {
    const api = stubApi({
      'GET /api/annotations/labels': ['bottle', 'cup'],
      'GET /api/annotations/s1': DOC,
      'PUT /api/annotations/s1': (c) => ({ body: { ...DOC, ...(c.body as object), revision: 4 } }),
    })
    renderWith(<AnnotatePage scanId="s1" />)
    const canvas = await screen.findByRole('application')
    await userEvent.click(screen.getByRole('button', { name: /cup/ }))
    act(() => {
      fireEvent.keyDown(canvas, { key: 'Delete' })
    })
    expect(screen.getByText('unsaved changes', { exact: false })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }))
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true))
    const body = api.calls.find((c) => c.method === 'PUT')!.body as { base_revision: number; status: string; boxes: { id: string }[] }
    expect(body.base_revision).toBe(3)
    expect(body.status).toBe('reviewed')
    expect(body.boxes.map((b) => b.id)).toEqual(['p0'])
  })

  it('moves the selected box with arrow keys inside the image and supports undo', async () => {
    const api = stubApi({ 'GET /api/annotations/labels': ['bottle'], 'GET /api/annotations/s1': DOC, 'PUT /api/annotations/s1': DOC })
    renderWith(<AnnotatePage scanId="s1" />)
    const canvas = await screen.findByRole('application')
    await userEvent.click(screen.getByRole('button', { name: /bottle/ }))
    act(() => {
      fireEvent.keyDown(canvas, { key: 'ArrowLeft', shiftKey: true }) // x1 10 -> 0, clamped
    })
    const x1 = screen.getByLabelText('x1') as HTMLInputElement
    expect(x1.value).toBe('0')
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect((screen.getByLabelText('x1') as HTMLInputElement).value).toBe('10')
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('shows a conflict instead of overwriting a newer save', async () => {
    stubApi({
      'GET /api/annotations/labels': ['bottle'],
      'GET /api/annotations/s1': DOC,
      'PUT /api/annotations/s1': { status: 409, body: { success: false, error: 'revision_conflict', detail: 'These annotations were saved elsewhere.' } },
    })
    renderWith(<AnnotatePage scanId="s1" />)
    await screen.findByRole('application')
    await userEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }))
    expect(await screen.findByText(/saved elsewhere/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload the saved version' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------

const VERSION_BLOCKED = {
  dataset_id: 'ds_0000000000000001', dataset_name: 'Aisle', version: 1, version_id: 'ds_0000000000000001.v1', created_at: new Date().toISOString(),
  classes: ['bottle'], split: { seed: 42, train: 0.7, val: 0.2, test: 0.1, note: '' },
  stats: { items: 2, labeled_images: 0, excluded_images: 2, boxes: 0, class_counts: {}, unmapped_boxes: 0, splits: { train: { images: 0, boxes: 0 }, val: { images: 0, boxes: 0 }, test: { images: 0, boxes: 0 } }, unedited_prediction_share: null },
  readiness: { training_ready: false, evaluation_ready: false, blockers: ['No reviewed annotations — nothing in this version is verified ground truth.'], warnings: [] },
}

describe('Datasets page', () => {
  it('shows versions with honest readiness and no export without labels', async () => {
    stubApi({
      'GET /api/datasets/ds_0000000000000001': {
        dataset_id: 'ds_0000000000000001', name: 'Aisle', description: '', classes: ['bottle'], created_at: '', revision: 2, version_count: 1,
        items: [], status_counts: { none: 0, unreviewed: 0, in_progress: 0, reviewed: 0 }, class_distribution: [{ label: 'bottle', count: 0 }],
        unmapped_labels: [], duplicate_groups: [], versions: [VERSION_BLOCKED],
      },
    })
    renderWith(<DatasetsPage datasetId="ds_0000000000000001" />)
    expect(await screen.findByText('v1 not training-ready')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /Versions/ }))
    expect(screen.getByText(/nothing in this version is verified ground truth/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export YOLO zip' })).toBeDisabled()
  })

  it('creates a dataset with an ordered class list', async () => {
    const api = stubApi({
      'GET /api/datasets': [],
      'POST /api/datasets': { dataset_id: 'ds_0000000000000002', name: 'New', description: '', classes: ['bottle', 'cup'], items: 0, version_count: 0, created_at: '', updated_at: '' },
    })
    renderWith(<DatasetsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Create a dataset' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Name'), 'New')
    fireEvent.change(within(dialog).getByLabelText(/Classes/), { target: { value: 'bottle, cup, bottle' } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true))
    expect(api.calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'New', description: '', classes: ['bottle', 'cup'] })
  })
})

// ---------------------------------------------------------------------------

const MODELS = [{ model_id: 'pretrained:yolov8n.pt', name: 'yolov8n.pt', source: 'pretrained', size_mb: 6.5, production: true, classes: null, taxonomy: 'COCO-80', note: '' }]

describe('Benchmark Lab', () => {
  it('requires explicit confirmation before running real inference', async () => {
    const api = stubApi({
      'GET /api/models': MODELS,
      'GET /api/benchmarks': [],
      'GET /api/workbench/status': { available: true, active_job: null, free_ram_mb: 4000, runtime: {} },
      'POST /api/benchmarks': { job_id: 'job_0000000000000001', kind: 'benchmark', status: 'running', progress: { done: 0, total: 3, message: '' }, created_at: new Date().toISOString() },
      'GET /api/workbench/jobs/': { job_id: 'job_0000000000000001', kind: 'benchmark', status: 'running', progress: { done: 1, total: 3, message: 'run 1/3' }, created_at: new Date().toISOString() },
    })
    renderWith(<BenchmarkPage />)
    const s1 = await screen.findByRole('checkbox', { name: /s1\.jpg/ })
    await userEvent.click(s1)
    await userEvent.click(screen.getByRole('button', { name: /Run benchmark \(3 inferences\)/ }))
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false) // nothing starts without confirming
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/3 real CPU inferences/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start benchmark' }))
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true))
    expect(api.calls.find((c) => c.method === 'POST')!.body).toMatchObject({ confirm: true, repeats: 3, analysis_ids: ['s1'] })
    expect(await screen.findByText(/cannot be interrupted/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------

describe('Evaluation center', () => {
  it('stays disabled without labelled ground truth', async () => {
    stubApi({ 'GET /api/datasets/versions': [VERSION_BLOCKED], 'GET /api/models': MODELS, 'GET /api/evaluations': [] })
    renderWith(<EvaluationPage params={new URLSearchParams()} />)
    expect(await screen.findByText('Evaluation needs labelled ground truth')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run evaluation' })).toBeNull()
  })

  it('reports a circular-label block from preflight', async () => {
    const ready = { ...VERSION_BLOCKED, stats: { ...VERSION_BLOCKED.stats, labeled_images: 4, splits: { ...VERSION_BLOCKED.stats.splits, test: { images: 1, boxes: 1 } } }, readiness: { ...VERSION_BLOCKED.readiness, evaluation_ready: true } }
    stubApi({
      'GET /api/datasets/versions': [ready],
      'GET /api/models': MODELS,
      'GET /api/evaluations': [],
      'POST /api/evaluations/preflight': { ok: false, reasons: ['Every ground-truth box is an unedited prediction of this same model — evaluating would score the model against itself.'], images: 1, bias: { gt_boxes: 1, unedited_from_this_model: 1, unedited_share: 1, human_changes: 0, circular: true, biased: true }, classes: ['bottle'], model_file: 'yolov8n.pt' },
    })
    renderWith(<EvaluationPage params={new URLSearchParams()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Check readiness' }))
    expect(await screen.findByText(/score the model against itself/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run evaluation' })).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------

describe('Drift monitor', () => {
  it('reports insufficient data and incompatible windows honestly', async () => {
    const metric = (key: string, label: string) => ({ key, label, status: 'insufficient', statistic: 'KS', value: null, summary: 'Needs at least 5 values per window (have 1 and 1).', baseline_n: 1, comparison_n: 1 })
    stubApi({
      'GET /api/saved/drift_config': [],
      'POST /api/drift/analyze': {
        baseline: { start: new Date().toISOString(), end: new Date().toISOString(), scans: 1, all_scans: 1, detections: 2, configs: { 'yolov8n.pt 8 @ 0.25': 1 }, quality_coverage: 0, evidence: [] },
        comparison: { start: new Date().toISOString(), end: new Date().toISOString(), scans: 1, all_scans: 1, detections: 2, configs: { 'yolov8n.pt 8 @ 0.5': 1 }, quality_coverage: 0, evidence: [] },
        compatible: false,
        compatibility: 'incompatible',
        compatibility_note: 'The windows used different model configurations; output distributions are not comparable.',
        metrics: { category: { ...metric('category', 'Category mix'), statistic: 'PSI', changes: [] }, confidence: metric('confidence', 'Confidence distribution'), count: metric('count', 'Detections per scan') },
        trend: [], method: { min_scans: 5, min_detections: 30, psi_bands: [0.1, 0.25], ks_p_threshold: 0.01, ks_d_bands: [0.1, 0.2] },
        disclaimer: 'Distribution shift is not proof of reduced accuracy; that needs labelled ground truth.',
      },
    })
    renderWith(<DriftPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Analyse drift' }))
    expect(await screen.findByText('Incompatible windows.')).toBeInTheDocument()
    expect(screen.getAllByText('insufficient')).toHaveLength(3)
    expect(screen.getByText(/not proof of reduced accuracy/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------

describe('Training', () => {
  it('shows Dataset required / Training not started without a ready dataset', async () => {
    stubApi({ 'GET /api/datasets/versions': [VERSION_BLOCKED], 'GET /api/models': MODELS, 'GET /api/training': [] })
    renderWith(<TrainingPage />)
    expect(await screen.findByText('Dataset required · Training not started')).toBeInTheDocument()
    expect(screen.getByText('No retail model trained yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Start training/ })).toBeNull()
  })

  it('needs a plan and both acknowledgements before starting', async () => {
    const ready = { ...VERSION_BLOCKED, stats: { ...VERSION_BLOCKED.stats, labeled_images: 4, splits: { train: { images: 3, boxes: 3 }, val: { images: 1, boxes: 1 }, test: { images: 0, boxes: 0 } } }, readiness: { training_ready: true, evaluation_ready: true, blockers: [], warnings: [] } }
    const api = stubApi({
      'GET /api/datasets/versions': [ready],
      'GET /api/models': MODELS,
      'GET /api/training': [],
      'POST /api/training/plan': { ready: true, blockers: [], warnings: ['Only 4 labelled images.'], dataset: { name: 'Aisle', version: 1, classes: ['bottle'], train_images: 3, val_images: 1 }, base_model: 'yolov8n.pt', estimate: { duration_s: [10, 60], ram_mb: [1000, 2000], free_ram_mb: 500, disk_mb: 20, note: 'Rough heuristic.' }, active_job: null },
      'POST /api/training': { job_id: 'job_0000000000000009', kind: 'training', status: 'running', progress: { done: 0, total: 10, message: '' }, created_at: new Date().toISOString() },
      'GET /api/workbench/jobs/': { job_id: 'job_0000000000000009', kind: 'training', status: 'running', progress: { done: 1, total: 10, message: 'Epoch 1/10' }, created_at: new Date().toISOString() },
    })
    renderWith(<TrainingPage />)
    const start = await screen.findByRole('button', { name: 'Start training…' })
    expect(start).toBeDisabled() // no plan yet
    await userEvent.click(screen.getByRole('button', { name: /Check dataset/ }))
    await waitFor(() => expect(start).toBeEnabled())
    await userEvent.click(start)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/500 MB free now/)).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Start training' })
    expect(confirm).toBeDisabled()
    for (const box of within(dialog).getAllByRole('checkbox')) await userEvent.click(box)
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/training')).toBe(true))
    expect(api.calls.find((c) => c.path === '/api/training' && c.method === 'POST')!.body).toMatchObject({ confirm: true, acknowledge_resources: true, epochs: 10, image_size: 320 })
    expect(await screen.findByText(/terminates the training process/)).toBeInTheDocument()
  })
})

describe('Drift compatibility wording (BUG-10 regression)', () => {
  it('says "Compatibility unknown" when a window has no successful scans', async () => {
    const metric = { key: 'count', label: 'Detections per scan', status: 'insufficient', statistic: 'KS', value: null, summary: 'Needs data.', baseline_n: 0, comparison_n: 3 }
    const win = (scans: number) => ({ start: new Date().toISOString(), end: new Date().toISOString(), scans, all_scans: scans, detections: 0, configs: {}, quality_coverage: 0, evidence: [] })
    stubApi({
      'GET /api/saved/drift_config': [],
      'POST /api/drift/analyze': { baseline: win(0), comparison: win(3), compatible: true, compatibility: 'unknown', compatibility_note: 'Not enough successful scans to check model compatibility.', metrics: { count: metric, category: { ...metric, key: 'category', label: 'Category mix', statistic: 'PSI', changes: [] } }, trend: [], method: { min_scans: 5, min_detections: 30, psi_bands: [0.1, 0.25], ks_p_threshold: 0.01, ks_d_bands: [0.1, 0.2] }, disclaimer: 'x' },
    })
    renderWith(<DriftPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Analyse drift' }))
    expect(await screen.findByText('Compatibility unknown.')).toBeInTheDocument()
    expect(screen.queryByText('Comparable windows.')).toBeNull()
  })
})

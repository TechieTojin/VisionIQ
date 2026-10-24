/**
 * Typed client for the local workbench API (backend/app/routes/workbench.py).
 *
 * Every endpoint here exists only on the FastAPI backend. Pages call
 * `useWorkbenchAvailable()` first and render a "local mode only" state in
 * cloud and demo deployments instead of issuing requests that cannot work.
 */

import { request, requestBlob } from './client'
import type { Detection } from '../types'

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const enc = encodeURIComponent

// -- quality ---------------------------------------------------------------

export type QualityLevel = 'good' | 'warn' | 'poor'

export interface QualityMetric {
  key: string
  label: string
  value: number
  unit: string
  level: QualityLevel
  detail: string
}

export interface QualityReport {
  version: number
  overall: QualityLevel
  metrics: QualityMetric[]
  issues: { key: string; level: QualityLevel; message: string; suggestion: string }[]
  width: number
  height: number
  format: string
  megapixels: number
  analysed_edge: number
  disclaimer: string
}

export interface StoredQuality {
  analysis_id: string
  created_at: string
  filename: string
  report: QualityReport
}

export const quality = {
  inspect(file: File): Promise<QualityReport> {
    const body = new FormData()
    body.append('file', file)
    return request<QualityReport>('/api/quality/inspect', { method: 'POST', body })
  },
  get: (id: string, recompute = false) =>
    request<StoredQuality>(`/api/quality/${enc(id)}${recompute ? '?recompute=true' : ''}`),
  list: () => request<{ items: StoredQuality[]; scans: number; missing: string[] }>('/api/quality'),
  backfill: (limit = 25) =>
    request<{ computed: number; failed: { analysis_id: string; reason: string }[]; remaining: number }>(
      '/api/quality/backfill',
      json({ limit }),
    ),
}

// -- alerts ------------------------------------------------------------------

export type Severity = 'critical' | 'warning' | 'info'
export type RuleOp = 'lt' | 'lte' | 'gt' | 'gte' | 'eq'

export interface ZoneRect {
  name: string
  x0: number
  y0: number
  x1: number
  y1: number
}

export type RuleParams =
  | { type: 'low_confidence'; threshold: number; min_count: number }
  | { type: 'category_count'; label: string; op: RuleOp; value: number; min_confidence: number }
  | { type: 'count_change'; direction: 'drop' | 'rise' | 'either'; percent: number; min_previous: number; label: string | null }
  | { type: 'zone_count'; zone: ZoneRect; op: RuleOp; value: number; label: string | null }
  | { type: 'quality'; level: 'warn' | 'poor'; metrics: string[] }
  | { type: 'scan_status'; statuses: ('failed' | 'unavailable' | 'timeout')[] }
  | { type: 'drift'; metric: 'category' | 'confidence' | 'count'; comparison_days: number; baseline_days: number }

export type RuleType = RuleParams['type']

export interface AlertRule {
  rule_id: string
  name: string
  severity: Severity
  enabled: boolean
  params: RuleParams
  revision: number
  default: boolean
  created_at: string
  updated_at: string
}

export interface RuleInput {
  name: string
  severity: Severity
  enabled: boolean
  params: RuleParams
}

export type AlertStatus = 'open' | 'acknowledged' | 'resolved'

export interface AlertEvent {
  alert_id: string
  rule_id: string
  rule_name: string
  rule_revision: number
  rule_type: RuleType
  severity: Severity
  analysis_id: string | null
  filename: string | null
  subject: string
  title: string
  reason: string
  evidence: Record<string, unknown>
  status: AlertStatus
  note: string
  first_seen_at: string
  last_evaluated_at: string
  condition_active: boolean
  scan_missing: boolean
  superseded: boolean
  rule_deleted?: boolean
}

export interface AlertSummary {
  open: number
  by_severity: Record<Severity, number>
  acknowledged: number
  resolved: number
  total: number
}

export const alerts = {
  rules: () => request<AlertRule[]>('/api/alerts/rules'),
  createRule: (rule: RuleInput) => request<AlertRule>('/api/alerts/rules', json(rule)),
  updateRule: (id: string, rule: RuleInput) => request<AlertRule>(`/api/alerts/rules/${enc(id)}`, json(rule, 'PUT')),
  deleteRule: (id: string) => request<void>(`/api/alerts/rules/${enc(id)}`, { method: 'DELETE' }),
  evaluate: () =>
    request<{ evaluated_at: string; rules: number; scans: number; quality_coverage: number; created: number; updated: number }>(
      '/api/alerts/evaluate',
      { method: 'POST' },
    ),
  list: () => request<{ items: AlertEvent[]; summary: AlertSummary }>('/api/alerts'),
  summary: () => request<AlertSummary>('/api/alerts/summary'),
  update: (id: string, status: AlertStatus, note = '') =>
    request<AlertEvent>(`/api/alerts/${enc(id)}`, json({ status, note }, 'PATCH')),
}

// -- annotations --------------------------------------------------------------

export type AnnotationStatus = 'unreviewed' | 'in_progress' | 'reviewed'

export interface AnnotationBox {
  id: string
  label: string
  x1: number
  y1: number
  x2: number
  y2: number
  source: 'model' | 'human'
  origin_detection_id: number | null
  model_label: string | null
  model_confidence: number | null
  edited: boolean
}

export interface AnnotationStats {
  boxes: number
  accepted_unmodified: number
  edited_predictions: number
  human_added: number
  deleted_predictions: number
  imported_predictions: number
}

export interface AnnotationDoc {
  analysis_id: string
  filename: string
  image_width: number
  image_height: number
  status: AnnotationStatus
  boxes: AnnotationBox[]
  imported_detection_ids: number[]
  import_min_confidence: number | null
  prediction_model: { name: string; version: string } | null
  stats: AnnotationStats
  reviewed_at: string | null
  created_at: string
  revision: number
  updated_at: string
}

export interface AnnotationOverviewItem {
  analysis_id: string
  filename: string
  created_at: string
  has_image: boolean
  predictions: number
  status: AnnotationStatus | 'none'
  stats: AnnotationStats | null
  updated_at: string | null
}

export type BoxInput = Pick<AnnotationBox, 'id' | 'label' | 'x1' | 'y1' | 'x2' | 'y2' | 'source' | 'origin_detection_id'>

export const annotations = {
  overview: () =>
    request<{ items: AnnotationOverviewItem[]; counts: Record<string, number>; total: number }>('/api/annotations'),
  get: (id: string) => request<AnnotationDoc>(`/api/annotations/${enc(id)}`),
  importPredictions: (id: string, minConfidence: number) =>
    request<AnnotationDoc>(`/api/annotations/${enc(id)}/import`, json({ min_confidence: minConfidence })),
  startEmpty: (id: string) => request<AnnotationDoc>(`/api/annotations/${enc(id)}/empty`, { method: 'POST' }),
  save: (id: string, baseRevision: number, status: AnnotationStatus, boxes: BoxInput[]) =>
    request<AnnotationDoc>(`/api/annotations/${enc(id)}`, json({ base_revision: baseRevision, status, boxes }, 'PUT')),
  remove: (id: string) => request<void>(`/api/annotations/${enc(id)}`, { method: 'DELETE' }),
  labels: () => request<string[]>('/api/annotations/labels'),
  addLabel: (name: string) => request<string[]>('/api/annotations/labels', json({ name })),
  yolo: (id: string) =>
    request<{ analysis_id: string; status: string; classes: string[]; label_file: string; note: string }>(
      `/api/annotations/${enc(id)}/yolo`,
    ),
}

// -- datasets -----------------------------------------------------------------

export interface DatasetSummary {
  dataset_id: string
  name: string
  description: string
  classes: string[]
  items: number
  version_count: number
  created_at: string
  updated_at: string
}

export interface DatasetItem {
  analysis_id: string
  sha256: string
  format: string
  filename: string
  width: number
  height: number
  added_at: string
  annotation_status: AnnotationStatus | 'none'
  boxes: number
  duplicate_of: string[]
}

export interface Readiness {
  training_ready: boolean
  evaluation_ready: boolean
  blockers: string[]
  warnings: string[]
}

export interface VersionStats {
  items: number
  labeled_images: number
  excluded_images: number
  boxes: number
  class_counts: Record<string, number>
  unmapped_boxes: number
  splits: Record<'train' | 'val' | 'test', { images: number; boxes: number }>
  unedited_prediction_share: number | null
}

export interface VersionSummary {
  dataset_id: string
  dataset_name: string
  version: number
  version_id: string
  created_at: string
  classes: string[]
  split: { seed: number; train: number; val: number; test: number; note: string }
  stats: VersionStats
  readiness: Readiness
}

export interface DatasetDetail extends Omit<DatasetSummary, 'items' | 'updated_at'> {
  revision: number
  items: DatasetItem[]
  status_counts: Record<string, number>
  class_distribution: { label: string; count: number }[]
  unmapped_labels: { label: string; count: number }[]
  duplicate_groups: string[][]
  versions: VersionSummary[]
}

export const datasetsApi = {
  list: () => request<DatasetSummary[]>('/api/datasets'),
  create: (name: string, description: string, classes: string[]) =>
    request<DatasetSummary>('/api/datasets', json({ name, description, classes })),
  get: (id: string) => request<DatasetDetail>(`/api/datasets/${enc(id)}`),
  update: (id: string, name: string, description: string, classes: string[]) =>
    request<DatasetDetail>(`/api/datasets/${enc(id)}`, json({ name, description, classes }, 'PUT')),
  remove: (id: string) => request<void>(`/api/datasets/${enc(id)}`, { method: 'DELETE' }),
  addItems: (id: string, analysisIds: string[]) =>
    request<{ added: number; skipped: { analysis_id: string; reason: string }[]; dataset: DatasetDetail }>(
      `/api/datasets/${enc(id)}/items`,
      json({ analysis_ids: analysisIds }),
    ),
  removeItem: (id: string, analysisId: string) =>
    request<DatasetDetail>(`/api/datasets/${enc(id)}/items/${enc(analysisId)}`, { method: 'DELETE' }),
  createVersion: (id: string, body: { seed: number; train: number; val: number; test: number; note: string }) =>
    request<VersionSummary>(`/api/datasets/${enc(id)}/versions`, json(body)),
  versions: () => request<VersionSummary[]>('/api/datasets/versions'),
  exportZip: (id: string, version: number) => requestBlob(`/api/datasets/${enc(id)}/versions/${version}/export`),
}

// -- models / jobs ------------------------------------------------------------------

export interface LocalModel {
  model_id: string
  name: string
  source: 'pretrained' | 'trained'
  size_mb: number | null
  production: boolean
  classes: string[] | null
  taxonomy: string
  note: string
  training_run_id?: string
  registered_at?: string
  available?: boolean
}

export type JobStatusName = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface WorkbenchJob {
  job_id: string
  kind: 'benchmark' | 'evaluation' | 'training'
  status: JobStatusName
  params: Record<string, unknown>
  progress: { done: number; total: number; message: string }
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  result: Record<string, unknown> | null
  cancel_message?: string
}

export const TERMINAL_JOB = new Set<JobStatusName>(['completed', 'failed', 'cancelled', 'interrupted'])

export interface WorkbenchStatus {
  available: boolean
  active_job: { kind: string; job_id: string | null } | null
  free_ram_mb: number | null
  runtime: Record<string, string | number | null>
}

export const modelsApi = {
  list: () => request<LocalModel[]>('/api/models'),
  predict: (modelId: string, analysisId: string, confidence: number, imageSize: number) =>
    request<{
      model_id: string
      analysis_id: string
      image_width: number
      image_height: number
      inference_ms: number
      load_ms: number | null
      detections: Detection[]
    }>(`/api/models/predict/${enc(analysisId)}?model_id=${enc(modelId)}`, json({ confidence, image_size: imageSize })),
  unregister: (modelId: string) => request<void>(`/api/models/${enc(modelId)}`, { method: 'DELETE' }),
}

export const jobsApi = {
  status: () => request<WorkbenchStatus>('/api/workbench/status'),
  list: (kind?: string) => request<WorkbenchJob[]>(`/api/workbench/jobs${kind ? `?kind=${enc(kind)}` : ''}`),
  get: (id: string) => request<WorkbenchJob>(`/api/workbench/jobs/${enc(id)}`),
  cancel: (id: string) => request<WorkbenchJob>(`/api/workbench/jobs/${enc(id)}/cancel`, { method: 'POST' }),
}

// -- benchmark --------------------------------------------------------------------

export interface LatencyStats {
  n: number
  mean: number | null
  median: number | null
  stdev: number | null
  min: number | null
  max: number | null
}

export interface BenchConfigResult {
  model_id: string
  confidence: number
  image_size: number
  taxonomy_size: number
  load_ms: number | null
  first_ms: number | null
  warm: LatencyStats
  all: LatencyStats
  timings: { analysis_id: string; repeat: number; ms: number }[]
  per_image: { analysis_id: string; filename: string; detections: number; categories: Record<string, number>; mean_confidence: number | null }[]
  detections_total: number
  categories: Record<string, number>
  confidence_stats: LatencyStats & { below_50: number }
}

export interface BenchmarkRun {
  run_id: string
  name: string
  created_at: string
  comparison_type: 'model' | 'configuration'
  comparison_note: string
  images: { analysis_id: string; filename: string; width: number; height: number }[]
  repeats: number
  configs: BenchConfigResult[]
  complete: boolean
  runtime: Record<string, string | number | null>
  caveats: string[]
}

export interface BenchmarkListItem {
  run_id: string
  name: string
  created_at: string
  comparison_type: string
  repeats: number
  complete: boolean
  configs: number
  images: number
}

export const benchmarksApi = {
  start: (body: {
    name: string
    configs: { model_id: string; confidence: number; image_size: number }[]
    analysis_ids: string[]
    repeats: number
    confirm: boolean
  }) => request<WorkbenchJob>('/api/benchmarks', json(body)),
  list: () => request<BenchmarkListItem[]>('/api/benchmarks'),
  get: (id: string) => request<BenchmarkRun>(`/api/benchmarks/${enc(id)}`),
  remove: (id: string) => request<void>(`/api/benchmarks/${enc(id)}`, { method: 'DELETE' }),
}

// -- evaluation -----------------------------------------------------------------------

export interface EvalBody {
  dataset_id: string
  version: number
  split: string
  model_id: string
  operating_confidence: number
  image_size: number
  confirm?: boolean
}

export interface ClassMetric {
  class_id: number
  label: string
  gt_instances: number
  tp: number
  fp: number
  fn: number
  precision: number | null
  recall: number | null
  f1: number | null
  ap50: number | null
  ap50_95: number | null
}

export interface EvalBox {
  x1: number
  y1: number
  x2: number
  y2: number
  conf: number
  class_id: number
}

export interface EvalExample {
  image_id: string
  filename: string
  width: number
  height: number
  sha256: string
  format: string
  tp: { class_id: number; pred: EvalBox; gt: EvalBox; iou: number }[]
  fp: { class_id: number; pred: EvalBox }[]
  fn: { class_id: number; gt: EvalBox }[]
  gt_count: number
  pred_count: number
}

export interface EvalMetrics {
  images: number
  gt_instances: number
  operating_confidence: number
  map50: number | null
  map50_95: number | null
  micro: { precision: number | null; recall: number | null; f1: number | null; tp: number; fp: number; fn: number }
  macro: { precision: number | null; recall: number | null; f1: number | null }
  per_class: ClassMetric[]
  confusion: { labels: string[]; matrix: number[][] }
  examples: EvalExample[]
}

export interface EvalBias {
  gt_boxes: number
  unedited_from_this_model: number
  unedited_share: number
  human_changes: number
  circular: boolean
  biased: boolean
}

export interface EvaluationRun {
  run_id: string
  created_at: string
  dataset_id: string
  dataset_name: string
  version: number
  split: string
  model_id: string
  model_file: string
  image_size: number
  inference_confidence: number
  iou_policy: string
  complete: boolean
  load_ms: number | null
  mean_inference_ms: number | null
  out_of_taxonomy_predictions: number
  bias: EvalBias
  metrics: EvalMetrics
  notes: string[]
}

export interface EvaluationListItem {
  run_id: string
  created_at: string
  dataset_name: string
  version: number
  split: string
  model_id: string
  images: number
  map50: number | null
  map50_95: number | null
  f1: number | null
  complete: boolean
  biased: boolean
}

export const evaluationsApi = {
  preflight: (body: EvalBody) =>
    request<{ ok: boolean; reasons: string[]; images: number; bias: EvalBias; classes: string[]; model_file: string }>(
      '/api/evaluations/preflight',
      json(body),
    ),
  start: (body: EvalBody) => request<WorkbenchJob>('/api/evaluations', json({ ...body, confirm: true })),
  list: () => request<EvaluationListItem[]>('/api/evaluations'),
  get: (id: string) => request<EvaluationRun>(`/api/evaluations/${enc(id)}`),
  remove: (id: string) => request<void>(`/api/evaluations/${enc(id)}`, { method: 'DELETE' }),
}

// -- drift ------------------------------------------------------------------------------

export type DriftStatus = 'stable' | 'moderate' | 'major' | 'insufficient'

export interface DriftMetric {
  key: string
  label: string
  status: DriftStatus
  statistic: string
  value: number | null
  p_value?: number | null
  js_distance?: number
  summary: string
  baseline_n: number
  comparison_n: number
  baseline_mean?: number
  comparison_mean?: number
  unit?: string
  changes?: { label: string; baseline_share: number; comparison_share: number }[]
}

export interface DriftWindow {
  start: string
  end: string
  scans: number
  all_scans: number
  detections: number
  configs: Record<string, number>
  quality_coverage: number
  evidence: { analysis_id: string; filename: string; created_at: string }[]
}

export interface DriftResult {
  baseline: DriftWindow
  comparison: DriftWindow
  compatible: boolean
  compatibility: 'compatible' | 'incompatible' | 'unknown'
  compatibility_note: string
  metrics: Record<string, DriftMetric>
  trend: { date: string; scans: number; detections_per_scan: number; mean_confidence: number | null }[]
  method: { min_scans: number; min_detections: number; psi_bands: number[]; ks_p_threshold: number; ks_d_bands: number[] }
  disclaimer: string
}

export const driftApi = {
  analyze: (w: { baseline_start: string; baseline_end: string; comparison_start: string; comparison_end: string }) =>
    request<DriftResult>('/api/drift/analyze', json(w)),
}

// -- training -------------------------------------------------------------------------------

export interface TrainParams {
  dataset_id: string
  version: number
  base_model_id: string
  epochs: number
  image_size: number
  batch: number
  patience: number
  seed: number
  name: string
}

export interface TrainingPlan {
  ready: boolean
  blockers: string[]
  warnings: string[]
  dataset: { name: string; version: number; classes: string[]; train_images: number; val_images: number }
  base_model: string
  estimate: { duration_s: [number, number]; ram_mb: [number, number]; free_ram_mb: number | null; disk_mb: number; note: string }
  active_job: string | null
}

export interface TrainingListItem {
  run_id: string
  name: string
  created_at: string
  status: JobStatusName
  dataset_name: string
  version: number
  base_model_id: string
  epochs: number
  epochs_completed: number
  map50: number | null
  map50_95: number | null
  registered_model_id: string | null
}

export interface TrainingRun {
  run_id: string
  name: string
  created_at: string
  dataset_id: string
  dataset_name: string
  version: number
  classes: string[]
  base_model_id: string
  config: Record<string, string | number>
  status: JobStatusName
  error?: string | null
  exit_code?: number
  finished_at?: string
  artifacts: { name: string; size_mb: number }[]
  metrics: Record<string, number>[]
  log_tail?: string
  worker_status?: { epoch?: number; message?: string }
  registered_model_id: string | null
}

export const trainingApi = {
  plan: (p: TrainParams) => request<TrainingPlan>('/api/training/plan', json(p)),
  start: (p: TrainParams) =>
    request<WorkbenchJob>('/api/training', json({ ...p, confirm: true, acknowledge_resources: true })),
  list: () => request<TrainingListItem[]>('/api/training'),
  get: (id: string) => request<TrainingRun>(`/api/training/${enc(id)}`),
  config: (id: string) => request<Record<string, unknown>>(`/api/training/${enc(id)}/config`),
  register: (id: string, name: string) =>
    request<{ model_id: string }>(`/api/training/${enc(id)}/register`, json({ name, confirm: true })),
}

// -- saved views -------------------------------------------------------------------------------

export interface SavedItem<T> {
  id: string
  updated_at: string
  data: T & { saved_at: string }
}

export const savedApi = {
  list: <T,>(kind: 'batch' | 'drift_config') => request<SavedItem<T>[]>(`/api/saved/${kind}`),
  put: <T,>(kind: 'batch' | 'drift_config', id: string, data: T) =>
    request<SavedItem<T>>(`/api/saved/${kind}/${enc(id)}`, json(data, 'PUT')),
  remove: (kind: 'batch' | 'drift_config', id: string) =>
    request<void>(`/api/saved/${kind}/${enc(id)}`, { method: 'DELETE' }),
}

export function thumbnail(analysisId: string, size = 256) {
  return requestBlob(`/api/analyses/${enc(analysisId)}/thumbnail?size=${size}`)
}

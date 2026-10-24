/**
 * Every derived number VisionIQ displays is computed here.
 *
 * Dashboard KPIs, timeline trends, the confidence explorer, explainability
 * charts, comparisons and PDF reports all call these functions, so a count
 * can never disagree between two screens. Nothing in this module fetches,
 * renders or invents data: each function takes real analysis records and
 * returns a plain value.
 *
 * Vocabulary is deliberate. These are counts of MODEL DETECTIONS, not
 * inventory: the default model is a generic COCO-80 detector that sees
 * "bottle", not a product, and can miss or double-count occluded objects.
 */

import type {
  AnalysisRecord,
  CategoryDelta,
  ComparisonResult,
  Detection,
} from '../types'

/** Mirrors backend `LOW_CONFIDENCE_THRESHOLD` in services/retail/intelligence.py. */
export const LOW_CONFIDENCE = 0.5

/** The backend's default inference threshold (`VISIONIQ_CONFIDENCE`). */
export const DEFAULT_INFERENCE_THRESHOLD = 0.25

/** Mirrors backend `GENERIC_TAXONOMY_CAVEAT`. */
export const GENERIC_TAXONOMY_CAVEAT =
  'Labels come from a generic COCO-80 taxonomy, not a retail product ' +
  'catalogue. Counts reflect detected objects, not verified stock levels.'

// ---------------------------------------------------------------------------
// Scan outcome
// ---------------------------------------------------------------------------

/**
 * What actually happened to a scan.
 *
 *   analyzed     the model ran and returned detections
 *   empty        the model ran and found nothing above its threshold
 *   unavailable  no model ran at all — NOT the same as an empty shelf
 *   failed       the job or inference failed
 *   pending      queued or processing (cloud only)
 */
export type ScanOutcome = 'analyzed' | 'empty' | 'unavailable' | 'failed' | 'pending'

export function scanOutcome(record: AnalysisRecord): ScanOutcome {
  if (record.status === 'queued' || record.status === 'processing') return 'pending'
  if (record.status === 'failed' || record.status === 'cancelled') return 'failed'
  const status = record.detection?.status
  if (!record.detection || status === 'unavailable') return 'unavailable'
  if (status === 'failed') return 'failed'
  if (status === 'empty' || record.detection.detections.length === 0) return 'empty'
  return 'analyzed'
}

/**
 * Whether a scan counts as a successful analysis.
 *
 * Only scans where the model genuinely ran contribute to detection metrics.
 * A scan where no model was available contributes zero detections — but
 * counting it would make an outage look like an empty store.
 */
export function isSuccessfulAnalysis(record: AnalysisRecord): boolean {
  const outcome = scanOutcome(record)
  return outcome === 'analyzed' || outcome === 'empty'
}

/** The threshold the model itself applied. Detections below it do not exist. */
export function inferenceThreshold(record: AnalysisRecord | null | undefined): number {
  const t = record?.detection?.confidence_threshold
  return typeof t === 'number' && Number.isFinite(t) ? t : DEFAULT_INFERENCE_THRESHOLD
}

// ---------------------------------------------------------------------------
// Detection-level statistics
// ---------------------------------------------------------------------------

/**
 * Filter detections the model already returned.
 *
 * Raising the threshold hides weaker detections; it can never reveal objects
 * the model dropped below its own inference threshold — that needs a re-run.
 */
export function filterByThreshold(
  detections: readonly Detection[],
  threshold: number,
): Detection[] {
  return detections.filter((d) => d.confidence >= threshold)
}

export interface CategoryStat {
  label: string
  count: number
  /** Fraction of all detections in the set, 0..1. */
  share: number
  meanConfidence: number
  minConfidence: number
  maxConfidence: number
}

export interface DetectionSummary {
  count: number
  categories: CategoryStat[]
  meanConfidence: number | null
  minConfidence: number | null
  maxConfidence: number | null
  lowConfidenceCount: number
}

export function summarizeDetections(
  detections: readonly Detection[],
): DetectionSummary {
  const buckets = new Map<string, number[]>()
  for (const d of detections) {
    const list = buckets.get(d.label)
    if (list) list.push(d.confidence)
    else buckets.set(d.label, [d.confidence])
  }

  const total = detections.length
  const categories: CategoryStat[] = [...buckets.entries()].map(([label, confs]) => ({
    label,
    count: confs.length,
    share: total ? confs.length / total : 0,
    meanConfidence: mean(confs),
    minConfidence: Math.min(...confs),
    maxConfidence: Math.max(...confs),
  }))
  // Same ordering as the backend: most frequent first, then alphabetical.
  categories.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  const confs = detections.map((d) => d.confidence)
  return {
    count: total,
    categories,
    meanConfidence: total ? mean(confs) : null,
    minConfidence: total ? Math.min(...confs) : null,
    maxConfidence: total ? Math.max(...confs) : null,
    lowConfidenceCount: detections.filter((d) => d.confidence < LOW_CONFIDENCE).length,
  }
}

export interface HistogramBin {
  /** Inclusive lower edge. */
  start: number
  /** Exclusive upper edge (inclusive for the last bin, which ends at 1). */
  end: number
  count: number
}

/**
 * Confidence histogram from `floor` to 1.0.
 *
 * `floor` should be the inference threshold: bins below it would always be
 * empty, and drawing them would wrongly suggest the model found nothing there
 * when it simply never reported anything that low.
 */
export function confidenceHistogram(
  detections: readonly Detection[],
  floor: number,
  step = 0.05,
): HistogramBin[] {
  const start = Math.max(0, Math.floor(floor / step + 1e-9) * step)
  const bins: HistogramBin[] = []
  for (let lo = start; lo < 1 - 1e-9; lo += step) {
    bins.push({ start: round(lo), end: round(Math.min(1, lo + step)), count: 0 })
  }
  if (bins.length === 0) bins.push({ start: round(start), end: 1, count: 0 })

  for (const d of detections) {
    let i = Math.floor((d.confidence - start) / step + 1e-9)
    if (i < 0) i = 0
    if (i >= bins.length) i = bins.length - 1
    bins[i].count++
  }
  return bins
}

/** A box's area as a fraction of the original image area, 0..1. */
export function boxAreaShare(d: Detection, imageWidth: number, imageHeight: number): number {
  const area = imageWidth * imageHeight
  if (area <= 0) return 0
  return Math.min(1, Math.max(0, (d.box.width * d.box.height) / area))
}

export interface SizeBin {
  label: string
  /** Inclusive lower edge, fraction of image area. */
  min: number
  /** Exclusive upper edge. */
  max: number
  count: number
}

const SIZE_EDGES = [0, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, Infinity]

/** How large detections are relative to the image. */
export function sizeDistribution(
  detections: readonly Detection[],
  imageWidth: number,
  imageHeight: number,
): SizeBin[] {
  const bins: SizeBin[] = SIZE_EDGES.slice(0, -1).map((min, i) => {
    const max = SIZE_EDGES[i + 1]
    const label =
      max === Infinity ? `≥${pct(min)}` : min === 0 ? `<${pct(max)}` : `${pct(min)}–${pct(max)}`
    return { label, min, max, count: 0 }
  })
  for (const d of detections) {
    const share = boxAreaShare(d, imageWidth, imageHeight)
    const bin = bins.find((b) => share >= b.min && share < b.max) ?? bins[bins.length - 1]
    bin.count++
  }
  return bins
}

// ---------------------------------------------------------------------------
// Dataset-level statistics (dashboard, timeline)
// ---------------------------------------------------------------------------

export type DateRange = '24h' | '7d' | '30d' | 'all'

export const DATE_RANGES: { value: DateRange; label: string }[] = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
]

const RANGE_VALUES = new Set<string>(DATE_RANGES.map((r) => r.value))

/** Parse a `range` URL parameter, falling back for missing or unknown values. */
export function parseDateRange(value: string | null | undefined, fallback: DateRange = '30d'): DateRange {
  return value && RANGE_VALUES.has(value) ? (value as DateRange) : fallback
}

const RANGE_MS: Record<Exclude<DateRange, 'all'>, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
}

export function rangeStart(range: DateRange, now: Date = new Date()): Date | null {
  return range === 'all' ? null : new Date(now.getTime() - RANGE_MS[range])
}

export function createdAt(record: { created_at: string }): Date {
  return new Date(record.created_at)
}

export function inRange(
  record: { created_at: string },
  range: DateRange,
  now: Date = new Date(),
): boolean {
  const start = rangeStart(range, now)
  if (!start) return true
  const t = createdAt(record).getTime()
  return t >= start.getTime() && t <= now.getTime() + 60_000
}

export interface DatasetStats {
  /** Every scan in range, whatever happened to it. */
  totalScans: number
  /** Scans where the model genuinely ran. */
  analyzedScans: number
  emptyScans: number
  unavailableScans: number
  failedScans: number
  pendingScans: number
  /** Model detections across analyzed scans. NOT an inventory count. */
  totalDetections: number
  categories: CategoryStat[]
  meanConfidence: number | null
  lowConfidenceCount: number
  /** Analyzed scans with at least one low-confidence detection. */
  scansNeedingReview: number
  latest: AnalysisRecord | null
}

/** Aggregate a set of records. Detection metrics use analyzed scans only. */
export function datasetStats(
  records: readonly AnalysisRecord[],
  range: DateRange = 'all',
  now: Date = new Date(),
): DatasetStats {
  const scoped = records.filter((r) => inRange(r, range, now))
  const analyzed = scoped.filter(isSuccessfulAnalysis)
  const detections = analyzed.flatMap((r) => r.detection?.detections ?? [])
  const summary = summarizeDetections(detections)

  const count = (o: ScanOutcome) => scoped.filter((r) => scanOutcome(r) === o).length

  return {
    totalScans: scoped.length,
    analyzedScans: analyzed.length,
    emptyScans: count('empty'),
    unavailableScans: count('unavailable'),
    failedScans: count('failed'),
    pendingScans: count('pending'),
    totalDetections: summary.count,
    categories: summary.categories,
    meanConfidence: summary.meanConfidence,
    lowConfidenceCount: summary.lowConfidenceCount,
    scansNeedingReview: analyzed.filter((r) =>
      (r.detection?.detections ?? []).some((d) => d.confidence < LOW_CONFIDENCE),
    ).length,
    latest: sortNewestFirst(scoped)[0] ?? null,
  }
}

export function sortNewestFirst<T extends { created_at: string }>(records: readonly T[]): T[] {
  return [...records].sort(
    (a, b) => createdAt(b).getTime() - createdAt(a).getTime(),
  )
}

/** Local-timezone calendar key, e.g. 2026-10-23. */
export function localDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export interface TrendPoint {
  /** Local date key of the bucket's first day. */
  key: string
  start: Date
  scans: number
  analyzedScans: number
  detections: number
}

/**
 * Detections and scans per local day (or per week for long spans).
 *
 * Gaps are filled with zero buckets so the time axis is honest: a quiet day
 * shows as zero rather than silently vanishing between two busy ones.
 */
export function detectionTrend(
  records: readonly AnalysisRecord[],
  options: { maxDailyBuckets?: number } = {},
): { points: TrendPoint[]; bucket: 'day' | 'week' } {
  const maxDaily = options.maxDailyBuckets ?? 45
  if (records.length === 0) return { points: [], bucket: 'day' }

  const dates = records.map(createdAt)
  const first = startOfLocalDay(new Date(Math.min(...dates.map((d) => d.getTime()))))
  const last = startOfLocalDay(new Date(Math.max(...dates.map((d) => d.getTime()))))
  const spanDays = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1
  const bucket: 'day' | 'week' = spanDays > maxDaily ? 'week' : 'day'

  const keyFor = (d: Date) =>
    localDateKey(bucket === 'day' ? startOfLocalDay(d) : startOfLocalWeek(d))

  const map = new Map<string, TrendPoint>()
  let cursor = bucket === 'day' ? first : startOfLocalWeek(first)
  const end = bucket === 'day' ? last : startOfLocalWeek(last)
  while (cursor.getTime() <= end.getTime()) {
    const key = localDateKey(cursor)
    map.set(key, { key, start: new Date(cursor), scans: 0, analyzedScans: 0, detections: 0 })
    cursor = addLocalDays(cursor, bucket === 'day' ? 1 : 7)
  }

  for (const r of records) {
    const point = map.get(keyFor(createdAt(r)))
    if (!point) continue
    point.scans++
    if (isSuccessfulAnalysis(r)) {
      point.analyzedScans++
      point.detections += r.detection?.detections.length ?? 0
    }
  }
  return { points: [...map.values()], bucket }
}

// ---------------------------------------------------------------------------
// Inspection alerts — derived only from what the records actually say
// ---------------------------------------------------------------------------

export type AlertSeverity = 'critical' | 'warning' | 'info'

export interface InspectionAlert {
  id: string
  severity: AlertSeverity
  kind: 'failed' | 'unavailable' | 'timeout' | 'cap' | 'low-confidence' | 'empty'
  title: string
  detail: string
  analysisId: string
  filename: string
  createdAt: string
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 }

export function inspectionAlerts(records: readonly AnalysisRecord[]): InspectionAlert[] {
  const alerts: InspectionAlert[] = []
  for (const r of records) {
    const base = {
      analysisId: r.analysis_id,
      filename: r.image.filename,
      createdAt: r.created_at,
    }
    const outcome = scanOutcome(r)

    if (outcome === 'failed') {
      alerts.push({
        ...base,
        id: `${r.analysis_id}:failed`,
        severity: 'critical',
        kind: 'failed',
        title: 'Analysis failed',
        detail: r.error ?? 'The scan did not complete. No results were produced.',
      })
      continue
    }
    if (outcome === 'unavailable') {
      alerts.push({
        ...base,
        id: `${r.analysis_id}:unavailable`,
        severity: 'warning',
        kind: 'unavailable',
        title: 'No model ran',
        detail:
          'Detection was unavailable, so nothing was analysed. This is not ' +
          'evidence of an empty shelf.',
      })
      continue
    }

    const detection = r.detection
    if (!detection) continue

    if (detection.status === 'timeout') {
      alerts.push({
        ...base,
        id: `${r.analysis_id}:timeout`,
        severity: 'warning',
        kind: 'timeout',
        title: 'Inference exceeded its time budget',
        detail: 'Results were returned but this run should be treated as degraded.',
      })
    }
    if (detection.warnings.some((w) => /cap of \d+/i.test(w))) {
      alerts.push({
        ...base,
        id: `${r.analysis_id}:cap`,
        severity: 'warning',
        kind: 'cap',
        title: 'Detection cap reached',
        detail: 'The model hit its maximum detection count; some objects may be missing.',
      })
    }

    const low = detection.detections.filter((d) => d.confidence < LOW_CONFIDENCE).length
    if (low > 0) {
      alerts.push({
        ...base,
        id: `${r.analysis_id}:low`,
        severity: 'info',
        kind: 'low-confidence',
        title: `${low} low-confidence detection${low === 1 ? '' : 's'}`,
        detail: `Below ${Math.round(LOW_CONFIDENCE * 100)}% confidence — verify visually before relying on them.`,
      })
    }
    if (outcome === 'empty') {
      alerts.push({
        ...base,
        id: `${r.analysis_id}:empty`,
        severity: 'info',
        kind: 'empty',
        title: 'No objects above the threshold',
        detail: `The model ran but reported nothing at ≥${Math.round(
          inferenceThreshold(r) * 100,
        )}%. A clearer photo may help.`,
      })
    }
  }
  return alerts.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
}

// ---------------------------------------------------------------------------
// Comparison — a faithful port of backend services/retail/intelligence.compare
// ---------------------------------------------------------------------------

export interface ConfidenceDelta {
  label: string
  before: number | null
  after: number | null
  /** after − before, in confidence units (0..1). Null if either side is missing. */
  delta: number | null
}

export interface ScanComparison extends ComparisonResult {
  threshold: number
  confidence: ConfidenceDelta[]
  meanBefore: number | null
  meanAfter: number | null
  /** Image dimensions differ, so a wipe overlay cannot be pixel-aligned. */
  dimensionsDiffer: boolean
}

/**
 * Compare two scans' detections at a common threshold.
 *
 * At the default threshold this reproduces the backend's `compare()` exactly:
 * same deltas, same ordering, same notable-change wording, same caveats. The
 * threshold parameter exists because the backend can only compare the full
 * detection sets.
 */
export function compareRecords(
  base: AnalysisRecord,
  target: AnalysisRecord,
  threshold?: number,
): ScanComparison {
  const t = threshold ?? Math.max(inferenceThreshold(base), inferenceThreshold(target))
  const beforeSet = filterByThreshold(base.detection?.detections ?? [], t)
  const afterSet = filterByThreshold(target.detection?.detections ?? [], t)
  const before = summarizeDetections(beforeSet)
  const after = summarizeDetections(afterSet)

  const beforeCounts = new Map(before.categories.map((c) => [c.label, c]))
  const afterCounts = new Map(after.categories.map((c) => [c.label, c]))
  const labels = [...new Set([...beforeCounts.keys(), ...afterCounts.keys()])].sort()

  const categories: CategoryDelta[] = labels.map((label) => {
    const b = beforeCounts.get(label)?.count ?? 0
    const a = afterCounts.get(label)?.count ?? 0
    return { label, before: b, after: a, delta: a - b }
  })
  categories.sort(
    (x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.label.localeCompare(y.label),
  )

  const baseModel = base.detection?.model.name ?? null
  const targetModel = target.detection?.model.name ?? null
  const comparable = baseModel === null || targetModel === null || baseModel === targetModel

  let notable = categories
    .filter((d) => d.delta !== 0)
    .map((d) => `${d.label}: ${d.before} -> ${d.after} (${d.delta > 0 ? '+' : ''}${d.delta})`)
    .slice(0, 10)
  if (notable.length === 0) {
    notable = ['No change in detected category counts between the two scans.']
  }

  const caveats = [
    'A change in detected counts can reflect lighting, angle, or occlusion ' +
      'differences rather than an actual change in stock.',
    GENERIC_TAXONOMY_CAVEAT,
  ]
  if (!comparable) {
    caveats.unshift(
      `The two scans used different models (${baseModel} vs ${targetModel}); ` +
        'their label spaces may not align, so deltas may be misleading.',
    )
  }

  const confidence: ConfidenceDelta[] = labels.map((label) => {
    const b = beforeCounts.get(label)?.meanConfidence ?? null
    const a = afterCounts.get(label)?.meanConfidence ?? null
    return { label, before: b, after: a, delta: a !== null && b !== null ? a - b : null }
  })

  return {
    base_analysis_id: base.analysis_id,
    target_analysis_id: target.analysis_id,
    comparable,
    categories,
    total_before: before.count,
    total_after: after.count,
    total_delta: after.count - before.count,
    notable_changes: notable,
    caveats,
    threshold: t,
    confidence,
    meanBefore: before.meanConfidence,
    meanAfter: after.meanConfidence,
    dimensionsDiffer:
      base.image.width !== target.image.width || base.image.height !== target.image.height,
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

function pct(v: number): string {
  const p = v * 100
  return `${p < 1 ? p.toFixed(1) : Math.round(p)}%`
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function startOfLocalWeek(d: Date): Date {
  const day = startOfLocalDay(d)
  const offset = (day.getDay() + 6) % 7 // Monday = 0
  return addLocalDays(day, -offset)
}

function addLocalDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)
}

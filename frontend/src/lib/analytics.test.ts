import { describe, expect, it } from 'vitest'
import {
  boxAreaShare,
  compareRecords,
  confidenceHistogram,
  datasetStats,
  detectionTrend,
  filterByThreshold,
  GENERIC_TAXONOMY_CAVEAT,
  inferenceThreshold,
  inRange,
  inspectionAlerts,
  isSuccessfulAnalysis,
  localDateKey,
  LOW_CONFIDENCE,
  scanOutcome,
  sizeDistribution,
  summarizeDetections,
} from './analytics'
import { makeDetection, makeRecord } from '../test/fixtures'
import type { AnalysisRecord } from '../types'

const NOW = new Date('2026-10-23T12:00:00Z')

function at(record: AnalysisRecord, iso: string): AnalysisRecord {
  return { ...record, created_at: iso }
}

function withStatus(
  record: AnalysisRecord,
  status: 'ok' | 'empty' | 'unavailable' | 'failed' | 'timeout',
): AnalysisRecord {
  return { ...record, detection: { ...record.detection!, status } }
}

const shelf = [
  makeDetection(0, 'bottle', 0.92, [10, 10, 40, 90]),
  makeDetection(1, 'bottle', 0.81, [50, 10, 80, 90]),
  makeDetection(2, 'bottle', 0.31, [90, 10, 120, 90]),
  makeDetection(3, 'cup', 0.66, [130, 40, 170, 90]),
]

describe('scan outcome', () => {
  it('classifies a normal run as analyzed', () => {
    expect(scanOutcome(makeRecord(shelf))).toBe('analyzed')
  })

  it('classifies an empty run as empty, not failed', () => {
    expect(scanOutcome(makeRecord([]))).toBe('empty')
  })

  it('separates "no model ran" from "nothing found"', () => {
    // An outage must never be mistaken for an empty shelf.
    const r = withStatus(makeRecord([]), 'unavailable')
    expect(scanOutcome(r)).toBe('unavailable')
    expect(isSuccessfulAnalysis(r)).toBe(false)
  })

  it('does not count failed scans as successful analyses', () => {
    expect(isSuccessfulAnalysis({ ...makeRecord(shelf), status: 'failed' })).toBe(false)
    expect(isSuccessfulAnalysis(withStatus(makeRecord(shelf), 'failed'))).toBe(false)
  })

  it('treats queued and processing jobs as pending', () => {
    expect(scanOutcome({ ...makeRecord([]), status: 'queued' })).toBe('pending')
    expect(scanOutcome({ ...makeRecord([]), status: 'processing' })).toBe('pending')
  })

  it('reads the inference threshold from the record', () => {
    const r = makeRecord(shelf)
    r.detection!.confidence_threshold = 0.4
    expect(inferenceThreshold(r)).toBe(0.4)
    expect(inferenceThreshold(null)).toBe(0.25)
  })
})

describe('threshold filtering', () => {
  it('keeps detections at or above the threshold', () => {
    expect(filterByThreshold(shelf, 0.81).map((d) => d.id)).toEqual([0, 1])
  })

  it('is inclusive at the boundary', () => {
    expect(filterByThreshold(shelf, 0.92)).toHaveLength(1)
  })

  it('returns nothing above every detection', () => {
    expect(filterByThreshold(shelf, 0.99)).toEqual([])
  })
})

describe('summarizeDetections', () => {
  it('counts and orders categories like the backend', () => {
    const s = summarizeDetections(shelf)
    expect(s.count).toBe(4)
    expect(s.categories.map((c) => [c.label, c.count])).toEqual([
      ['bottle', 3],
      ['cup', 1],
    ])
    expect(s.categories[0].share).toBeCloseTo(0.75)
  })

  it('computes accurate confidence statistics', () => {
    const s = summarizeDetections(shelf)
    expect(s.meanConfidence).toBeCloseTo((0.92 + 0.81 + 0.31 + 0.66) / 4)
    expect(s.minConfidence).toBe(0.31)
    expect(s.maxConfidence).toBe(0.92)
  })

  it('counts low-confidence detections against the shared constant', () => {
    expect(LOW_CONFIDENCE).toBe(0.5)
    expect(summarizeDetections(shelf).lowConfidenceCount).toBe(1)
  })

  it('reports nulls, not zeros, for an empty set', () => {
    // A zero mean confidence would be a fabricated number.
    const s = summarizeDetections([])
    expect(s.count).toBe(0)
    expect(s.meanConfidence).toBeNull()
    expect(s.minConfidence).toBeNull()
    expect(s.categories).toEqual([])
  })
})

describe('confidenceHistogram', () => {
  it('starts at the inference threshold, not at zero', () => {
    const bins = confidenceHistogram(shelf, 0.25)
    expect(bins[0].start).toBe(0.25)
    expect(bins.at(-1)!.end).toBe(1)
  })

  it('places every detection in exactly one bin', () => {
    const bins = confidenceHistogram(shelf, 0.25)
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(shelf.length)
  })

  it('puts a perfect score in the last bin', () => {
    const bins = confidenceHistogram([makeDetection(0, 'a', 1)], 0.25)
    expect(bins.at(-1)!.count).toBe(1)
  })

  it('bins boundary values into the bin they start', () => {
    const bins = confidenceHistogram([makeDetection(0, 'a', 0.5)], 0.25)
    const hit = bins.find((b) => b.count === 1)!
    expect(hit.start).toBe(0.5)
  })

  it('returns all-empty bins for no detections', () => {
    expect(confidenceHistogram([], 0.25).every((b) => b.count === 0)).toBe(true)
  })
})

describe('size distribution', () => {
  it('measures area as a share of the original image', () => {
    const d = makeDetection(0, 'a', 0.9, [0, 0, 100, 50])
    expect(boxAreaShare(d, 200, 100)).toBeCloseTo(0.25)
  })

  it('accounts for every detection', () => {
    const bins = sizeDistribution(shelf, 400, 300)
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(shelf.length)
  })

  it('guards a zero-area image', () => {
    expect(boxAreaShare(shelf[0], 0, 0)).toBe(0)
  })
})

describe('datasetStats', () => {
  const records = [
    at(makeRecord(shelf, { analysis_id: 'a' }), '2026-10-23T10:00:00Z'),
    at(makeRecord([], { analysis_id: 'b' }), '2026-10-22T10:00:00Z'),
    at(withStatus(makeRecord([], { analysis_id: 'c' }), 'unavailable'), '2026-10-21T10:00:00Z'),
    at({ ...makeRecord(shelf, { analysis_id: 'd' }), status: 'failed' }, '2026-09-01T10:00:00Z'),
  ]

  it('counts only analyzed scans toward detection metrics', () => {
    const s = datasetStats(records, 'all', NOW)
    expect(s.totalScans).toBe(4)
    expect(s.analyzedScans).toBe(2) // shelf + empty
    expect(s.totalDetections).toBe(4) // the failed scan's detections are excluded
    expect(s.unavailableScans).toBe(1)
    expect(s.failedScans).toBe(1)
    expect(s.emptyScans).toBe(1)
  })

  it('respects the date range', () => {
    const s = datasetStats(records, '24h', NOW)
    expect(s.totalScans).toBe(1)
    expect(datasetStats(records, '7d', NOW).totalScans).toBe(3)
  })

  it('identifies scans needing review', () => {
    expect(datasetStats(records, 'all', NOW).scansNeedingReview).toBe(1)
  })

  it('returns honest empties for no data', () => {
    const s = datasetStats([], 'all', NOW)
    expect(s.totalScans).toBe(0)
    expect(s.meanConfidence).toBeNull()
    expect(s.latest).toBeNull()
  })

  it('reports the newest scan in range as latest', () => {
    expect(datasetStats(records, 'all', NOW).latest?.analysis_id).toBe('a')
  })

  it('excludes future-dated records beyond a small clock-skew allowance', () => {
    const future = at(makeRecord(shelf), '2030-01-01T00:00:00Z')
    expect(inRange(future, '24h', NOW)).toBe(false)
  })
})

describe('detectionTrend', () => {
  it('fills quiet days with zeros so the time axis is honest', () => {
    const records = [
      at(makeRecord(shelf), '2026-10-20T12:00:00Z'),
      at(makeRecord(shelf), '2026-10-23T12:00:00Z'),
    ]
    const { points, bucket } = detectionTrend(records)
    expect(bucket).toBe('day')
    expect(points).toHaveLength(4)
    expect(points.map((p) => p.detections)).toEqual([4, 0, 0, 4])
  })

  it('switches to weekly buckets over long spans', () => {
    const records = [
      at(makeRecord(shelf), '2026-01-01T12:00:00Z'),
      at(makeRecord(shelf), '2026-10-01T12:00:00Z'),
    ]
    expect(detectionTrend(records).bucket).toBe('week')
  })

  it('counts failed scans but not their detections', () => {
    const records = [at({ ...makeRecord(shelf), status: 'failed' }, '2026-10-23T12:00:00Z')]
    const [point] = detectionTrend(records).points
    expect(point.scans).toBe(1)
    expect(point.analyzedScans).toBe(0)
    expect(point.detections).toBe(0)
  })

  it('is empty for no records', () => {
    expect(detectionTrend([]).points).toEqual([])
  })

  it('keys buckets by local calendar date', () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('inspectionAlerts', () => {
  it('derives every alert from record contents', () => {
    const records = [
      makeRecord(shelf, { analysis_id: 'low' }),
      makeRecord([], { analysis_id: 'empty' }),
      withStatus(makeRecord([], { analysis_id: 'down' }), 'unavailable'),
      { ...makeRecord([], { analysis_id: 'broke' }), status: 'failed' as const, error: 'boom' },
    ]
    const kinds = inspectionAlerts(records).map((a) => `${a.analysisId}:${a.kind}`)
    expect(kinds).toEqual(
      expect.arrayContaining(['low:low-confidence', 'empty:empty', 'down:unavailable', 'broke:failed']),
    )
  })

  it('orders critical before warning before info', () => {
    const records = [
      makeRecord(shelf, { analysis_id: 'low' }),
      { ...makeRecord([], { analysis_id: 'broke' }), status: 'failed' as const },
    ]
    expect(inspectionAlerts(records)[0].severity).toBe('critical')
  })

  it('flags a detection-cap warning', () => {
    const r = makeRecord(shelf)
    r.detection!.warnings = ['Detection count hit the configured cap of 300; some objects may be missing.']
    expect(inspectionAlerts([r]).some((a) => a.kind === 'cap')).toBe(true)
  })

  it('raises nothing for a clean, confident scan', () => {
    const r = makeRecord([makeDetection(0, 'bottle', 0.95)])
    expect(inspectionAlerts([r])).toEqual([])
  })

  it('never calls an unavailable scan an empty shelf', () => {
    const [alert] = inspectionAlerts([withStatus(makeRecord([]), 'unavailable')])
    expect(alert.detail).toMatch(/not evidence of an empty shelf/i)
  })
})

describe('compareRecords — port of the backend compare()', () => {
  const before = makeRecord(
    [
      makeDetection(0, 'bottle', 0.9),
      makeDetection(1, 'bottle', 0.8),
      makeDetection(2, 'cup', 0.7),
    ],
    { analysis_id: 'before' },
  )
  const after = makeRecord(
    [makeDetection(0, 'bottle', 0.6), makeDetection(1, 'bowl', 0.9)],
    { analysis_id: 'after' },
  )

  it('computes deltas sorted by magnitude, then label', () => {
    const c = compareRecords(before, after)
    expect(c.categories.map((d) => [d.label, d.before, d.after, d.delta])).toEqual([
      ['bottle', 2, 1, -1],
      ['bowl', 0, 1, 1],
      ['cup', 1, 0, -1],
    ])
    expect(c.total_before).toBe(3)
    expect(c.total_after).toBe(2)
    expect(c.total_delta).toBe(-1)
  })

  it('uses the backend wording for notable changes', () => {
    expect(compareRecords(before, after).notable_changes[0]).toBe('bottle: 2 -> 1 (-1)')
  })

  it('reports no change honestly', () => {
    expect(compareRecords(before, before).notable_changes).toEqual([
      'No change in detected category counts between the two scans.',
    ])
  })

  it('always carries the backend caveats', () => {
    const { caveats } = compareRecords(before, after)
    expect(caveats).toContain(GENERIC_TAXONOMY_CAVEAT)
    expect(caveats.some((c) => /lighting, angle, or occlusion/.test(c))).toBe(true)
  })

  it('flags scans from different models as not comparable', () => {
    const other = makeRecord([], { analysis_id: 'x' })
    other.detection!.model = { ...other.detection!.model, name: 'yolov8x.pt' }
    const c = compareRecords(before, other)
    expect(c.comparable).toBe(false)
    expect(c.caveats[0]).toMatch(/different models/)
  })

  it('tracks mean-confidence changes per category', () => {
    const bottle = compareRecords(before, after).confidence.find((c) => c.label === 'bottle')!
    expect(bottle.before).toBeCloseTo(0.85)
    expect(bottle.after).toBeCloseTo(0.6)
    expect(bottle.delta).toBeCloseTo(-0.25)
  })

  it('reports null confidence change for a category on one side only', () => {
    const cup = compareRecords(before, after).confidence.find((c) => c.label === 'cup')!
    expect(cup.after).toBeNull()
    expect(cup.delta).toBeNull()
  })

  it('compares at a common threshold when asked', () => {
    const c = compareRecords(before, after, 0.85)
    expect(c.total_before).toBe(1)
    expect(c.total_after).toBe(1)
    expect(c.threshold).toBe(0.85)
  })

  it('notices when image dimensions differ', () => {
    const wide = makeRecord([], { analysis_id: 'w' })
    wide.image = { ...wide.image, width: 1000 }
    expect(compareRecords(before, wide).dimensionsDiffer).toBe(true)
    expect(compareRecords(before, after).dimensionsDiffer).toBe(false)
  })
})

/**
 * Demo-mode data access.
 *
 * HONESTY CONTRACT — the whole point of this module:
 *
 * Every detection served here was produced by a real YOLOv8n run on a
 * developer machine and captured verbatim by
 * `backend/scripts/generate_demo_fixtures.py`. Nothing is invented.
 *
 * But they are RECORDINGS, not live inference. Demo mode therefore:
 *   - never accepts a user's own image (it cannot analyse one, and
 *     pretending to would be the exact deception worth avoiding),
 *   - offers only the fixed samples these results belong to,
 *   - marks every record `execution_mode: "demo"` with a `demo-` id,
 *   - is announced by a banner the user cannot miss.
 *
 * Demo mode exists because no genuinely free host can run CPU YOLO
 * inference reliably — see docs/deployment/free-hosting.md.
 */

import type { AnalysisRecord, AnalysisSummary, ModelInfo } from '../types'
import fixture from './samples.json'

export interface DemoSample {
  id: string
  filename: string
  caption: string
  image_url: string
  record: AnalysisRecord
}

interface DemoFixture {
  _comment: string
  model: ModelInfo | null
  samples: DemoSample[]
}

const data = fixture as unknown as DemoFixture

export const DEMO_SAMPLES: readonly DemoSample[] = data.samples

/** The model that actually produced these recordings. */
export const DEMO_MODEL: ModelInfo | null = data.model

export function getDemoSample(id: string): DemoSample | undefined {
  return DEMO_SAMPLES.find((s) => s.id === id)
}

/** History rows for the samples, newest first — the same shape the API returns. */
export function demoHistory(): AnalysisSummary[] {
  return DEMO_SAMPLES.map((sample) => {
    const retail = sample.record.retail
    return {
      analysis_id: sample.record.analysis_id,
      created_at: sample.record.created_at,
      status: sample.record.status,
      filename: sample.filename,
      detection_count: retail?.total_detections ?? 0,
      distinct_categories: retail?.distinct_categories ?? 0,
      top_labels: (retail?.categories ?? []).slice(0, 3).map((c) => c.label),
      execution_mode: 'demo',
    }
  })
}

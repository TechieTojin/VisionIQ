/**
 * Demo-mode tests.
 *
 * Most of these guard the honesty contract rather than mechanics: demo mode
 * exists to show the project at zero cost, and its one hard requirement is
 * that nobody can mistake a recording for live inference.
 */

import { describe, expect, it } from 'vitest'
import { DemoAnalysisClient } from './demoClient'
import { DEMO_MODEL, DEMO_SAMPLES, demoHistory, getDemoSample } from './demoData'
import { resolveApiConfig } from '../api/config'

describe('demo fixtures', () => {
  it('bundles samples', () => {
    expect(DEMO_SAMPLES.length).toBeGreaterThan(0)
  })

  it('came from a real model run, not invented numbers', () => {
    // The generator script records whatever yolov8n actually produced.
    expect(DEMO_MODEL?.name).toBe('yolov8n.pt')
    expect(DEMO_MODEL?.provider).toBe('yolo')
    expect(DEMO_MODEL?.taxonomy).toBe('COCO-80')
  })

  it('marks every record as demo so it cannot pass for a real analysis', () => {
    for (const sample of DEMO_SAMPLES) {
      expect(sample.record.execution_mode).toBe('demo')
      expect(sample.record.analysis_id.startsWith('demo-')).toBe(true)
      expect(sample.record.owner_id).toBe('demo')
      // No storage key: nothing was uploaded anywhere.
      expect(sample.record.image_key).toBeNull()
    }
  })

  it('keeps detections internally consistent with the image', () => {
    for (const sample of DEMO_SAMPLES) {
      const detection = sample.record.detection
      expect(detection).toBeTruthy()
      if (!detection) continue

      expect(detection.detection_count).toBe(detection.detections.length)
      for (const d of detection.detections) {
        expect(d.confidence).toBeGreaterThanOrEqual(0)
        expect(d.confidence).toBeLessThanOrEqual(1)
        expect(d.box.x1).toBeLessThan(d.box.x2)
        expect(d.box.y1).toBeLessThan(d.box.y2)
        expect(d.box.x2).toBeLessThanOrEqual(detection.image_width)
        expect(d.box.y2).toBeLessThanOrEqual(detection.image_height)
      }
    }
  })

  it('preserves the "nothing detected" case rather than only flattering ones', () => {
    // A demo that only ever shows successful detections would misrepresent
    // the product. One sample genuinely found nothing.
    const empty = DEMO_SAMPLES.filter(
      (s) => (s.record.detection?.detection_count ?? 0) === 0,
    )
    expect(empty.length).toBeGreaterThan(0)
    expect(empty[0].record.detection?.status).toBe('empty')
  })

  it('still reports SKU recognition as unsupported', () => {
    for (const sample of DEMO_SAMPLES) {
      expect(sample.record.retail?.sku.status).toBe('unsupported')
      expect(sample.record.retail?.shelf_gaps.reliability).toBe('unsupported')
    }
  })

  it('carries no fabricated AI narrative', () => {
    for (const sample of DEMO_SAMPLES) {
      // Insights are the deterministic rule-based ones, never an LLM
      // narrative invented for the demo.
      expect(sample.record.insights?.source).toBe('rules')
    }
  })

  it('looks up a sample by id', () => {
    const first = DEMO_SAMPLES[0]
    expect(getDemoSample(first.id)?.filename).toBe(first.filename)
    expect(getDemoSample('nope')).toBeUndefined()
  })
})

describe('demo history', () => {
  it('mirrors the API summary shape', () => {
    const rows = demoHistory()
    expect(rows).toHaveLength(DEMO_SAMPLES.length)
    for (const row of rows) {
      expect(row).toHaveProperty('analysis_id')
      expect(row).toHaveProperty('detection_count')
      expect(row.execution_mode).toBe('demo')
    }
  })

  it('reports counts matching the records', () => {
    const rows = demoHistory()
    for (const row of rows) {
      const sample = DEMO_SAMPLES.find(
        (s) => s.record.analysis_id === row.analysis_id,
      )
      expect(row.detection_count).toBe(sample?.record.retail?.total_detections)
    }
  })
})

describe('DemoAnalysisClient', () => {
  const client = new DemoAnalysisClient()

  it('REFUSES to analyse a user-supplied image', async () => {
    // The central guarantee. Returning a canned result for a file the user
    // chose would read as "we analysed your image", which is false.
    await expect(client.analyze()).rejects.toThrow(/cannot be analysed here/i)
  })

  it('explains why and points at running it locally', async () => {
    await expect(client.analyze()).rejects.toThrow(/run visioniq locally/i)
  })

  it('replays a recorded sample unchanged', async () => {
    const sample = DEMO_SAMPLES[0]
    const record = await client.replay(sample.id)
    expect(record).toEqual(sample.record)
  })

  it('reports progress stages so the UI behaves normally', async () => {
    const stages: string[] = []
    await client.replay(DEMO_SAMPLES[0].id, (p) => stages.push(p.stage))
    expect(stages).toContain('processing')
    expect(stages.at(-1)).toBe('done')
  })

  it('falls back to the first sample for an unknown id', async () => {
    const record = await client.replay('does-not-exist')
    expect(record.analysis_id).toBe(DEMO_SAMPLES[0].record.analysis_id)
  })

  it('identifies itself as demo', () => {
    expect(client.mode).toBe('demo')
  })
})

describe('demo mode selection', () => {
  it('is opt-in via VITE_API_MODE', () => {
    expect(resolveApiConfig({ VITE_API_MODE: 'demo' } as ImportMetaEnv).mode).toBe(
      'demo',
    )
  })

  it('is never the default', () => {
    // A misconfigured deployment must not silently serve recordings.
    expect(resolveApiConfig({} as ImportMetaEnv).mode).toBe('local')
    expect(
      resolveApiConfig({ VITE_API_MODE: 'typo' } as ImportMetaEnv).mode,
    ).toBe('local')
  })
})

describe('demo mode defence in depth', () => {
  it('the factory never hands a demo build a live client', async () => {
    // Regression: the factory previously fell through to LocalAnalysisClient,
    // which would POST a user's image to an endpoint that does not exist on
    // a static deployment.
    const { getAnalysisClient, resetAnalysisClient } = await import(
      '../api/analysisClient'
    )
    resetAnalysisClient()

    const client = getAnalysisClient({
      mode: 'demo',
      baseUrl: '',
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
    })

    expect(client.mode).toBe('demo')
    await expect(
      Promise.resolve().then(() => client.analyze(new File([''], 'x.png'))),
    ).rejects.toThrow()

    resetAnalysisClient()
  })

  it('still returns the local client for local mode', async () => {
    const { getAnalysisClient, resetAnalysisClient } = await import(
      '../api/analysisClient'
    )
    resetAnalysisClient()
    expect(
      getAnalysisClient({
        mode: 'local',
        baseUrl: '',
        pollIntervalMs: 1,
        pollTimeoutMs: 1,
      }).mode,
    ).toBe('local')
    resetAnalysisClient()
  })
})

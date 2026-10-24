/**
 * Where scans come from, per API mode.
 *
 *   local  FastAPI     list/get/delete on /api/analyses, images on
 *                      /api/analyses/{id}/image
 *   cloud  API Gateway list/get/delete on /api/jobs — the canonical-contract
 *                      equivalents, returning the same AnalysisPage and
 *                      AnalysisRecord shapes. There is no image endpoint in
 *                      the Lambda control plane (images sit in a private
 *                      bucket), so cloud scans report their image as
 *                      unavailable rather than guessing a URL.
 *   demo   static      the recorded fixtures; images are bundled files
 *
 * Every page reads scans through this one interface, so no screen needs to
 * know which backend it is talking to.
 */

import { ApiError, request, requestBlob } from '../api/client'
import { resolveApiConfig, type ApiConfig, type ApiMode } from '../api/config'
import { DEMO_SAMPLES } from '../demo/demoData'
import type { AnalysisPage, AnalysisRecord, AnalysisSummary } from '../types'

export interface ScanSource {
  readonly mode: ApiMode
  /** Whether scans can be deleted (not in the read-only demo). */
  readonly canDelete: boolean
  /** Whether new images can be analysed from this deployment. */
  readonly canAnalyze: boolean
  listAll(cap: number): Promise<{ summaries: AnalysisSummary[]; truncated: boolean }>
  get(id: string): Promise<AnalysisRecord>
  /** Object or static URL for the scan's image, or null if unavailable. */
  loadImage(record: AnalysisRecord): Promise<string | null>
  remove(id: string): Promise<void>
}

/** Summaries are fetched in pages of this size (the backend's maximum). */
export const PAGE_LIMIT = 100

class HttpScanSource implements ScanSource {
  readonly canDelete = true
  readonly canAnalyze = true
  readonly mode: ApiMode
  private readonly config: ApiConfig
  private readonly base: string

  constructor(config: ApiConfig) {
    this.mode = config.mode
    this.config = config
    this.base = config.mode === 'cloud' ? '/api/jobs' : '/api/analyses'
  }

  async listAll(cap: number) {
    const summaries: AnalysisSummary[] = []
    let cursor: string | null = null
    let truncated = false

    for (;;) {
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) })
      if (cursor) query.set('cursor', cursor)
      const page = await request<AnalysisPage>(
        `${this.base}?${query.toString()}`,
        undefined,
        this.config,
      )
      summaries.push(...page.items)
      cursor = page.next_cursor
      if (!page.has_more || !cursor) break
      if (summaries.length >= cap) {
        truncated = true
        break
      }
    }
    return { summaries: summaries.slice(0, cap), truncated }
  }

  get(id: string) {
    return request<AnalysisRecord>(
      `${this.base}/${encodeURIComponent(id)}`,
      undefined,
      this.config,
    )
  }

  async loadImage(record: AnalysisRecord): Promise<string | null> {
    // Only the FastAPI backend serves stored images.
    if (this.mode !== 'local' || !record.image_key) return null
    const blob = await requestBlob(
      `/api/analyses/${encodeURIComponent(record.analysis_id)}/image`,
      this.config,
    )
    return blob ? URL.createObjectURL(blob) : null
  }

  remove(id: string) {
    return request<void>(
      `${this.base}/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      this.config,
    )
  }
}

class DemoScanSource implements ScanSource {
  readonly mode = 'demo' as const
  readonly canDelete = false
  readonly canAnalyze = false

  async listAll() {
    return {
      summaries: DEMO_SAMPLES.map((s) => summaryFromRecord(s.record)),
      truncated: false,
    }
  }

  async get(id: string) {
    const sample = DEMO_SAMPLES.find((s) => s.record.analysis_id === id)
    if (!sample) throw new ApiError(`Scan '${id}' was not found.`, '404')
    return sample.record
  }

  async loadImage(record: AnalysisRecord) {
    return DEMO_SAMPLES.find((s) => s.record.analysis_id === record.analysis_id)?.image_url ?? null
  }

  async remove(): Promise<void> {
    throw new ApiError('The demo is read-only.', 'demo_mode')
  }
}

export function createScanSource(config: ApiConfig = resolveApiConfig()): ScanSource {
  return config.mode === 'demo' ? new DemoScanSource() : new HttpScanSource(config)
}

/** The list-row projection of a full record — same shape the API returns. */
export function summaryFromRecord(record: AnalysisRecord): AnalysisSummary {
  const detections = record.detection?.detections ?? []
  const counts = new Map<string, number>()
  for (const d of detections) counts.set(d.label, (counts.get(d.label) ?? 0) + 1)
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([label]) => label)
  return {
    analysis_id: record.analysis_id,
    created_at: record.created_at,
    status: record.status,
    filename: record.image.filename,
    detection_count: detections.length,
    distinct_categories: counts.size,
    top_labels: top,
    execution_mode: record.execution_mode,
  }
}

/** Run `fn` over `items` with at most `limit` in flight. Order is preserved. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

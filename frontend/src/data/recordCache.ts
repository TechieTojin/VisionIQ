import type { AnalysisRecord } from '../types'
import type { ScanSource } from './scanSource'

/**
 * Completed records never change, so they are cached for the session across
 * page navigations. Queued/processing jobs are always re-fetched.
 */
export const recordCache = new Map<string, AnalysisRecord>()

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export function cacheKey(source: ScanSource, id: string): string {
  return `${source.mode}:${id}`
}

export function remember(source: ScanSource, record: AnalysisRecord): void {
  if (TERMINAL.has(record.status)) recordCache.set(cacheKey(source, record.analysis_id), record)
}

/** Test hook: forget cached records between tests. */
export function clearRecordCache(): void {
  recordCache.clear()
}

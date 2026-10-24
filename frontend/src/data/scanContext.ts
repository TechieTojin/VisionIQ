import { createContext } from 'react'
import type { AnalysisRecord, AnalysisSummary } from '../types'
import type { ScanSource } from './scanSource'

export type DatasetStatus = 'loading' | 'ready' | 'error'

export interface ScanDataValue {
  source: ScanSource
  status: DatasetStatus
  error: string | null
  /** Every scan the backend listed, newest first. */
  summaries: AnalysisSummary[]
  /** Full records loaded so far, in summary order. */
  records: AnalysisRecord[]
  /** True while full records are still being fetched. */
  recordsLoading: boolean
  /** More scans exist than were loaded (the history cap was reached). */
  truncated: boolean
  /** Maximum scans the analytics consider. */
  cap: number
  recordFor(id: string): AnalysisRecord | undefined
  /** Resolve a record, fetching it if it is not loaded yet. */
  ensureRecord(id: string): Promise<AnalysisRecord>
  /** Add or replace a record — e.g. the result of a new analysis. */
  upsert(record: AnalysisRecord): void
  remove(id: string): Promise<void>
  refresh(): void
}

export const ScanDataContext = createContext<ScanDataValue | null>(null)

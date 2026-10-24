import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import { sortNewestFirst } from '../lib/analytics'
import type { AnalysisRecord, AnalysisSummary } from '../types'
import { ScanDataContext, type DatasetStatus, type ScanDataValue } from './scanContext'
import { cacheKey, recordCache, remember } from './recordCache'
import { createScanSource, mapLimit, summaryFromRecord, type ScanSource } from './scanSource'

/** Analytics consider at most this many recent scans. Disclosed in the UI. */
export const HISTORY_CAP = 500

/** Concurrent record fetches. Gentle on a local backend doing inference. */
const RECORD_CONCURRENCY = 4


/**
 * Loads scan history once and shares it with every page.
 *
 * Summaries arrive first (one paginated list call) so the UI can render;
 * full records then stream in with bounded concurrency. Every chart and KPI
 * derives from these records through `lib/analytics`, so all screens agree.
 */
export function ScanDataProvider({
  children,
  source: injected,
}: {
  children: React.ReactNode
  source?: ScanSource
}) {
  const source = useMemo(() => injected ?? createScanSource(), [injected])

  const [status, setStatus] = useState<DatasetStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<AnalysisSummary[]>([])
  const [byId, setById] = useState<Record<string, AnalysisRecord>>({})
  const [pending, setPending] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false

    source
      .listAll(HISTORY_CAP)
      .then(({ summaries: listed, truncated: more }) => {
        if (cancelled) return
        const ordered = sortNewestFirst(listed)
        const cached: Record<string, AnalysisRecord> = {}
        const missing: AnalysisSummary[] = []
        for (const s of ordered) {
          const hit = recordCache.get(cacheKey(source, s.analysis_id))
          if (hit) cached[s.analysis_id] = hit
          else missing.push(s)
        }
        setSummaries(ordered)
        setTruncated(more)
        setById(cached)
        setPending(missing.length)
        setError(null)
        setStatus('ready')

        return mapLimit(missing, RECORD_CONCURRENCY, (s) =>
          source.get(s.analysis_id).then(
            (record) => {
              remember(source, record)
              if (!cancelled) {
                setById((prev) => ({ ...prev, [record.analysis_id]: record }))
                setPending((n) => Math.max(0, n - 1))
              }
              return record
            },
            (err: unknown) => {
              // One unreadable record must not hide every other scan.
              if (!cancelled) setPending((n) => Math.max(0, n - 1))
              throw err
            },
          ),
        )
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setStatus('error')
        setError(
          err instanceof ApiError ? err.message : 'Scan history could not be loaded.',
        )
      })

    return () => {
      cancelled = true
    }
  }, [source, reloadToken])

  const refresh = useCallback(() => {
    setStatus('loading')
    setReloadToken((n) => n + 1)
  }, [])

  const upsert = useCallback(
    (record: AnalysisRecord) => {
      remember(source, record)
      setById((prev) => ({ ...prev, [record.analysis_id]: record }))
      setSummaries((prev) =>
        sortNewestFirst([
          summaryFromRecord(record),
          ...prev.filter((s) => s.analysis_id !== record.analysis_id),
        ]),
      )
    },
    [source],
  )

  const ensureRecord = useCallback(
    async (id: string) => {
      const known = byId[id] ?? recordCache.get(cacheKey(source, id))
      if (known) return known
      const record = await source.get(id)
      remember(source, record)
      setById((prev) => ({ ...prev, [record.analysis_id]: record }))
      return record
    },
    [byId, source],
  )

  const remove = useCallback(
    async (id: string) => {
      await source.remove(id)
      recordCache.delete(cacheKey(source, id))
      setSummaries((prev) => prev.filter((s) => s.analysis_id !== id))
      setById((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    },
    [source],
  )

  const records = useMemo(
    () => summaries.map((s) => byId[s.analysis_id]).filter((r): r is AnalysisRecord => !!r),
    [summaries, byId],
  )

  const value = useMemo<ScanDataValue>(
    () => ({
      source,
      status,
      error,
      summaries,
      records,
      recordsLoading: status === 'ready' && pending > 0,
      truncated,
      cap: HISTORY_CAP,
      recordFor: (id) => byId[id],
      ensureRecord,
      upsert,
      remove,
      refresh,
    }),
    [source, status, error, summaries, records, pending, truncated, byId, ensureRecord, upsert, remove, refresh],
  )

  return <ScanDataContext.Provider value={value}>{children}</ScanDataContext.Provider>
}

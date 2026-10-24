import { useEffect, useState } from 'react'
import type { AnalysisRecord } from '../types'
import { useScanData } from './useScanData'

export type ImageStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

/**
 * Object URLs for scan images, shared across pages for the session.
 *
 * Bounded so a long browsing session cannot pin every image in memory: when
 * the cap is exceeded the oldest URL is revoked.
 */
const urls = new Map<string, string>()
const missing = new Set<string>()
const MAX_CACHED = 40

function remember(key: string, url: string): void {
  urls.delete(key)
  urls.set(key, url)
  missing.delete(key)
  while (urls.size > MAX_CACHED) {
    const [oldestKey, oldestUrl] = urls.entries().next().value as [string, string]
    urls.delete(oldestKey)
    if (oldestUrl.startsWith('blob:')) URL.revokeObjectURL(oldestUrl)
  }
}

/**
 * Register an image the browser already has — e.g. the file just uploaded —
 * so opening that scan never re-downloads it.
 */
export function primeScanImage(mode: string, analysisId: string, url: string): void {
  remember(`${mode}:${analysisId}`, url)
}

/** The display URL for a scan's original image, loaded on demand. */
export function useScanImage(record: AnalysisRecord | null | undefined): {
  url: string | null
  status: ImageStatus
} {
  const { source } = useScanData()
  const key = record ? `${source.mode}:${record.analysis_id}` : null
  const [state, setState] = useState<{ key: string | null; url: string | null; status: ImageStatus }>(
    { key: null, url: null, status: 'idle' },
  )

  useEffect(() => {
    if (!record || !key || urls.has(key) || missing.has(key)) return
    let cancelled = false
    source
      .loadImage(record)
      .then((url) => {
        if (url) remember(key, url)
        else missing.add(key)
        if (!cancelled) setState({ key, url, status: url ? 'ready' : 'unavailable' })
      })
      .catch(() => {
        if (!cancelled) setState({ key, url: null, status: 'unavailable' })
      })
    return () => {
      cancelled = true
    }
  }, [key, record, source])

  if (!record || !key) return { url: null, status: 'idle' }
  const cached = urls.get(key)
  if (cached) return { url: cached, status: 'ready' }
  if (missing.has(key)) return { url: null, status: 'unavailable' }
  if (state.key === key) return { url: state.url, status: state.status }
  return { url: null, status: 'loading' }
}

/** Test hook. */
export function clearImageCache(): void {
  urls.clear()
  missing.clear()
}

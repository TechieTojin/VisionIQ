/**
 * A dependency-free hash router.
 *
 * Hash routing because the app must work as a static bundle (Vercel demo
 * mode) with no server rewrites, and because the Cognito callback lands on
 * the bare origin with `?code=&state=` in the query string — a hash route
 * never collides with that.
 *
 *   #/dashboard
 *   #/analyze            #/analyze/<scan id>
 *   #/compare?a=<id>&b=<id>
 *   #/timeline?range=7d&category=bottle&outcome=review&q=shelf
 *   #/reports?scan=<id>  #/reports?a=<id>&b=<id>
 */

import { useSyncExternalStore } from 'react'

export type RouteName =
  | 'dashboard'
  | 'analyze'
  | 'batch'
  | 'compare'
  | 'timeline'
  | 'alerts'
  | 'reports'
  | 'ask'
  | 'annotate'
  | 'datasets'
  | 'quality'
  | 'benchmark'
  | 'evaluation'
  | 'drift'
  | 'training'

export interface Route {
  name: RouteName
  /** Path segment after the route name, e.g. a scan id. */
  id?: string
  params: URLSearchParams
}

export type RouteGroup = 'intel' | 'cv' | 'ml'

export const ROUTE_GROUPS: { id: RouteGroup; label: string }[] = [
  { id: 'intel', label: 'Retail Intelligence' },
  { id: 'cv', label: 'Computer Vision & Data' },
  { id: 'ml', label: 'ML Engineering' },
]

export const ROUTES: { name: RouteName; label: string; description: string; group: RouteGroup; localOnly?: boolean }[] = [
  { name: 'dashboard', label: 'Dashboard', description: 'Overview of every scan', group: 'intel' },
  { name: 'analyze', label: 'Analyze', description: 'Run detection and inspect a scan', group: 'intel' },
  { name: 'batch', label: 'Batch', description: 'Analyze many images in one queue', group: 'intel' },
  { name: 'compare', label: 'Compare', description: 'Before / after detections', group: 'intel' },
  { name: 'timeline', label: 'Timeline', description: 'Scan history and trends', group: 'intel' },
  { name: 'alerts', label: 'Alerts', description: 'Rule-based inspection alerts', group: 'intel', localOnly: true },
  { name: 'reports', label: 'Reports', description: 'Export inspection PDFs', group: 'intel' },
  { name: 'ask', label: 'Ask VisionIQ', description: 'Questions answered from your scan data', group: 'intel' },
  { name: 'annotate', label: 'Annotation Studio', description: 'Review and correct model boxes', group: 'cv', localOnly: true },
  { name: 'datasets', label: 'Datasets', description: 'Versioned, labelled image sets', group: 'cv', localOnly: true },
  { name: 'quality', label: 'Image Quality', description: 'Blur, exposure and resolution checks', group: 'cv', localOnly: true },
  { name: 'benchmark', label: 'Benchmark Lab', description: 'Measured latency and outputs', group: 'ml', localOnly: true },
  { name: 'evaluation', label: 'Evaluation', description: 'Accuracy against reviewed labels', group: 'ml', localOnly: true },
  { name: 'drift', label: 'Drift Monitor', description: 'Input and output distribution shift', group: 'ml', localOnly: true },
  { name: 'training', label: 'Training', description: 'Local fine-tuning experiments', group: 'ml', localOnly: true },
]

const NAMES = new Set<RouteName>(ROUTES.map((r) => r.name))

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const [path, query = ''] = raw.split('?', 2)
  const [first = '', ...rest] = path.split('/').filter(Boolean)
  const name = NAMES.has(first as RouteName) ? (first as RouteName) : 'dashboard'
  const id = rest.length ? decodeURIComponent(rest.join('/')) : undefined
  return { name, id, params: new URLSearchParams(query) }
}

export function href(
  name: RouteName,
  options: { id?: string; params?: Record<string, string | undefined | null> } = {},
): string {
  let path = `#/${name}`
  if (options.id) path += `/${encodeURIComponent(options.id)}`
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v !== undefined && v !== null && v !== '') query.set(k, v)
  }
  const qs = query.toString()
  return qs ? `${path}?${qs}` : path
}

export function navigate(target: string): void {
  if (typeof window === 'undefined') return
  if (window.location.hash === target) return
  window.location.hash = target
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function snapshot(): string {
  return typeof window === 'undefined' ? '' : window.location.hash
}

/** The current route. Re-renders on every hash change. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => '')
  return parseHash(hash)
}

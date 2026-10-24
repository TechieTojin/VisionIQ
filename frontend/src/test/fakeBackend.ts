import { vi } from 'vitest'
import { ApiError } from '../api/client'
import { summaryFromRecord, type ScanSource } from '../data/scanSource'
import type { AnalysisRecord } from '../types'

/** An in-memory ScanSource, for pages that read scan history. */
export class FakeSource implements ScanSource {
  readonly canDelete = true
  readonly canAnalyze = true
  readonly mode: 'local' | 'cloud' | 'demo'
  records: AnalysisRecord[]

  constructor(records: AnalysisRecord[], mode: 'local' | 'cloud' | 'demo' = 'local') {
    this.records = records
    this.mode = mode
  }

  async listAll() {
    return { summaries: this.records.map(summaryFromRecord), truncated: false }
  }

  async get(id: string) {
    const r = this.records.find((x) => x.analysis_id === id)
    if (!r) throw new ApiError('not found', '404')
    return r
  }

  async loadImage() {
    return null
  }

  async remove(id: string) {
    this.records = this.records.filter((r) => r.analysis_id !== id)
  }
}

export interface Call {
  method: string
  path: string
  body: unknown
}

type Handler = (call: Call) => { status?: number; body?: unknown } | undefined

/**
 * Stub `fetch` with a route table: `'GET /api/alerts'` -> handler. Paths
 * match by prefix after stripping the query string, longest first.
 * Unrouted requests get a 404, so a page that calls something unexpected
 * shows its error state instead of hanging.
 */
export function stubApi(routes: Record<string, Handler | object>) {
  const calls: Call[] = []
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length)
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    let body: unknown = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const call = { method, path, body }
    calls.push(call)
    const key = keys.find((k) => {
      const [m, p] = k.split(' ')
      return m === method && (path.split('?')[0] === p || path.startsWith(p))
    })
    const route = key ? routes[key] : undefined
    const isResponse = (r: unknown): r is { status: number; body: unknown } =>
      !!r && typeof r === 'object' && !Array.isArray(r) && 'status' in r && 'body' in r && typeof (r as { status: unknown }).status === 'number'
    const res =
      typeof route === 'function'
        ? (route as Handler)(call)
        : isResponse(route)
          ? route
          : route !== undefined
            ? { body: route }
            : { status: 404, body: { success: false, error: 'not_found', detail: 'Not routed in test.' } }
    const status = res?.status ?? 200
    if (status === 204) return new Response(null, { status })
    return new Response(JSON.stringify(res?.body ?? null), { status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fn)
  return { calls, fn }
}

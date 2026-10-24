/**
 * Batch queue state machine (pure — the page drives it).
 *
 *   queued ──start──▶ running ──ok──▶ completed
 *     │                 └──error──▶ failed ──retry──▶ queued
 *     └──cancel──▶ cancelled ──requeue──▶ queued
 *   invalid   rejected before upload (never sent)
 *   interrupted  restored after a page reload: the file is gone from
 *                memory, so it cannot resume. A run that was in flight
 *                may still have finished on the server.
 *
 * Only QUEUED items can be cancelled. A running CPU inference cannot be
 * interrupted by the backend, so the UI never offers to.
 */

import { validateFile } from '../api/client'

export const MAX_BATCH = 50

export type BatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'invalid' | 'interrupted'

export interface BatchItem {
  id: string
  name: string
  size: number
  type: string
  lastModified: number
  status: BatchStatus
  /** Upload progress 0–100 while running. */
  progress: number
  stage: string
  error: string | null
  analysisId: string | null
  detections: number | null
  categories: Record<string, number> | null
  quality: string | null
  startedAt: number | null
  finishedAt: number | null
  attempts: number
  duplicateOf: string | null
  /** Set when restored from a saved manifest whose run was in flight. */
  wasRunning?: boolean
}

export interface BatchState {
  batchId: string
  createdAt: string
  items: BatchItem[]
}

export type BatchAction =
  | { type: 'add'; files: { id: string; file: Pick<File, 'name' | 'size' | 'type' | 'lastModified'>; error: string | null }[] }
  | { type: 'start'; id: string; now: number }
  | { type: 'progress'; id: string; progress: number; stage: string }
  | { type: 'complete'; id: string; now: number; analysisId: string; detections: number; categories: Record<string, number>; failed?: string | null }
  | { type: 'fail'; id: string; now: number; error: string }
  | { type: 'quality'; id: string; overall: string }
  | { type: 'cancel'; id: string }
  | { type: 'cancelAll' }
  | { type: 'retry'; id: string }
  | { type: 'retryFailed' }
  | { type: 'remove'; id: string }
  | { type: 'clearFinished' }
  | { type: 'reset'; state: BatchState }

export function newBatch(now = new Date()): BatchState {
  return { batchId: `b${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: now.toISOString(), items: [] }
}

const signature = (f: { name: string; size: number; lastModified: number }) => `${f.name}|${f.size}|${f.lastModified}`

export function batchReducer(state: BatchState, action: BatchAction): BatchState {
  const patch = (id: string, fn: (i: BatchItem) => BatchItem) => ({
    ...state,
    items: state.items.map((i) => (i.id === id ? fn(i) : i)),
  })

  switch (action.type) {
    case 'add': {
      const room = MAX_BATCH - state.items.filter((i) => i.status !== 'invalid').length
      const seen = new Map(state.items.map((i) => [signature(i), i.id]))
      const added: BatchItem[] = []
      let accepted = 0
      for (const { id, file, error } of action.files) {
        const over = !error && accepted >= room
        const sig = signature(file)
        const duplicateOf = seen.get(sig) ?? null
        if (!error && !over) {
          accepted++
          seen.set(sig, id)
        }
        added.push({
          id,
          name: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified,
          status: error || over ? 'invalid' : 'queued',
          progress: 0,
          stage: '',
          error: error ?? (over ? `Batch limit of ${MAX_BATCH} images reached.` : null),
          analysisId: null,
          detections: null,
          categories: null,
          quality: null,
          startedAt: null,
          finishedAt: null,
          attempts: 0,
          duplicateOf,
        })
      }
      return { ...state, items: [...state.items, ...added] }
    }
    case 'start':
      return patch(action.id, (i) =>
        i.status === 'queued'
          ? { ...i, status: 'running', startedAt: action.now, finishedAt: null, progress: 0, stage: 'uploading', error: null, attempts: i.attempts + 1 }
          : i,
      )
    case 'progress':
      return patch(action.id, (i) => (i.status === 'running' ? { ...i, progress: action.progress, stage: action.stage } : i))
    case 'complete':
      return patch(action.id, (i) => ({
        ...i,
        status: action.failed ? 'failed' : 'completed',
        error: action.failed ?? null,
        finishedAt: action.now,
        progress: 100,
        stage: 'done',
        analysisId: action.analysisId,
        detections: action.detections,
        categories: action.categories,
      }))
    case 'fail':
      return patch(action.id, (i) => ({ ...i, status: 'failed', error: action.error, finishedAt: action.now, stage: 'failed' }))
    case 'quality':
      return patch(action.id, (i) => ({ ...i, quality: action.overall }))
    case 'cancel':
      return patch(action.id, (i) => (i.status === 'queued' ? { ...i, status: 'cancelled', stage: 'cancelled' } : i))
    case 'cancelAll':
      return { ...state, items: state.items.map((i) => (i.status === 'queued' ? { ...i, status: 'cancelled', stage: 'cancelled' } : i)) }
    case 'retry':
      return patch(action.id, (i) =>
        i.status === 'failed' || i.status === 'cancelled' ? { ...i, status: 'queued', error: null, stage: '', progress: 0 } : i,
      )
    case 'retryFailed':
      return { ...state, items: state.items.map((i) => (i.status === 'failed' ? { ...i, status: 'queued', error: null, stage: '', progress: 0 } : i)) }
    case 'remove':
      return { ...state, items: state.items.filter((i) => i.id !== action.id || i.status === 'running') }
    case 'clearFinished':
      return { ...state, items: state.items.filter((i) => i.status === 'queued' || i.status === 'running') }
    case 'reset':
      return action.state
  }
}

export function nextQueued(state: BatchState): BatchItem | undefined {
  return state.items.find((i) => i.status === 'queued')
}

export function isRunning(state: BatchState): boolean {
  return state.items.some((i) => i.status === 'running')
}

export interface BatchSummary {
  total: number
  counts: Record<BatchStatus, number>
  detections: number
  categories: { label: string; count: number }[]
  elapsedMs: number
  meanMs: number | null
}

export function summarize(state: BatchState): BatchSummary {
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, invalid: 0, interrupted: 0 } as Record<BatchStatus, number>
  const cats = new Map<string, number>()
  let detections = 0
  const durations: number[] = []
  for (const i of state.items) {
    counts[i.status]++
    if (i.status === 'completed') {
      detections += i.detections ?? 0
      for (const [k, v] of Object.entries(i.categories ?? {})) cats.set(k, (cats.get(k) ?? 0) + v)
    }
    if (i.startedAt !== null && i.finishedAt !== null && (i.status === 'completed' || i.status === 'failed')) durations.push(i.finishedAt - i.startedAt)
  }
  return {
    total: state.items.length,
    counts,
    detections,
    categories: [...cats.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    elapsedMs: durations.reduce((a, b) => a + b, 0),
    meanMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
  }
}

/** Client-side validation before anything is uploaded. */
export function validateForBatch(file: File): string | null {
  return validateFile(file)
}

export function restore(saved: BatchState): BatchState {
  return {
    ...saved,
    items: saved.items.map((i) =>
      i.status === 'queued' || i.status === 'running'
        ? {
            ...i,
            status: 'interrupted',
            wasRunning: i.status === 'running',
            error:
              i.status === 'running'
                ? 'The page was reloaded during inference. The server may have finished it — check the timeline.'
                : 'The page was reloaded before this image ran. Re-add the file to analyze it.',
          }
        : i,
    ),
  }
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

export function toCsv(state: BatchState): string {
  const header = ['file', 'status', 'analysis_id', 'detections', 'categories', 'quality', 'seconds', 'attempts', 'error']
  const rows = state.items.map((i) => [
    i.name,
    i.status,
    i.analysisId,
    i.detections,
    i.categories ? Object.entries(i.categories).map(([k, v]) => `${k}:${v}`).join(' ') : '',
    i.quality,
    i.startedAt !== null && i.finishedAt !== null ? ((i.finishedAt - i.startedAt) / 1000).toFixed(1) : '',
    i.attempts,
    i.error,
  ])
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

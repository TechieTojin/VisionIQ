import { describe, expect, it } from 'vitest'
import { batchReducer, MAX_BATCH, newBatch, nextQueued, restore, summarize, toCsv, type BatchState } from './batch'

const file = (name: string, size = 100, lastModified = 1) => ({ name, size, type: 'image/jpeg', lastModified })

function withFiles(...names: (string | [string, string])[]): BatchState {
  return batchReducer(newBatch(new Date(0)), {
    type: 'add',
    files: names.map((n, i) =>
      Array.isArray(n) ? { id: `i${i}`, file: file(n[0]), error: n[1] } : { id: `i${i}`, file: file(n, 100 + i), error: null },
    ),
  })
}

describe('batch queue', () => {
  it('queues valid files and marks invalid ones without sending them', () => {
    const s = withFiles('a.jpg', ['b.gif', 'Unsupported file type.'])
    expect(s.items.map((i) => i.status)).toEqual(['queued', 'invalid'])
    expect(s.items[1].error).toBe('Unsupported file type.')
  })

  it('flags duplicate files but keeps duplicate names that are different files', () => {
    let s = batchReducer(newBatch(), { type: 'add', files: [{ id: 'a', file: file('x.jpg', 10, 5), error: null }] })
    s = batchReducer(s, { type: 'add', files: [{ id: 'b', file: file('x.jpg', 10, 5), error: null }, { id: 'c', file: file('x.jpg', 99, 5), error: null }] })
    expect(s.items.find((i) => i.id === 'b')?.duplicateOf).toBe('a')
    expect(s.items.find((i) => i.id === 'c')?.duplicateOf).toBeNull()
  })

  it('enforces the batch limit', () => {
    const s = batchReducer(newBatch(), {
      type: 'add',
      files: Array.from({ length: MAX_BATCH + 3 }, (_, i) => ({ id: `f${i}`, file: file(`f${i}.jpg`, i), error: null })),
    })
    expect(s.items.filter((i) => i.status === 'queued')).toHaveLength(MAX_BATCH)
    expect(s.items.filter((i) => i.status === 'invalid')).toHaveLength(3)
  })

  it('runs the lifecycle and keeps completed results when a later item fails', () => {
    let s = withFiles('a.jpg', 'b.jpg')
    s = batchReducer(s, { type: 'start', id: 'i0', now: 1000 })
    s = batchReducer(s, { type: 'complete', id: 'i0', now: 3000, analysisId: 'x', detections: 4, categories: { bottle: 4 } })
    s = batchReducer(s, { type: 'start', id: 'i1', now: 3000 })
    s = batchReducer(s, { type: 'fail', id: 'i1', now: 4000, error: 'Network error' })
    expect(s.items.map((i) => i.status)).toEqual(['completed', 'failed'])
    const sum = summarize(s)
    expect(sum.detections).toBe(4)
    expect(sum.counts.completed).toBe(1)
    expect(sum.counts.failed).toBe(1)
    expect(sum.meanMs).toBe(1500)
  })

  it('records a backend-reported failure (model failed) as failed, not completed', () => {
    let s = withFiles('a.jpg')
    s = batchReducer(s, { type: 'start', id: 'i0', now: 0 })
    s = batchReducer(s, { type: 'complete', id: 'i0', now: 1, analysisId: 'x', detections: 0, categories: {}, failed: 'Inference failed' })
    expect(s.items[0].status).toBe('failed')
    expect(s.items[0].analysisId).toBe('x')
  })

  it('only cancels queued items — never a running one', () => {
    let s = withFiles('a.jpg', 'b.jpg', 'c.jpg')
    s = batchReducer(s, { type: 'start', id: 'i0', now: 0 })
    s = batchReducer(s, { type: 'cancel', id: 'i0' })
    s = batchReducer(s, { type: 'cancel', id: 'i1' })
    expect(s.items.map((i) => i.status)).toEqual(['running', 'cancelled', 'queued'])
    s = batchReducer(s, { type: 'cancelAll' })
    expect(s.items.map((i) => i.status)).toEqual(['running', 'cancelled', 'cancelled'])
    expect(batchReducer(s, { type: 'remove', id: 'i0' }).items).toHaveLength(3) // can't remove the running one
  })

  it('retries failed items and counts attempts', () => {
    let s = withFiles('a.jpg')
    s = batchReducer(s, { type: 'start', id: 'i0', now: 0 })
    s = batchReducer(s, { type: 'fail', id: 'i0', now: 1, error: 'x' })
    s = batchReducer(s, { type: 'retryFailed' })
    expect(nextQueued(s)?.id).toBe('i0')
    s = batchReducer(s, { type: 'start', id: 'i0', now: 2 })
    expect(s.items[0].attempts).toBe(2)
  })

  it('restores honestly after a reload', () => {
    let s = withFiles('a.jpg', 'b.jpg', 'c.jpg')
    s = batchReducer(s, { type: 'start', id: 'i0', now: 0 })
    s = batchReducer(s, { type: 'complete', id: 'i0', now: 1, analysisId: 'x', detections: 1, categories: {} })
    s = batchReducer(s, { type: 'start', id: 'i1', now: 1 })
    const r = restore(JSON.parse(JSON.stringify(s)))
    expect(r.items.map((i) => i.status)).toEqual(['completed', 'interrupted', 'interrupted'])
    expect(r.items[1].wasRunning).toBe(true)
    expect(r.items[1].error).toContain('may have finished')
  })

  it('exports CSV safely', () => {
    let s = withFiles('=HYPERLINK("x").jpg')
    s = batchReducer(s, { type: 'start', id: 'i0', now: 0 })
    s = batchReducer(s, { type: 'complete', id: 'i0', now: 2500, analysisId: 'abc', detections: 2, categories: { bottle: 2 } })
    const csv = toCsv(s)
    expect(csv.split('\r\n')[0]).toBe('"file","status","analysis_id","detections","categories","quality","seconds","attempts","error"')
    expect(csv).toContain(`"'=HYPERLINK(""x"").jpg"`)
    expect(csv).toContain('"2.5"')
  })
})

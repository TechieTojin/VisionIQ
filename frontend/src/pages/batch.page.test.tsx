import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { ScanDataProvider } from '../data/ScanDataProvider'
import { clearRecordCache } from '../data/recordCache'
import { FakeSource, stubApi } from '../test/fakeBackend'
import { makeDetection, makeRecord } from '../test/fixtures'
import { BatchPage } from './BatchPage'

const analyze = vi.fn()

vi.mock('../api/analysisClient', () => ({
  getAnalysisClient: () => ({ analyze }),
}))

const img = (name: string, type = 'image/jpeg', size = 1000) => new File([new Uint8Array(size)], name, { type, lastModified: 1 })

function record(id: string, labels: string[]) {
  const r = makeRecord(labels.map((l, i) => makeDetection(i, l, 0.9)))
  return { ...r, analysis_id: id, image: { ...r.image, filename: `${id}.jpg` } }
}

function renderPage() {
  return render(
    <ScanDataProvider source={new FakeSource([])}>
      <BatchPage />
    </ScanDataProvider>,
  )
}

async function addFiles(files: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await userEvent.upload(input, files, { applyAccept: false })
}

beforeEach(() => {
  clearRecordCache()
  analyze.mockReset()
  stubApi({ 'GET /api/saved/batch': [], 'PUT /api/saved/batch/': { id: 'x', updated_at: '', data: {} }, 'GET /api/quality/': { status: 404, body: { error: 'image_unavailable', detail: '' } } })
})

afterEach(() => vi.unstubAllGlobals())

describe('Batch page', () => {
  it('rejects invalid files before upload and processes the rest one at a time', async () => {
    let inFlight = 0
    let maxInFlight = 0
    analyze.mockImplementation(async (file: File) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      if (file.name === 'b.jpg') throw new ApiError('Network error. Is the backend running?', 'network')
      return record(file.name.replace('.jpg', ''), ['bottle', 'bottle'])
    })
    renderPage()
    await addFiles([img('a.jpg'), img('notes.txt', 'text/plain'), img('b.jpg'), img('c.jpg')])
    const queue = screen.getByRole('list', { name: '' }) // the ordered queue
    expect(within(queue).getByText('Rejected')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Start 3 images' }))
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.getAllByText('Completed')).toHaveLength(2 + 1)) // two rows + the KPI label
    expect(maxInFlight).toBe(1) // strictly sequential
    expect(analyze.mock.calls.map((c) => (c[0] as File).name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']) // invalid never sent
    expect(screen.getByText('Network error. Is the backend running?')).toBeInTheDocument()

    // Completed results survive the failure; the aggregate counts only them.
    const kpis = screen.getByRole('region', { name: 'Batch summary' })
    expect(within(kpis).getByText('Detections').closest('.kpi')).toHaveTextContent('4')
  })

  it('retries a failed image', async () => {
    analyze.mockRejectedValueOnce(new ApiError('Timeout', 'network')).mockResolvedValueOnce(record('a', ['cup']))
    renderPage()
    await addFiles([img('a.jpg')])
    await userEvent.click(screen.getByRole('button', { name: 'Start 1 image' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('attempt 2')).toBeInTheDocument()
  })

  it('cancels queued images but never offers to cancel the running one', async () => {
    let release: () => void = () => {}
    analyze.mockImplementation(() => new Promise((r) => { release = () => r(record('a', ['bottle'])) }))
    renderPage()
    await addFiles([img('a.jpg'), img('b.jpg')])
    await userEvent.click(screen.getByRole('button', { name: 'Start 2 images' }))
    await screen.findByText(/uploading|running inference/)
    const rows = screen.getAllByRole('listitem').filter((li) => li.className.includes('queue__row'))
    expect(within(rows[0]).queryByRole('button', { name: 'Cancel' })).toBeNull()
    await userEvent.click(within(rows[1]).getByRole('button', { name: 'Cancel' }))
    release()
    await waitFor(() => expect(screen.getByText('Cancelled')).toBeInTheDocument())
    expect(analyze).toHaveBeenCalledTimes(1)
  })
})

describe('Batch history states (BUG-04 regression)', () => {
  it('shows loading, not "No previous batches", while history is in flight', async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderPage()
    expect(screen.getByText('Loading previous batches…')).toBeInTheDocument()
    expect(screen.queryByText('No previous batches.')).toBeNull()
  })

  it('shows an error with retry when history fails to load', async () => {
    vi.unstubAllGlobals()
    stubApi({ 'GET /api/saved/batch': { status: 500, body: { success: false, error: 'internal_error', detail: 'Store unavailable.' } } })
    renderPage()
    expect(await screen.findByText('Batch history could not be loaded')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.queryByText('No previous batches.')).toBeNull()
  })
})

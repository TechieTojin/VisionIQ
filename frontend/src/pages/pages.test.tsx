import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { ApiError } from '../api/client'
import { ScanDataProvider } from '../data/ScanDataProvider'
import { clearRecordCache } from '../data/recordCache'
import { summaryFromRecord, type ScanSource } from '../data/scanSource'
import { clearImageCache } from '../data/useScanImage'
import { makeDetection, makeDetectionResult, makeRecord } from '../test/fixtures'
import type { AnalysisRecord } from '../types'
import { AnalyzePage } from './AnalyzePage'
import { ComparePage } from './ComparePage'
import { DashboardPage } from './DashboardPage'
import { ReportsPage } from './ReportsPage'
import { TimelinePage } from './TimelinePage'

class FakeSource implements ScanSource {
  readonly mode = 'local' as const
  readonly canDelete = true
  readonly canAnalyze = true
  records: AnalysisRecord[]
  removed: string[] = []
  fail = false

  constructor(records: AnalysisRecord[]) {
    this.records = records
  }

  async listAll() {
    if (this.fail) throw new ApiError('Backend unreachable.', 'network')
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
    this.removed.push(id)
    this.records = this.records.filter((r) => r.analysis_id !== id)
  }
}

const HOUR = 3600_000
const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString()

function scan(
  id: string,
  hoursAgo: number,
  dets = [makeDetection(0, 'bottle', 0.9), makeDetection(1, 'cup', 0.4)],
  overrides: Partial<AnalysisRecord> = {},
): AnalysisRecord {
  const base = makeRecord(dets)
  return {
    ...base,
    analysis_id: id,
    created_at: at(hoursAgo),
    image: { ...base.image, filename: `${id}.jpg` },
    ...overrides,
  }
}

const failed = (id: string, hoursAgo: number) =>
  scan(id, hoursAgo, [], { status: 'failed', detection: null, error: 'Inference crashed.' })
const noModel = (id: string, hoursAgo: number) =>
  scan(id, hoursAgo, [], { detection: makeDetectionResult([], { status: 'unavailable' }) })

function renderWith(source: FakeSource, ui: React.ReactNode) {
  return render(<ScanDataProvider source={source}>{ui}</ScanDataProvider>)
}

beforeEach(() => {
  clearRecordCache()
  clearImageCache()
  window.location.hash = ''
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------

describe('DashboardPage (command center)', () => {
  const records = [
    scan('s1', 1),
    scan('s2', 30, [makeDetection(0, 'bottle', 0.8), makeDetection(1, 'bottle', 0.85), makeDetection(2, 'bottle', 0.9)]),
    failed('s3', 2),
    noModel('s4', 3),
  ]

  const kpi = (label: string) => screen.getByText(label).closest('.kpi') as HTMLElement

  it('derives every KPI from the stored scans', async () => {
    renderWith(new FakeSource(records), <DashboardPage params={new URLSearchParams('range=all')} />)
    await waitFor(() => expect(within(kpi('Scans')).getByText('4')).toBeInTheDocument())
    // Failed and model-less scans are never counted as successful.
    expect(within(kpi('Successful analyses')).getByText('2')).toBeInTheDocument()
    expect(within(kpi('Model detections')).getByText('5')).toBeInTheDocument()
    expect(within(kpi('Failed / no model')).getByText('2')).toBeInTheDocument()
    expect(within(kpi('Scans to review')).getByText('1')).toBeInTheDocument()
  })

  it('links each KPI to the filtered timeline', async () => {
    renderWith(new FakeSource(records), <DashboardPage params={new URLSearchParams('range=7d')} />)
    await waitFor(() => expect(within(kpi('Scans')).getByText('4')).toBeInTheDocument())
    expect(kpi('Failed / no model')).toHaveAttribute('href', '#/timeline?range=7d&outcome=problem')
    expect(kpi('Scans to review')).toHaveAttribute('href', '#/timeline?range=7d&outcome=review')
  })

  it('applies the date range', async () => {
    renderWith(new FakeSource(records), <DashboardPage params={new URLSearchParams('range=24h')} />)
    // s2 is 30 hours old, so it drops out of every figure.
    await waitFor(() => expect(within(kpi('Scans')).getByText('3')).toBeInTheDocument())
    expect(within(kpi('Model detections')).getByText('2')).toBeInTheDocument()
  })

  it('lists alerts that link to the scan behind them', async () => {
    renderWith(new FakeSource(records), <DashboardPage params={new URLSearchParams('range=all')} />)
    const alert = await screen.findByText('Analysis failed')
    expect(alert.closest('a')).toHaveAttribute('href', '#/analyze/s3')
    expect(screen.getByText('No model ran')).toBeInTheDocument()
  })

  it('shows an empty state, not zeros, when there are no scans', async () => {
    renderWith(new FakeSource([]), <DashboardPage params={new URLSearchParams()} />)
    expect(await screen.findByText('No scans yet')).toBeInTheDocument()
    expect(screen.queryByText('Model detections')).toBeNull()
  })

  it('shows an error state when history cannot load', async () => {
    const source = new FakeSource([])
    source.fail = true
    renderWith(source, <DashboardPage params={new URLSearchParams()} />)
    expect(await screen.findByText('Backend unreachable.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------

describe('TimelinePage', () => {
  it('lists scans newest first and counts failures separately', async () => {
    renderWith(new FakeSource([scan('old', 50), scan('new', 1), failed('bad', 2)]), <TimelinePage params={new URLSearchParams()} />)
    const names = await screen.findAllByRole('link', { name: /\.jpg$/ })
    expect(names.map((n) => n.textContent)).toEqual(['new.jpg', 'bad.jpg', 'old.jpg'])
    expect(screen.getByText(/2 successful/)).toHaveTextContent('1 failed or without a model')
  })

  it('filters by outcome from the URL', async () => {
    renderWith(new FakeSource([scan('ok', 1), failed('bad', 2), noModel('nomodel', 3)]), <TimelinePage params={new URLSearchParams('outcome=problem')} />)
    await waitFor(() => expect(screen.getAllByRole('link', { name: /\.jpg$/ })).toHaveLength(2))
    expect(screen.queryByRole('link', { name: 'ok.jpg' })).toBeNull()
  })

  it('filters by category and search', async () => {
    const cups = scan('cups', 1, [makeDetection(0, 'cup', 0.9)])
    const bottles = scan('bottles', 2, [makeDetection(0, 'bottle', 0.9)])
    renderWith(new FakeSource([cups, bottles]), <TimelinePage params={new URLSearchParams('category=bottle')} />)
    await waitFor(() => expect(screen.getAllByRole('link', { name: /\.jpg$/ })).toHaveLength(1))
    expect(screen.getByRole('link', { name: 'bottles.jpg' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'cup' } })
    expect(screen.getAllByRole('link', { name: /\.jpg$/ }).map((a) => a.textContent)).toEqual(['cups.jpg'])
  })

  it('offers a compare shortcut against the previous successful scan', async () => {
    renderWith(new FakeSource([scan('b', 1), failed('x', 2), scan('a', 3)]), <TimelinePage params={new URLSearchParams()} />)
    const row = (await screen.findByRole('link', { name: 'b.jpg' })).closest('li')!
    expect(within(row).getByRole('link', { name: /Compare/ })).toHaveAttribute('href', '#/compare?a=a&b=b')
  })

  it('paginates long histories', async () => {
    const many = Array.from({ length: 25 }, (_, i) => scan(`s${i}`, i + 1))
    renderWith(new FakeSource(many), <TimelinePage params={new URLSearchParams()} />)
    await waitFor(() => expect(screen.getAllByRole('link', { name: /\.jpg$/ })).toHaveLength(20))
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Older/ }))
    expect(screen.getAllByRole('link', { name: /\.jpg$/ })).toHaveLength(5)
  })

  it('explains an empty filter result', async () => {
    renderWith(new FakeSource([scan('a', 1)]), <TimelinePage params={new URLSearchParams('q=zzz')} />)
    expect(await screen.findByText('No scans match')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------

describe('ComparePage', () => {
  const before = scan('before', 5, [makeDetection(0, 'bottle', 0.9), makeDetection(1, 'cup', 0.6)])
  const after = scan('after', 1, [makeDetection(0, 'bottle', 0.9), makeDetection(1, 'bottle', 0.7), makeDetection(2, 'bottle', 0.8)])

  it('shows detection deltas framed as detections, not stock', async () => {
    renderWith(new FakeSource([before, after]), <ComparePage params={new URLSearchParams('a=before&b=after')} />)
    const table = await screen.findByRole('table')
    const bottle = within(table).getByRole('rowheader', { name: 'bottle' }).closest('tr')!
    expect(within(bottle).getByText('+2')).toBeInTheDocument()
    const cup = within(table).getByRole('rowheader', { name: 'cup' }).closest('tr')!
    expect(within(cup).getByText('−1')).toBeInTheDocument()
    expect(screen.getAllByText(/not verified stock movement/).length).toBeGreaterThan(0)
    expect(screen.getByText('bottle: 1 -> 3 (+2)')).toBeInTheDocument()
  })

  it('recomputes at a stricter common threshold', async () => {
    renderWith(new FakeSource([before, after]), <ComparePage params={new URLSearchParams('a=before&b=after')} />)
    await screen.findByRole('table')
    fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '85' } })
    const table = screen.getByRole('table')
    const bottle = within(table).getByRole('rowheader', { name: 'bottle' }).closest('tr')!
    expect(within(bottle).getAllByText('1')).toHaveLength(2)
  })

  it('offers a keyboard-operable wipe with an alignment caveat', async () => {
    renderWith(new FakeSource([before, after]), <ComparePage params={new URLSearchParams('a=before&b=after')} />)
    await screen.findByRole('table')
    await userEvent.click(screen.getByRole('radio', { name: 'Wipe' }))
    const wipe = screen.getByLabelText(/Wipe position/)
    fireEvent.change(wipe, { target: { value: '30' } })
    expect(wipe).toHaveValue('30')
    expect(screen.getByText(/not registered to each other/)).toBeInTheDocument()
  })

  it('asks for two scans when none are selected', async () => {
    renderWith(new FakeSource([before, after]), <ComparePage params={new URLSearchParams()} />)
    expect(await screen.findByText('Pick two scans')).toBeInTheDocument()
  })

  it('warns when one side never ran a model', async () => {
    renderWith(new FakeSource([before, noModel('nm', 2)]), <ComparePage params={new URLSearchParams('a=before&b=nm')} />)
    expect(await screen.findByText(/One of these scans has no detections to compare/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------

describe('ReportsPage', () => {
  it('previews and downloads a real PDF for the chosen scan', async () => {
    const created: Blob[] = []
    // jsdom implements neither; install stubs for this test only.
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
      created.push(b as Blob)
      return 'blob:report'
    })
    URL.revokeObjectURL = vi.fn()
    onTestFinished(() => {
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    renderWith(new FakeSource([scan('s1', 1)]), <ReportsPage params={new URLSearchParams('scan=s1')} />)
    expect(await screen.findByText('The report will contain')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Download PDF' }))

    await waitFor(() => expect(click).toHaveBeenCalled())
    const anchor = click.mock.contexts[0] as HTMLAnchorElement
    expect(anchor.download).toMatch(/^visioniq-report-s1-\d{4}-\d{2}-\d{2}-s1\.pdf$/)
    const pdf = created.find((b) => b.type === 'application/pdf')!
    // jsdom's Blob has no arrayBuffer(); FileReader is the portable route.
    const buffer = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.readAsArrayBuffer(pdf)
    })
    const head = new TextDecoder('latin1').decode(new Uint8Array(buffer).slice(0, 8))
    expect(head).toBe('%PDF-1.4')
  })

  it('describes a comparison report', async () => {
    renderWith(new FakeSource([scan('a', 5), scan('b', 1)]), <ReportsPage params={new URLSearchParams('a=a&b=b')} />)
    expect(await screen.findByText(/Comparison with a\.jpg/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------

describe('AnalyzePage (scan workspace)', () => {
  it('renders the explorer, layers and tabs for an analysed scan', async () => {
    renderWith(new FakeSource([scan('s1', 1)]), <AnalyzePage scanId="s1" />)
    expect(await screen.findByRole('heading', { name: 's1.jpg' })).toBeInTheDocument()
    expect(screen.getByText('Confidence explorer')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Image layers' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Detections/ })).toHaveAttribute('aria-selected', 'true')
    // No stored image in this source: the page says so instead of a blank box.
    expect(await screen.findByText('Image not available')).toBeInTheDocument()
  })

  it('keeps every view on one threshold', async () => {
    renderWith(new FakeSource([scan('s1', 1)]), <AnalyzePage scanId="s1" />)
    await screen.findByText('Confidence explorer')
    // Let the (absent) image finish resolving before interacting.
    await screen.findByText('Image not available')
    fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '50' } })
    expect(screen.getByRole('tab', { name: /Detections/ })).toHaveTextContent('1')
    expect(screen.getByText(/1 shown/)).toHaveTextContent('1 filtered')
  })

  it('says detection did not run instead of showing an empty shelf', async () => {
    renderWith(new FakeSource([noModel('nm', 1)]), <AnalyzePage scanId="nm" />)
    expect(await screen.findByText('Detection did not run.')).toBeInTheDocument()
    expect(screen.getByText(/not evidence of an empty shelf/)).toBeInTheDocument()
    expect(screen.queryByText('Confidence explorer')).toBeNull()
  })

  it('requires confirmation before deleting', async () => {
    const source = new FakeSource([scan('s1', 1)])
    renderWith(source, <AnalyzePage scanId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(source.removed).toEqual([])
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
    })
    expect(source.removed).toEqual(['s1'])
    expect(window.location.hash).toBe('#/timeline')
  })

  it('reports a missing scan', async () => {
    renderWith(new FakeSource([]), <AnalyzePage scanId="ghost" />)
    expect(await screen.findByText('This scan does not exist or was deleted.')).toBeInTheDocument()
  })
})

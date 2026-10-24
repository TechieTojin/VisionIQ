import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import App from './App'
import { clearRecordCache } from './data/recordCache'

/** A backend with no scans and a loaded model. */
function stubBackend() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/api/system/status')
      ? { model_available: true, model: { name: 'yolov8n.pt' }, execution_mode: 'local', model_unavailable_reason: null }
      : { items: [], next_cursor: null, has_more: false }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  clearRecordCache()
  window.location.hash = ''
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App shell', () => {
  it('renders every section in three groups with the current one marked', async () => {
    stubBackend()
    render(<App mode="local" />)
    const nav = screen.getByRole('navigation', { name: 'Main' })
    for (const group of ['Retail Intelligence', 'Computer Vision & Data', 'ML Engineering']) {
      expect(within(nav).getByRole('button', { name: new RegExp(group) })).toHaveAttribute('aria-expanded', 'true')
    }
    expect(within(nav).getAllByRole('link')).toHaveLength(15)
    for (const label of ['Dashboard', 'Analyze', 'Batch', 'Compare', 'Timeline', 'Alerts', 'Reports', 'Ask VisionIQ',
      'Annotation Studio', 'Datasets', 'Image Quality', 'Benchmark Lab', 'Evaluation', 'Drift Monitor', 'Training']) {
      expect(nav).toHaveTextContent(label)
    }
    expect(within(nav).getByRole('link', { name: /Dashboard/ })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByText('No scans yet')).toBeInTheDocument()
    expect(screen.getByText('auth off (local)')).toBeInTheDocument()
  })

  it('routes by hash without a page reload', async () => {
    stubBackend()
    render(<App mode="local" />)
    await act(async () => {
      window.location.hash = '#/timeline'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(screen.getByRole('heading', { name: 'Scan timeline' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: /Timeline/ })).toHaveAttribute('aria-current', 'page')
  })

  it('collapses a navigation group, keeping the current page visible', async () => {
    stubBackend()
    render(<App mode="local" />)
    const nav = screen.getByRole('navigation', { name: 'Main' })
    const ml = within(nav).getByRole('button', { name: /ML Engineering/ })
    await userEvent.click(ml)
    expect(ml).toHaveAttribute('aria-expanded', 'false')
    expect(within(nav).queryByRole('link', { name: /Benchmark Lab/ })).toBeNull()
    // The group holding the current page can't hide it.
    await userEvent.click(within(nav).getByRole('button', { name: /Retail Intelligence/ }))
    expect(within(nav).getByRole('link', { name: /Dashboard/ })).toBeInTheDocument()
  })

  it('offers a mobile quick bar with a More sheet', async () => {
    stubBackend()
    render(<App mode="local" />)
    const bar = screen.getByRole('navigation', { name: 'Quick navigation' })
    const more = within(bar).getByRole('button', { name: /More/ })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('navigation', { name: 'Main' })).toHaveClass('is-open')
  })

  it('does not steal focus on first load, but focuses main after navigation (BUG-11 regression)', async () => {
    stubBackend()
    // StrictMode double-invokes effects, as the dev server does.
    render(
      <StrictMode>
        <App mode="local" />
      </StrictMode>,
    )
    expect(document.activeElement).not.toBe(document.getElementById('main'))
    await act(async () => {
      window.location.hash = '#/timeline'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(document.activeElement).toBe(document.getElementById('main'))
  })

  it('loads scan history once and shares it across pages', async () => {
    const fetchMock = stubBackend()
    render(<App mode="local" />)
    await screen.findByText('No scans yet')
    await act(async () => {
      window.location.hash = '#/compare'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    const listCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/analyses?'))
    expect(listCalls).toHaveLength(1)
  })
})

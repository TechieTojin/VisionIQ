import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  deleteAnalysis,
  getAnalysis,
  listAnalyses,
  validateFile,
} from './client'

function makeFile(type: string, size: number, name = 'shelf.png'): File {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('validateFile', () => {
  it('accepts supported image types', () => {
    expect(validateFile(makeFile('image/jpeg', 1000))).toBeNull()
    expect(validateFile(makeFile('image/png', 1000))).toBeNull()
    expect(validateFile(makeFile('image/webp', 1000))).toBeNull()
  })

  it('rejects unsupported types', () => {
    expect(validateFile(makeFile('image/gif', 1000))).toMatch(/Unsupported/)
    expect(validateFile(makeFile('application/pdf', 1000))).toMatch(/Unsupported/)
  })

  it('rejects files over 10 MB', () => {
    expect(validateFile(makeFile('image/png', 10 * 1024 * 1024 + 1))).toMatch(
      /10 MB/,
    )
  })

  it('accepts a file exactly at the limit', () => {
    expect(validateFile(makeFile('image/png', 10 * 1024 * 1024))).toBeNull()
  })
})

describe('API client', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    }
  }

  it('builds a query string from list parameters', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [], next_cursor: null, has_more: false }),
    )
    await listAnalyses({ limit: 5, search: 'dairy', status: 'completed' })

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('limit=5')
    expect(url).toContain('search=dairy')
    expect(url).toContain('status=completed')
  })

  it('surfaces the backend detail message on error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: 'not_found', detail: 'No such scan.' }, 404),
    )
    await expect(getAnalysis('missing')).rejects.toThrow('No such scan.')
  })

  it('unwraps a nested FastAPI detail object', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { detail: { success: false, error: 'rate_limited', detail: 'Slow down.' } },
        429,
      ),
    )
    await expect(getAnalysis('x')).rejects.toThrow('Slow down.')
  })

  it('reports a network failure clearly', async () => {
    fetchMock.mockRejectedValue(new TypeError('failed to fetch'))
    await expect(getAnalysis('x')).rejects.toThrow(/backend running on port 8080/)
  })

  it('tags errors as ApiError with a code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'nope' }, 500))
    await expect(getAnalysis('x')).rejects.toBeInstanceOf(ApiError)
  })

  it('handles a 204 with no body on delete', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, text: async () => '' })
    await expect(deleteAnalysis('a1')).resolves.toBeUndefined()
  })

  it('url-encodes ids to prevent path injection', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    await getAnalysis('../admin')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/analyses/..%2Fadmin')
  })

  it('uses relative /api paths so the Vite proxy applies', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [], next_cursor: null, has_more: false }),
    )
    await listAnalyses({})
    expect(fetchMock.mock.calls[0][0]).toMatch(/^\/api\//)
  })
})

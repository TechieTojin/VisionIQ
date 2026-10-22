import { afterEach, describe, expect, it, vi } from 'vitest'
import { authHeaders, getAccessToken, setTokenProvider } from './auth'

afterEach(() => {
  setTokenProvider(null)
  vi.unstubAllGlobals()
})

describe('token provider', () => {
  it('sends no Authorization header when unauthenticated', async () => {
    expect(await authHeaders()).toEqual({})
  })

  it('sends a bearer header once a provider is registered', async () => {
    setTokenProvider(() => 'abc123')
    expect(await authHeaders()).toEqual({ Authorization: 'Bearer abc123' })
  })

  it('supports an async provider', async () => {
    setTokenProvider(async () => 'async-token')
    expect(await getAccessToken()).toBe('async-token')
  })

  it('degrades to anonymous when the provider throws', async () => {
    setTokenProvider(() => {
      throw new Error('session expired')
    })
    expect(await authHeaders()).toEqual({})
  })

  it('treats a null token as anonymous', async () => {
    setTokenProvider(() => null)
    expect(await authHeaders()).toEqual({})
  })

  it('never persists the token to browser storage', async () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { setItem, getItem: () => null })
    vi.stubGlobal('sessionStorage', { setItem, getItem: () => null })

    setTokenProvider(() => 'secret-token')
    await authHeaders()

    // An XSS-readable copy of the token must never be written anywhere.
    expect(setItem).not.toHaveBeenCalled()
  })
})

describe('client integration', () => {
  it('attaches the bearer token to API requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: [], has_more: false }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { listAnalyses } = await import('./client')
    setTokenProvider(() => 'tok-1')
    await listAnalyses({})

    const init = fetchMock.mock.calls[0][1]
    expect(init.headers.Authorization).toBe('Bearer tok-1')
  })

  it('omits the header entirely in local mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: [], has_more: false }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { listAnalyses } = await import('./client')
    await listAnalyses({})

    const init = fetchMock.mock.calls[0][1]
    expect(init.headers.Authorization).toBeUndefined()
  })
})

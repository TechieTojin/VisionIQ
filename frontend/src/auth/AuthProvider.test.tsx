import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './AuthProvider'
import type { AuthConfig, CognitoConfig } from './config'
import { useAuth } from './useAuth'
import { clearSession, getAccessToken as sessionToken } from './session'
import { getAccessToken as clientToken, setTokenProvider } from '../api/auth'

const cognitoConfig: CognitoConfig = {
  mode: 'cognito',
  domain: 'https://visioniq-dev.auth.us-east-1.amazoncognito.com',
  clientId: 'abc123clientid',
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST',
  scopes: 'openid email profile',
  redirectUri: 'http://localhost:5175',
  logoutUri: 'http://localhost:5175',
}

/** Surfaces auth state so assertions don't depend on the real dashboard. */
function Probe() {
  const { status, user, error, mode, login, logout } = useAuth()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="mode">{mode}</span>
      <span data-testid="user">{user?.subject ?? ''}</span>
      <span data-testid="error">{error ?? ''}</span>
      <button onClick={login}>login</button>
      <button onClick={logout}>logout</button>
    </div>
  )
}

function renderWith(config: AuthConfig) {
  return render(
    <AuthProvider config={config}>
      <Probe />
    </AuthProvider>,
  )
}

let assign: ReturnType<typeof vi.fn>
let replaceState: ReturnType<typeof vi.fn>
let locationStub: {
  href: string
  origin: string
  search: string
  pathname: string
  hash: string
  assign: ReturnType<typeof vi.fn>
}

/**
 * Point the stubbed location at a URL. `history.replaceState` is mocked, so
 * the stub has to be mutated directly rather than navigated.
 */
function setUrl(search: string) {
  locationStub.search = search
  locationStub.href = `http://localhost:5175/${search}`
}

/** A JWT-shaped token whose payload is readable but unsigned. */
function fakeJwt(claims: Record<string, unknown>): string {
  const body = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `header.${body}.signature`
}

beforeEach(() => {
  assign = vi.fn()
  replaceState = vi.fn()
  locationStub = {
    href: 'http://localhost:5175/',
    origin: 'http://localhost:5175',
    search: '',
    pathname: '/',
    hash: '',
    assign,
  }
  vi.stubGlobal('location', locationStub)
  vi.stubGlobal('history', { replaceState })
  sessionStorage.clear()
  // The token store is module-scoped, so it survives between tests unless
  // explicitly reset.
  clearSession()
})

afterEach(() => {
  vi.unstubAllGlobals()
  setTokenProvider(null)
  sessionStorage.clear()
  vi.useRealTimers()
})

// ------------------------------------------------------------ local mode

describe('local development mode', () => {
  it('authenticates immediately without contacting a provider', async () => {
    renderWith({ mode: 'local' })
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    )
    expect(screen.getByTestId('user')).toHaveTextContent('local')
    expect(assign).not.toHaveBeenCalled()
  })

  it('sends no bearer token, so the backend uses its local tenant', async () => {
    renderWith({ mode: 'local' })
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    )
    await expect(clientToken()).resolves.toBeNull()
  })
})

// ------------------------------------------------------ misconfiguration

describe('fail-closed configuration', () => {
  it('refuses to run and never reports authenticated', async () => {
    renderWith({ mode: 'misconfigured', reason: 'local bypass in production' })
    expect(screen.getByTestId('status')).toHaveTextContent('misconfigured')
    expect(screen.getByTestId('error')).toHaveTextContent('local bypass')
    expect(assign).not.toHaveBeenCalled()
  })
})

// -------------------------------------------------------------- sign-in

describe('login', () => {
  it('attempts silent restoration on first load', async () => {
    renderWith(cognitoConfig)
    await waitFor(() => expect(assign).toHaveBeenCalled())

    const url = new URL(assign.mock.calls[0][0] as string)
    expect(url.searchParams.get('prompt')).toBe('none')
    expect(url.searchParams.get('response_type')).toBe('code')
  })

  it('redirects interactively when the user clicks sign in', async () => {
    setUrl('?error=login_required')
    renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    )

    await userEvent.click(screen.getByText('login'))
    await waitFor(() => expect(assign).toHaveBeenCalled())

    const url = new URL(assign.mock.calls.at(-1)![0] as string)
    expect(url.searchParams.get('prompt')).toBeNull()
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('stores the PKCE verifier for the redirect but no tokens', async () => {
    renderWith(cognitoConfig)
    await waitFor(() => expect(assign).toHaveBeenCalled())

    expect(sessionStorage.getItem('visioniq.pkce.verifier')).toBeTruthy()
    const dump = JSON.stringify(sessionStorage) + JSON.stringify(localStorage)
    expect(dump).not.toMatch(/access_token|accessToken|Bearer/)
  })
})

// ------------------------------------------------------------- callback

describe('callback handling', () => {
  function stubExchange(payload: unknown, ok = true) {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok, status: ok ? 200 : 400, json: async () => payload })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function primeFlow(state = 'the-state') {
    sessionStorage.setItem('visioniq.pkce.verifier', 'the-verifier')
    sessionStorage.setItem('visioniq.pkce.state', state)
  }

  it('exchanges the code and authenticates', async () => {
    primeFlow()
    setUrl('?code=auth-code&state=the-state')
    const fetchMock = stubExchange({
      access_token: 'access-abc',
      id_token: fakeJwt({ sub: 'user-42', email: 'a@example.com' }),
      expires_in: 3600,
    })

    renderWith(cognitoConfig)

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    )
    expect(screen.getByTestId('user')).toHaveTextContent('user-42')

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string)
    expect(body.get('code')).toBe('auth-code')
    expect(body.get('code_verifier')).toBe('the-verifier')
  })

  it('makes the token available to the API client', async () => {
    primeFlow()
    setUrl('?code=auth-code&state=the-state')
    stubExchange({ access_token: 'access-abc', expires_in: 3600 })

    renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    )

    expect(sessionToken()).toBe('access-abc')
    await expect(clientToken()).resolves.toBe('access-abc')
  })

  it('clears the code and state from the address bar', async () => {
    primeFlow()
    setUrl('?code=auth-code&state=the-state')
    stubExchange({ access_token: 'at', expires_in: 3600 })

    renderWith(cognitoConfig)
    await waitFor(() => expect(replaceState).toHaveBeenCalled())

    const finalUrl = replaceState.mock.calls.at(-1)![2] as string
    expect(finalUrl).not.toContain('code=')
    expect(finalUrl).not.toContain('state=')
  })

  it('consumes the PKCE verifier so a code cannot be replayed', async () => {
    primeFlow()
    setUrl('?code=auth-code&state=the-state')
    stubExchange({ access_token: 'at', expires_in: 3600 })

    renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    )
    expect(sessionStorage.getItem('visioniq.pkce.verifier')).toBeNull()
  })

  it('REJECTS a mismatched state without exchanging the code', async () => {
    primeFlow('expected-state')
    setUrl('?code=auth-code&state=attacker-state')
    const fetchMock = stubExchange({ access_token: 'should-not-happen' })

    renderWith(cognitoConfig)

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('error'),
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('error')).toHaveTextContent(/security check/i)
  })

  it('rejects a callback with no stashed verifier', async () => {
    setUrl('?code=auth-code&state=whatever')
    const fetchMock = stubExchange({ access_token: 'nope' })

    renderWith(cognitoConfig)

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('error'),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an exchange failure without authenticating', async () => {
    primeFlow()
    setUrl('?code=auth-code&state=the-state')
    stubExchange({ error: 'invalid_grant' }, false)

    renderWith(cognitoConfig)

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('error'),
    )
    expect(sessionToken()).toBeNull()
  })

  it('treats login_required from silent auth as simply signed out', async () => {
    setUrl('?error=login_required')
    renderWith(cognitoConfig)

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    )
    // Not an error state: this is the normal "no session yet" outcome.
    expect(screen.getByTestId('error')).toHaveTextContent('')
  })

  it('treats an unexpected provider error as a failure', async () => {
    setUrl('?error=server_error')
    renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('error'),
    )
  })
})

// --------------------------------------------------------------- logout

describe('logout', () => {
  it('clears the in-memory token and ends the Cognito session', async () => {
    sessionStorage.setItem('visioniq.pkce.verifier', 'v')
    sessionStorage.setItem('visioniq.pkce.state', 's')
    setUrl('?code=c&state=s')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at', expires_in: 3600 }),
      }),
    )

    renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    )

    await userEvent.click(screen.getByText('logout'))

    expect(sessionToken()).toBeNull()
    const logoutUrl = assign.mock.calls.at(-1)![0] as string
    // Must hit the hosted-UI logout, or silent auth would restore the session.
    expect(logoutUrl).toContain('/logout')
    expect(logoutUrl).toContain('client_id=abc123clientid')
  })

  it('skips silent re-auth after a deliberate sign-out', async () => {
    // Simulates the page load that follows the Cognito /logout redirect.
    sessionStorage.setItem('visioniq.auth.signedOut', '1')
    renderWith(cognitoConfig)

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    )
    // Bouncing through the provider here would be guaranteed to fail.
    expect(assign).not.toHaveBeenCalled()
    // The hint is one-shot: a later reload resumes normal silent auth.
    expect(sessionStorage.getItem('visioniq.auth.signedOut')).toBeNull()
  })

  it('resumes silent re-auth on the next load after sign-out', async () => {
    renderWith(cognitoConfig)
    await waitFor(() => expect(assign).toHaveBeenCalled())
    expect(new URL(assign.mock.calls[0][0] as string).searchParams.get('prompt')).toBe(
      'none',
    )
  })

  it('does not silently reauthenticate after sign-out, even on reload', async () => {
    sessionStorage.setItem('visioniq.auth.signedOut', '1')
    const { unmount } = renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    )
    expect(assign).not.toHaveBeenCalled()
    unmount()
  })

  it('signs out locally without a provider round trip', async () => {
    renderWith({ mode: 'local' })
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    )
    await userEvent.click(screen.getByText('logout'))
    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated')
  })
})

// ------------------------------------------------------- expiry handling

describe('session expiry', () => {
  it('moves to the expired state shortly before the token runs out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    sessionStorage.setItem('visioniq.pkce.verifier', 'v')
    sessionStorage.setItem('visioniq.pkce.state', 's')
    setUrl('?code=c&state=s')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        // 90s lifetime: the 60s skew means refresh fires after ~30s.
        json: async () => ({ access_token: 'at', expires_in: 90 }),
      }),
    )

    renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    )

    await vi.advanceTimersByTimeAsync(31_000)

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('expired'),
    )
    expect(sessionToken()).toBeNull()
  })

  it('treats a 401 from the API as an ended session', async () => {
    // Covers the race where the token expires between the scheduled refresh
    // and a request, or is revoked server-side.
    sessionStorage.setItem('visioniq.pkce.verifier', 'v')
    sessionStorage.setItem('visioniq.pkce.state', 's')
    setUrl('?code=c&state=s')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'at', expires_in: 3600 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    )

    // Next API call is rejected as unauthenticated.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({ success: false, error: 'unauthenticated', detail: 'no' }),
    })
    const { listAnalyses } = await import('../api/client')
    await expect(listAnalyses({})).rejects.toThrow()

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('expired'),
    )
    expect(sessionToken()).toBeNull()
  })

  it('does not end the session on a non-401 API error', async () => {
    sessionStorage.setItem('visioniq.pkce.verifier', 'v')
    sessionStorage.setItem('visioniq.pkce.state', 's')
    setUrl('?code=c&state=s')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'at', expires_in: 3600 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    )

    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ detail: 'boom' }),
    })
    const { listAnalyses } = await import('../api/client')
    await expect(listAnalyses({})).rejects.toThrow()

    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
  })

  it('withholds an expired token from the API client', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    sessionStorage.setItem('visioniq.pkce.verifier', 'v')
    sessionStorage.setItem('visioniq.pkce.state', 's')
    setUrl('?code=c&state=s')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at', expires_in: 90 }),
      }),
    )

    renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    )

    await vi.advanceTimersByTimeAsync(31_000)
    // Rather than send a token the backend will reject, send none.
    await expect(clientToken()).resolves.toBeNull()
  })
})

// ------------------------------------------------- reliability (Phase 3.7)

describe('redirect loop protection', () => {
  it('stops redirecting after the silent-auth budget is spent', async () => {
    // Simulates a provider that keeps returning us here with no code and no
    // error — without a cap this would redirect on every single load.
    sessionStorage.setItem('visioniq.auth.silentAttempts', '2')

    renderWith(cognitoConfig)

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    )
    expect(assign).not.toHaveBeenCalled()
  })

  it('counts each silent attempt', async () => {
    renderWith(cognitoConfig)
    await waitFor(() => expect(assign).toHaveBeenCalled())
    expect(Number(sessionStorage.getItem('visioniq.auth.silentAttempts'))).toBe(1)
  })

  it('spends the budget when the provider says there is no session', async () => {
    // Avoids a pointless round trip on every subsequent reload.
    setUrl('?error=login_required')
    renderWith(cognitoConfig)

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    )
    expect(
      Number(sessionStorage.getItem('visioniq.auth.silentAttempts')),
    ).toBeGreaterThanOrEqual(2)
  })

  it('lets an explicit sign-in through even when the budget is spent', async () => {
    sessionStorage.setItem('visioniq.auth.silentAttempts', '5')
    renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'),
    )

    await userEvent.click(screen.getByText('login'))

    await waitFor(() => expect(assign).toHaveBeenCalled())
    expect(new URL(assign.mock.calls.at(-1)![0] as string).searchParams.get('prompt')).toBeNull()
  })

  it('restores the budget after a successful sign-in', async () => {
    sessionStorage.setItem('visioniq.auth.silentAttempts', '1')
    sessionStorage.setItem('visioniq.pkce.verifier', 'v')
    sessionStorage.setItem('visioniq.pkce.state', 's')
    setUrl('?code=c&state=s')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at', expires_in: 3600 }),
      }),
    )

    renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated'),
    )
    expect(sessionStorage.getItem('visioniq.auth.silentAttempts')).toBeNull()
  })
})

describe('blocked browser storage', () => {
  function blockStorage() {
    const thrower = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    vi.stubGlobal('sessionStorage', {
      getItem: thrower,
      setItem: thrower,
      removeItem: thrower,
    })
  }

  it('explains the problem instead of looping', async () => {
    blockStorage()
    renderWith(cognitoConfig)

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('error'),
    )
    expect(screen.getByTestId('error').textContent).toMatch(/storage|cookies/i)
    // Critically: it must not have redirected into a flow it cannot finish.
    expect(assign).not.toHaveBeenCalled()
  })

  it('gives the same clear error on an explicit sign-in attempt', async () => {
    blockStorage()
    renderWith(cognitoConfig)
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('error'),
    )

    await userEvent.click(screen.getByText('login'))
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toMatch(/storage|cookies/i),
    )
  })
})

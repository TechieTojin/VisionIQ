import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { setTokenProvider } from '../api/auth'
import { onUnauthorized } from '../api/client'
import { AuthContext, type AuthStatus, type AuthUser } from './context'
import {
  AuthFlowError,
  buildAuthorizeUrl,
  buildLogoutUrl,
  exchangeCodeForTokens,
  readClaimsUnsafe,
} from './cognito'
import { resolveAuthConfig, type AuthConfig } from './config'
import {
  clearFlow,
  clearSignedOut,
  consumeFlow,
  countSilentAttempt,
  markSignedOut,
  MAX_SILENT_ATTEMPTS,
  peekSignedOut,
  resetSilentAttempts,
  silentAttempts,
  stashFlow,
  statesMatch,
  storageAvailable,
} from './pkce'
import {
  clearSession,
  getAccessToken,
  msUntilRefresh,
  setSession,
} from './session'

interface AuthProviderProps {
  children: React.ReactNode
  /** Injectable for tests; defaults to the env-derived config. */
  config?: AuthConfig
}

const LOCAL_USER: AuthUser = { subject: 'local', email: null }

/** Strip OAuth parameters from the address bar without reloading. */
function scrubCallbackParams(): void {
  try {
    const url = new URL(window.location.href)
    for (const key of ['code', 'state', 'error', 'error_description']) {
      url.searchParams.delete(key)
    }
    window.history.replaceState({}, '', url.pathname + url.search + url.hash)
  } catch {
    // Non-fatal; the parameters are single-use anyway.
  }
}

export function AuthProvider({ children, config: injected }: AuthProviderProps) {
  const config = useMemo(() => injected ?? resolveAuthConfig(), [injected])

  // Pure read of the callback parameters. Reading the URL has no side
  // effects, so it can happen during render — which lets the initial status
  // be derived rather than set from inside an effect.
  const callback = useMemo(() => {
    if (typeof window === 'undefined') {
      return { code: null, state: null, error: null }
    }
    const params = new URLSearchParams(window.location.search)
    return {
      code: params.get('code'),
      state: params.get('state'),
      error: params.get('error'),
    }
  }, [])

  // `login_required` and friends are the normal result of a silent auth
  // attempt when no session exists — not a failure.
  const benignProviderError =
    callback.error === 'login_required' ||
    callback.error === 'interaction_required' ||
    callback.error === 'consent_required'

  // Pure read; the flag is cleared from an effect below.
  const justSignedOut = useMemo(() => peekSignedOut(), [])

  // Pure read of the loop budget, so the initial status can reflect it.
  const silentBudgetSpent = useMemo(
    () => silentAttempts() >= MAX_SILENT_ATTEMPTS,
    [],
  )

  const [status, setStatus] = useState<AuthStatus>(() => {
    if (config.mode === 'misconfigured') return 'misconfigured'
    if (config.mode === 'local') return 'authenticated'
    if (callback.error) return benignProviderError ? 'unauthenticated' : 'error'
    if (callback.code) return 'authenticating'
    // A deliberate sign-out means silent re-auth is certain to fail, so go
    // straight to the login screen instead of bouncing through Cognito.
    if (justSignedOut) return 'unauthenticated'
    // Loop guard: stop redirecting and let the user sign in interactively.
    if (silentBudgetSpent) return 'unauthenticated'
    return 'initialising'
  })
  const [user, setUser] = useState<AuthUser | null>(() =>
    config.mode === 'local' ? LOCAL_USER : null,
  )
  const [error, setError] = useState<string | null>(() => {
    if (config.mode === 'misconfigured') return config.reason
    if (callback.error && !benignProviderError) {
      return 'Sign-in was not completed. Please try again.'
    }
    return null
  })

  // Guards against React 18 StrictMode double-invoking the callback effect,
  // which would redeem a single-use authorization code twice.
  const bootstrapped = useRef(false)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The API client pulls the token from the in-memory store on every request.
  useEffect(() => {
    if (config.mode === 'local') {
      setTokenProvider(null)
      return
    }
    setTokenProvider(() => getAccessToken())
    return () => setTokenProvider(null)
  }, [config])

  /**
   * Navigate to the hosted UI. Throws on failure rather than setting state,
   * so callers decide how to surface it from a promise callback.
   */
  const redirectToProvider = useCallback(
    async (silent: boolean) => {
      if (config.mode !== 'cognito') return

      if (!storageAvailable()) {
        // Without storage the verifier cannot survive the redirect, so the
        // flow is guaranteed to fail. Say so instead of looping.
        throw new AuthFlowError(
          'storage_blocked',
          'Sign-in needs browser storage, which appears to be blocked. ' +
            'Enable cookies and site data for this site, or try a normal ' +
            '(non-private) window.',
        )
      }

      const { url, verifier, state } = await buildAuthorizeUrl(config, {
        silent,
      })

      if (!stashFlow(verifier, state, window.location.pathname)) {
        throw new AuthFlowError(
          'storage_blocked',
          'Sign-in could not store its security token. Enable cookies and ' +
            'site data for this site, then try again.',
        )
      }

      window.location.assign(url)
    },
    [config],
  )

  const reportRedirectFailure = useCallback((err: unknown) => {
    setError(
      err instanceof AuthFlowError
        ? err.message
        : 'Could not start sign-in. Please try again.',
    )
    setStatus('error')
  }, [])

  const login = useCallback(() => {
    if (config.mode !== 'cognito') return
    setError(null)
    setStatus('authenticating')
    // An explicit sign-in is a fresh start: clear the silent-auth budget so
    // a previous failed restore cannot block an interactive attempt.
    resetSilentAttempts()
    clearSignedOut()
    redirectToProvider(false).catch(reportRedirectFailure)
  }, [config, redirectToProvider, reportRedirectFailure])

  const logout = useCallback(() => {
    clearSession()
    clearFlow()
    setUser(null)
    if (config.mode === 'cognito') {
      // Remember the intent so the post-logout load lands on the login
      // screen rather than bouncing through a doomed silent re-auth.
      markSignedOut()
      // Full hosted-UI logout, so Cognito's own session cookie is cleared
      // too. Without this, "sign out" would be undone by a silent re-auth.
      window.location.assign(buildLogoutUrl(config))
      return
    }
    setStatus('unauthenticated')
  }, [config])

  const reset = useCallback(() => {
    clearSession()
    clearFlow()
    setUser(null)
    setError(null)
    setStatus('unauthenticated')
  }, [])

  const adoptTokens = useCallback(
    (tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>) => {
      setSession(tokens)
      // A successful sign-in restores the silent-auth budget.
      resetSilentAttempts()
      // Claims are read for display only; the backend does the verifying.
      const claims =
        readClaimsUnsafe(tokens.idToken ?? tokens.accessToken) ?? {}
      setUser({
        subject: String(claims.sub ?? ''),
        email:
          typeof claims.email === 'string' && claims.email ? claims.email : null,
      })
      setError(null)
      setStatus('authenticated')
    },
    [],
  )

  // --- bootstrap: handle a callback, or try to restore a session ----------
  useEffect(() => {
    // Local and misconfigured modes need no provider interaction at all.
    if (config.mode !== 'cognito') return
    if (bootstrapped.current) return
    bootstrapped.current = true

    // Cognito reports a failed `prompt=none` attempt as an error redirect.
    // The resulting status was already derived at render; just clean up.
    if (callback.error) {
      consumeFlow()
      scrubCallbackParams()
      if (benignProviderError) {
        // Cognito has definitively said there is no session. Spend the
        // budget so a reload shows the login screen immediately instead of
        // paying for another pointless round trip.
        while (silentAttempts() < MAX_SILENT_ATTEMPTS) countSilentAttempt()
      }
      return
    }

    if (callback.code) {
      // Validation and exchange run inside a promise chain, so every state
      // transition happens in an async callback rather than synchronously
      // in the effect body.
      const code = callback.code
      const returnedState = callback.state

      void (async () => {
        const { verifier, state: expectedState } = consumeFlow()
        scrubCallbackParams()

        if (!verifier) {
          throw new AuthFlowError(
            'stale_flow',
            'This sign-in link is no longer valid. Please start sign-in again.',
          )
        }
        if (!statesMatch(expectedState, returnedState)) {
          // A mismatched state means this callback was not initiated by
          // this tab — the CSRF defence for the authorization code flow.
          throw new AuthFlowError(
            'state_mismatch',
            'Sign-in failed a security check. Please try again.',
          )
        }

        return exchangeCodeForTokens(config, code, verifier)
      })()
        .then(adoptTokens)
        .catch((err: unknown) => {
          setError(
            err instanceof AuthFlowError
              ? err.message
              : 'Sign-in could not be completed.',
          )
          setStatus('error')
        })
      return
    }

    if (justSignedOut) {
      clearSignedOut()
      return
    }

    // Loop guard already tripped: the initial status is `unauthenticated`,
    // so show the login screen rather than redirecting again.
    if (silentBudgetSpent) return

    // No callback parameters: try to restore a session silently. If Cognito
    // still has a session this returns a fresh code with no interaction;
    // otherwise it redirects back with login_required, handled above.
    countSilentAttempt()
    redirectToProvider(true).catch(reportRedirectFailure)
  }, [
    config,
    adoptTokens,
    redirectToProvider,
    reportRedirectFailure,
    callback,
    justSignedOut,
    silentBudgetSpent,
    benignProviderError,
  ])

  // --- expiry: re-authenticate shortly before the token runs out ----------
  useEffect(() => {
    if (status !== 'authenticated' || config.mode !== 'cognito') return

    const delay = msUntilRefresh()
    refreshTimer.current = setTimeout(() => {
      // No refresh token by design, so "refresh" is a silent re-auth. If the
      // Cognito session has also ended, the callback reports login_required
      // and the user lands on the session-expired screen.
      clearSession()
      setStatus('expired')
    }, delay)

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
  }, [status, config])

  // --- a 401 from the API means the session is no longer usable -----------
  useEffect(() => {
    if (config.mode !== 'cognito') return
    return onUnauthorized(() => {
      clearSession()
      setStatus((prev) => (prev === 'authenticated' ? 'expired' : prev))
    })
  }, [config])

  const value = useMemo(
    () => ({
      status,
      mode: config.mode,
      user,
      error,
      busy: status === 'authenticating' || status === 'initialising',
      login,
      logout,
      reset,
    }),
    [status, config.mode, user, error, login, logout, reset],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

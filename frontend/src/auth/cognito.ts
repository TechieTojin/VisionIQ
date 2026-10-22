/**
 * Cognito hosted-UI integration: authorization code flow with PKCE.
 *
 * Deliberately dependency-free — no Amplify. The flow is three URLs and one
 * POST, and a hand-rolled implementation keeps the security-relevant steps
 * visible and testable.
 *
 * REFRESH TOKENS ARE DISCARDED. Cognito returns one on the code exchange; we
 * drop it on the floor and never store it anywhere. A refresh token is a
 * long-lived credential (30 days by Terraform default), and the only places a
 * SPA could keep one are JS-readable, so an XSS would yield month-long
 * account access. Session continuity instead comes from `prompt=none` silent
 * re-authentication against Cognito's own session cookie — see
 * `buildAuthorizeUrl({ silent: true })`.
 *
 * If persistent sessions are later required, the correct answer is a
 * backend-for-frontend holding the refresh token in an HttpOnly, Secure,
 * SameSite cookie, not browser storage. See docs/security/threat-model.md.
 */

import type { CognitoConfig } from './config'
import { createCodeChallenge, createCodeVerifier, createState } from './pkce'

export class AuthFlowError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AuthFlowError'
    this.code = code
  }
}

/** The subset of a token response we are prepared to use. */
export interface TokenSet {
  accessToken: string
  idToken: string | null
  /** Absolute epoch milliseconds at which the access token expires. */
  expiresAt: number
}

export interface AuthorizeRequest {
  url: string
  verifier: string
  state: string
}

/**
 * Build the hosted-UI authorize URL.
 *
 * `silent: true` adds `prompt=none`, which asks Cognito to issue a code only
 * if an existing session is present, and to redirect back with an error
 * otherwise rather than showing a login form.
 */
export async function buildAuthorizeUrl(
  config: CognitoConfig,
  options: { silent?: boolean } = {},
): Promise<AuthorizeRequest> {
  const verifier = createCodeVerifier()
  const state = createState()
  const challenge = await createCodeChallenge(verifier)

  const params = new URLSearchParams({
    // Authorization CODE flow. Never "token" — the implicit flow would put
    // an access token in the URL fragment, where it leaks via history,
    // referrers and extensions.
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  if (options.silent) params.set('prompt', 'none')

  return {
    url: `${config.domain}/oauth2/authorize?${params.toString()}`,
    verifier,
    state,
  }
}

/** Hosted-UI logout URL. Clears Cognito's own session, then returns here. */
export function buildLogoutUrl(config: CognitoConfig): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: config.logoutUri,
  })
  return `${config.domain}/logout?${params.toString()}`
}

/**
 * Exchange an authorization code for tokens.
 *
 * No client secret is sent: the client is public and PKCE is what proves
 * legitimacy. The returned refresh token is intentionally dropped.
 */
export async function exchangeCodeForTokens(
  config: CognitoConfig,
  code: string,
  verifier: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  })

  let response: Response
  try {
    response = await fetch(`${config.domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch {
    throw new AuthFlowError(
      'network_error',
      'Could not reach the identity provider. Check your connection and try again.',
    )
  }

  if (!response.ok) {
    // Never surface the response body: it can echo request parameters.
    throw new AuthFlowError(
      'exchange_failed',
      `Sign-in could not be completed (provider returned ${response.status}).`,
    )
  }

  let payload: Record<string, unknown>
  try {
    payload = await response.json()
  } catch {
    throw new AuthFlowError(
      'exchange_failed',
      'The identity provider returned an unreadable response.',
    )
  }

  const accessToken = payload.access_token
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new AuthFlowError(
      'exchange_failed',
      'The identity provider did not return an access token.',
    )
  }

  const tokenType = String(payload.token_type ?? '').toLowerCase()
  if (tokenType && tokenType !== 'bearer') {
    throw new AuthFlowError(
      'exchange_failed',
      `Unsupported token type "${tokenType}".`,
    )
  }

  const expiresIn = Number(payload.expires_in)
  const lifetimeMs =
    Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000

  // payload.refresh_token is deliberately NOT read, returned, or stored.

  return {
    accessToken,
    idToken: typeof payload.id_token === 'string' ? payload.id_token : null,
    expiresAt: Date.now() + lifetimeMs,
  }
}

/**
 * Read non-sensitive claims from a JWT for display purposes only.
 *
 * This performs NO verification and its output must never drive an
 * authorization decision — the backend verifies the signature, issuer,
 * audience and expiry. It exists so the UI can show who is signed in.
 */
export function readClaimsUnsafe(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** Extract the error code Cognito appends to a failed silent-auth redirect. */
export function readCallbackError(params: URLSearchParams): string | null {
  const error = params.get('error')
  if (!error) return null
  return error
}

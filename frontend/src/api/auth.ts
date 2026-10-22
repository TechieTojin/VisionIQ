/**
 * Bearer-token plumbing for the API client.
 *
 * In local mode (`VISIONIQ_AUTH_MODE=none`) there is no token and every
 * request is the pseudo-tenant `local`. When the backend runs behind the
 * Cognito-backed API Gateway, every call must carry
 * `Authorization: Bearer <access token>` or the gateway returns 401.
 *
 * The token is held in memory only. It is deliberately NOT written to
 * localStorage or sessionStorage: anything persisted there is readable by
 * any script on the origin, which turns one XSS into stolen credentials.
 * Session continuity is the identity provider's job (Cognito refresh via
 * its hosted UI or SRP flow), not this module's.
 */

type TokenProvider = () => string | null | Promise<string | null>

let tokenProvider: TokenProvider | null = null

/**
 * Register how the app obtains an access token. Call this once during
 * sign-in wiring, e.g. with the Amplify/Cognito session accessor.
 */
export function setTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider
}

/** Current access token, or null when running unauthenticated. */
export async function getAccessToken(): Promise<string | null> {
  if (!tokenProvider) return null
  try {
    return (await tokenProvider()) ?? null
  } catch {
    return null
  }
}

/** Authorization header for a request, or an empty object when anonymous. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

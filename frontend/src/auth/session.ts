/**
 * In-memory session store.
 *
 * Tokens live in a module-scoped variable and nowhere else: not
 * localStorage, not sessionStorage, not a cookie readable by JS, not the URL.
 * A page reload therefore starts with no token, which is intentional — the
 * app attempts a silent re-auth instead of persisting a credential.
 */

import type { TokenSet } from './cognito'

/** Re-authenticate this many ms before actual expiry, to avoid a 401 race. */
export const EXPIRY_SKEW_MS = 60_000

let current: TokenSet | null = null

export function setSession(tokens: TokenSet | null): void {
  current = tokens
}

export function clearSession(): void {
  current = null
}

/** The raw access token, or null if absent or expired. */
export function getAccessToken(): string | null {
  if (!current) return null
  if (isExpired(current)) return null
  return current.accessToken
}

export function getSession(): TokenSet | null {
  return current
}

export function isExpired(tokens: TokenSet | null = current): boolean {
  if (!tokens) return true
  return Date.now() >= tokens.expiresAt - EXPIRY_SKEW_MS
}

/** Milliseconds until the token should be refreshed. Never negative. */
export function msUntilRefresh(tokens: TokenSet | null = current): number {
  if (!tokens) return 0
  return Math.max(0, tokens.expiresAt - EXPIRY_SKEW_MS - Date.now())
}

/**
 * PKCE (RFC 7636) helpers for the authorization code flow.
 *
 * Why PKCE: the Cognito app client is public and has no secret, so an
 * intercepted authorization code could otherwise be redeemed by anyone. The
 * code_verifier proves the redeemer is the same party that started the flow.
 * S256 only — the `plain` method defeats the purpose.
 *
 * TRANSIENT STORAGE NOTE
 * The verifier and state must survive a full-page redirect to Cognito and
 * back, so they cannot live in memory. They are kept in `sessionStorage` and
 * deleted the moment the code is exchanged.
 *
 * This is NOT a violation of the "no tokens in web storage" rule: a verifier
 * is not a credential. It is single-use, worthless without the matching
 * authorization code, scoped to one tab, and gone within seconds. Access and
 * refresh tokens never touch any storage.
 */

const VERIFIER_KEY = 'visioniq.pkce.verifier'
const STATE_KEY = 'visioniq.pkce.state'
const RETURN_KEY = 'visioniq.pkce.return'

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/** A high-entropy code verifier (RFC 7636 allows 43-128 characters). */
export function createCodeVerifier(): string {
  return base64UrlEncode(randomBytes(64))
}

/** An unguessable value binding the callback to this request (CSRF defence). */
export function createState(): string {
  return base64UrlEncode(randomBytes(32))
}

/** S256 challenge derived from the verifier. */
export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  return base64UrlEncode(new Uint8Array(digest))
}

/** Persist the one-time flow values across the redirect. */
/**
 * Is sessionStorage usable at all?
 *
 * Blocked storage (private mode, "block all cookies", enterprise policy)
 * makes PKCE impossible: the verifier cannot survive the redirect. Detecting
 * this up front lets the UI explain the problem instead of bouncing the user
 * through a redirect that can only fail.
 */
export function storageAvailable(): boolean {
  try {
    const probe = '__visioniq_probe__'
    sessionStorage.setItem(probe, '1')
    sessionStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

/** Persist the one-time flow values. Returns false if storage is blocked. */
export function stashFlow(
  verifier: string,
  state: string,
  returnTo?: string,
): boolean {
  try {
    sessionStorage.setItem(VERIFIER_KEY, verifier)
    sessionStorage.setItem(STATE_KEY, state)
    if (returnTo) sessionStorage.setItem(RETURN_KEY, returnTo)
    // Confirm it actually persisted: some browsers accept the write and
    // silently drop it.
    return sessionStorage.getItem(VERIFIER_KEY) === verifier
  } catch {
    return false
  }
}

export interface StashedFlow {
  verifier: string | null
  state: string | null
  returnTo: string | null
}

/** Read and immediately clear the stashed values. Always single-use. */
export function consumeFlow(): StashedFlow {
  let verifier: string | null = null
  let state: string | null = null
  let returnTo: string | null = null
  try {
    verifier = sessionStorage.getItem(VERIFIER_KEY)
    state = sessionStorage.getItem(STATE_KEY)
    returnTo = sessionStorage.getItem(RETURN_KEY)
  } catch {
    // ignore
  }
  clearFlow()
  return { verifier, state, returnTo }
}

const SIGNED_OUT_KEY = 'visioniq.auth.signedOut'
const SILENT_ATTEMPT_KEY = 'visioniq.auth.silentAttempts'

/**
 * Hard cap on consecutive silent-auth redirects.
 *
 * Silent auth normally ends in one round trip: either a code, or
 * `error=login_required`. If a misconfigured provider redirects back with
 * neither, the app would redirect again on every load — an infinite loop
 * that burns through the browser's history and never shows the user
 * anything. This counter breaks that cycle and surfaces the login screen.
 */
export const MAX_SILENT_ATTEMPTS = 2

export function countSilentAttempt(): number {
  try {
    const next = (Number(sessionStorage.getItem(SILENT_ATTEMPT_KEY)) || 0) + 1
    sessionStorage.setItem(SILENT_ATTEMPT_KEY, String(next))
    return next
  } catch {
    // No storage means no PKCE anyway; treat as exhausted so we do not loop.
    return MAX_SILENT_ATTEMPTS + 1
  }
}

export function silentAttempts(): number {
  try {
    return Number(sessionStorage.getItem(SILENT_ATTEMPT_KEY)) || 0
  } catch {
    return 0
  }
}

export function resetSilentAttempts(): void {
  try {
    sessionStorage.removeItem(SILENT_ATTEMPT_KEY)
  } catch {
    // ignore
  }
}

/**
 * Record that the user signed out deliberately, so the next load shows the
 * login screen instead of bouncing through a silent re-auth that is certain
 * to fail. This is a UI hint, not a credential, and it is cleared on read.
 */
export function markSignedOut(): void {
  try {
    sessionStorage.setItem(SIGNED_OUT_KEY, '1')
  } catch {
    // ignore
  }
}

/** Pure read — safe to call during render (and under StrictMode). */
export function peekSignedOut(): boolean {
  try {
    return sessionStorage.getItem(SIGNED_OUT_KEY) === '1'
  } catch {
    return false
  }
}

/** Clear the hint. Called from an effect, where side effects belong. */
export function clearSignedOut(): void {
  try {
    sessionStorage.removeItem(SIGNED_OUT_KEY)
  } catch {
    // ignore
  }
}

export function clearFlow(): void {
  try {
    sessionStorage.removeItem(VERIFIER_KEY)
    sessionStorage.removeItem(STATE_KEY)
    sessionStorage.removeItem(RETURN_KEY)
  } catch {
    // ignore
  }
}

/** Constant-time-ish comparison for the state parameter. */
export function statesMatch(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

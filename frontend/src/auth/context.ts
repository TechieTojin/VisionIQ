/**
 * Auth context definition.
 *
 * Kept separate from the provider component so that module only exports a
 * component (React Fast Refresh requires this).
 */

import { createContext } from 'react'

export type AuthStatus =
  | 'initialising' // deciding whether a session can be restored
  | 'authenticating' // exchanging a code, or redirecting to the provider
  | 'authenticated'
  | 'unauthenticated'
  | 'expired' // had a session, it ran out
  | 'error' // sign-in failed
  | 'misconfigured' // fail-closed: config is unusable

export interface AuthUser {
  /** Verified subject from the provider; the backend's tenant key. */
  subject: string
  email: string | null
}

export interface AuthContextValue {
  status: AuthStatus
  mode: 'local' | 'cognito' | 'misconfigured'
  user: AuthUser | null
  error: string | null
  /** True while any provider round-trip is in flight. */
  busy: boolean
  login: () => void
  logout: () => void
  /** Clear a terminal error state and return to the login screen. */
  reset: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

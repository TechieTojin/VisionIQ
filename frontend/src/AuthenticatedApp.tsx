import Dashboard from './App'
import { AuthGate } from './components/AuthScreens'
import { useAuth } from './auth/useAuth'

/**
 * Gates the dashboard behind a valid session.
 *
 * In local mode the provider reports `authenticated` immediately, so the
 * dashboard renders exactly as it did before auth existed.
 */
export function AuthenticatedApp() {
  const { status, error, busy, login, logout, reset, user, mode } = useAuth()

  if (status !== 'authenticated') {
    return (
      <AuthGate
        status={status}
        error={error}
        busy={busy}
        onLogin={login}
        onReset={reset}
      />
    )
  }

  return <Dashboard user={user} mode={mode} onLogout={logout} />
}

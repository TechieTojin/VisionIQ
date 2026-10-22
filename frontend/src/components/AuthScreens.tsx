import type { AuthStatus } from '../auth/context'

interface ShellProps {
  children: React.ReactNode
}

function AuthShell({ children }: ShellProps) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand brand--center">
          <span className="brand__mark">◆</span>
          <div>
            <h1>VisionIQ</h1>
            <p>Retail Shelf Intelligence</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

export function LoadingScreen({ message }: { message?: string }) {
  return (
    <AuthShell>
      <div className="auth-body" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <p className="muted">{message ?? 'Restoring your session…'}</p>
      </div>
    </AuthShell>
  )
}

export function LoginScreen({
  onLogin,
  busy,
}: {
  onLogin: () => void
  busy: boolean
}) {
  return (
    <AuthShell>
      <div className="auth-body">
        <h2>Sign in</h2>
        <p className="muted">
          VisionIQ uses your organisation&apos;s identity provider. Your scans
          and uploaded images are visible only to you.
        </p>
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={onLogin}
          disabled={busy}
        >
          {busy ? 'Redirecting…' : 'Continue to sign in'}
        </button>
      </div>
    </AuthShell>
  )
}

export function SessionExpiredScreen({
  onLogin,
  busy,
}: {
  onLogin: () => void
  busy: boolean
}) {
  return (
    <AuthShell>
      {/* role="status" (not alert): expected, non-urgent. */}
      <div className="auth-body" role="status" aria-live="polite">
        <span className="badge badge--warn">Session expired</span>
        <h2>Your session has ended</h2>
        <p className="muted">
          For security, sessions expire after a period of inactivity. Sign in
          again to continue — nothing you analysed has been lost.
        </p>
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={onLogin}
          disabled={busy}
        >
          {busy ? 'Redirecting…' : 'Sign in again'}
        </button>
      </div>
    </AuthShell>
  )
}

export function AuthErrorScreen({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <AuthShell>
      {/* role="alert" so a screen reader announces the failure immediately. */}
      <div className="auth-body" role="alert">
        <span className="badge badge--error">Sign-in failed</span>
        <h2>Could not sign you in</h2>
        <p className="muted">{message}</p>
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    </AuthShell>
  )
}

/**
 * Shown when configuration is unusable — notably a production build left in
 * local-bypass mode. This is a deliberate dead end: the app must not run.
 */
export function MisconfiguredScreen({ reason }: { reason: string }) {
  return (
    <AuthShell>
      <div className="auth-body" role="alert">
        <span className="badge badge--error">Configuration error</span>
        <h2>Authentication is not configured</h2>
        <p className="muted">{reason}</p>
        <p className="disclaimer">
          VisionIQ refuses to start rather than run without authentication.
          This is a deployment configuration problem — see
          <code> docs/deployment/aws.md</code>.
        </p>
      </div>
    </AuthShell>
  )
}

/** Routes a non-authenticated status to the right screen. */
export function AuthGate({
  status,
  error,
  busy,
  onLogin,
  onReset,
}: {
  status: AuthStatus
  error: string | null
  busy: boolean
  onLogin: () => void
  onReset: () => void
}) {
  switch (status) {
    case 'misconfigured':
      return <MisconfiguredScreen reason={error ?? 'Unknown configuration error.'} />
    case 'initialising':
      return <LoadingScreen />
    case 'authenticating':
      return <LoadingScreen message="Completing sign-in…" />
    case 'expired':
      return <SessionExpiredScreen onLogin={onLogin} busy={busy} />
    case 'error':
      return (
        <AuthErrorScreen
          message={error ?? 'An unexpected error occurred.'}
          onRetry={onReset}
        />
      )
    default:
      return <LoginScreen onLogin={onLogin} busy={busy} />
  }
}

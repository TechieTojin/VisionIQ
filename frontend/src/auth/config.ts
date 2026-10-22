/**
 * Authentication configuration, resolved from Vite build-time env vars.
 *
 * FAIL-CLOSED RULE: a production build must never run in local-bypass mode,
 * and must never run with incomplete Cognito settings. Both cases yield a
 * `misconfigured` result that the UI renders as a hard error — it does not
 * silently degrade to "signed in".
 *
 * None of these values is a secret. The Cognito app client is a PUBLIC client
 * (`generate_secret = false` in Terraform), which is exactly why PKCE is
 * required: there is no client secret to authenticate the code exchange with.
 */

export type AuthMode = 'local' | 'cognito'

export interface CognitoConfig {
  mode: 'cognito'
  domain: string
  clientId: string
  issuer: string
  scopes: string
  redirectUri: string
  logoutUri: string
}

export interface LocalConfig {
  mode: 'local'
}

export interface MisconfiguredConfig {
  mode: 'misconfigured'
  reason: string
}

export type AuthConfig = CognitoConfig | LocalConfig | MisconfiguredConfig

const DEFAULT_SCOPES = 'openid email profile'

function normaliseDomain(raw: string): string {
  // Accept either a bare domain or a full URL; always return an https origin
  // with no trailing slash, so URL building is predictable.
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

/**
 * Resolve configuration.
 *
 * `isProd` is injected so tests can exercise the production fail-closed path
 * without a production build.
 */
export function resolveAuthConfig(
  env: ImportMetaEnv = import.meta.env,
  isProd: boolean = import.meta.env.PROD,
  origin: string = typeof window !== 'undefined'
    ? window.location.origin
    : 'http://localhost:5175',
): AuthConfig {
  const rawMode = (env.VITE_AUTH_MODE ?? (isProd ? 'cognito' : 'local'))
    .trim()
    .toLowerCase()

  if (rawMode === 'local') {
    if (isProd) {
      // The whole point of this check: a local bypass shipped to production
      // would authenticate every visitor as the same tenant.
      return {
        mode: 'misconfigured',
        reason:
          'VITE_AUTH_MODE=local is not permitted in a production build. ' +
          'Set VITE_AUTH_MODE=cognito and provide the Cognito settings.',
      }
    }
    return { mode: 'local' }
  }

  if (rawMode !== 'cognito') {
    return {
      mode: 'misconfigured',
      reason: `Unknown VITE_AUTH_MODE "${rawMode}". Expected "local" or "cognito".`,
    }
  }

  const domain = (env.VITE_COGNITO_DOMAIN ?? '').trim()
  const clientId = (env.VITE_COGNITO_CLIENT_ID ?? '').trim()

  const missing: string[] = []
  if (!domain) missing.push('VITE_COGNITO_DOMAIN')
  if (!clientId) missing.push('VITE_COGNITO_CLIENT_ID')
  if (missing.length > 0) {
    return {
      mode: 'misconfigured',
      reason: `Cognito mode requires ${missing.join(' and ')}.`,
    }
  }

  const redirectUri = (env.VITE_COGNITO_REDIRECT_URI ?? origin).trim()

  if (isProd && redirectUri.startsWith('http://')) {
    // An authorization code returned over plaintext is interceptable.
    return {
      mode: 'misconfigured',
      reason: 'The redirect URI must use https in production.',
    }
  }

  return {
    mode: 'cognito',
    domain: normaliseDomain(domain),
    clientId,
    issuer: (env.VITE_COGNITO_ISSUER ?? '').trim(),
    scopes: (env.VITE_COGNITO_SCOPES ?? DEFAULT_SCOPES).trim(),
    redirectUri,
    // Terraform registers the same bare origin for both callback and logout.
    logoutUri: redirectUri,
  }
}

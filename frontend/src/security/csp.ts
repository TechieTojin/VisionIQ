/**
 * Content Security Policy definition.
 *
 * This is the single source of truth for the policy. The production policy is
 * delivered by CloudFront's response-headers policy (Terraform
 * `modules/frontend`); this module mirrors it so the dev server can serve an
 * equivalent policy and so the whole thing is testable.
 *
 * DEVELOPMENT EXCEPTIONS (dev server only — never in the production policy):
 *   - `'unsafe-inline'` in script-src: Vite injects an inline module preload
 *     and the React Refresh runtime preamble.
 *   - `'unsafe-eval'` in script-src: some dependencies are transformed on the
 *     fly and esbuild's dev output can use eval for sourcemaps.
 *   - `ws:`/`wss:` in connect-src: hot module replacement uses a WebSocket.
 * The production build needs none of these.
 *
 * PRODUCTION NOTE: `style-src` retains `'unsafe-inline'`. Vite injects styles
 * at runtime and React inline `style={{}}` props are used throughout the
 * dashboard. Removing it requires per-request nonces, which CloudFront cannot
 * generate on a static origin. Inline *style* is far less dangerous than
 * inline script: it cannot execute JavaScript.
 */

export interface CspOrigins {
  /** API base, e.g. https://abc.execute-api.us-east-1.amazonaws.com */
  api?: string
  /** Cognito hosted UI, e.g. https://x.auth.us-east-1.amazoncognito.com */
  cognitoHostedUi?: string
  /** Cognito IDP, e.g. https://cognito-idp.us-east-1.amazonaws.com */
  cognitoIdp?: string
  /** S3 origin used for presigned PUT uploads. */
  uploadBucket?: string
  /** Anything else that must be reachable. */
  extra?: string[]
}

function clean(values: (string | undefined)[]): string[] {
  return values
    .filter((v): v is string => Boolean(v && v.trim()))
    .map((v) => v.trim().replace(/\/+$/, ''))
}

/**
 * Build the policy. `dev` relaxes exactly the directives the Vite dev server
 * needs and nothing else.
 */
export function buildCsp(origins: CspOrigins = {}, dev = false): string {
  const connect = clean([
    "'self'",
    origins.api,
    origins.cognitoHostedUi,
    origins.cognitoIdp,
    origins.uploadBucket,
    ...(origins.extra ?? []),
  ])
  if (dev) connect.push('ws:', 'wss:')

  const script = dev
    ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
    : ["'self'"]

  const formAction = clean(["'self'", origins.cognitoHostedUi])

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'none'"]],
    ['script-src', script],
    // See the production note above: inline style only, never inline script.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    // blob: is required — the dashboard previews uploads via
    // URL.createObjectURL. data: covers small inline icons.
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'"]],
    ['connect-src', connect],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['form-action', formAction],
    ['manifest-src', ["'self'"]],
    ['worker-src', ["'self'", 'blob:']],
  ]

  const policy = directives
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ')

  // Only meaningful over https; harmless but pointless on a dev server.
  return dev ? policy : `${policy}; upgrade-insecure-requests`
}

/** Security headers that accompany the CSP. */
export function securityHeaders(csp: string, dev = false): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
  }
  if (!dev) {
    // HSTS on a plaintext dev server would pin localhost to https.
    headers['Strict-Transport-Security'] =
      'max-age=63072000; includeSubDomains; preload'
  }
  return headers
}

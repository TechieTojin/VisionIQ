import { describe, expect, it } from 'vitest'
import { buildCsp, securityHeaders } from './csp'

const ORIGINS = {
  api: 'https://abc123.execute-api.us-east-1.amazonaws.com',
  cognitoHostedUi: 'https://visioniq-dev.auth.us-east-1.amazoncognito.com',
  cognitoIdp: 'https://cognito-idp.us-east-1.amazonaws.com',
  uploadBucket: 'https://visioniq-dev-images.s3.us-east-1.amazonaws.com',
}

function directive(csp: string, name: string): string[] {
  const match = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `) || part === name)
  return match ? match.split(/\s+/).slice(1) : []
}

describe('production CSP', () => {
  const csp = buildCsp(ORIGINS)

  it('denies everything by default', () => {
    expect(directive(csp, 'default-src')).toEqual(["'none'"])
  })

  it('allows NO unsafe script execution', () => {
    const script = directive(csp, 'script-src')
    expect(script).toEqual(["'self'"])
    expect(csp).not.toContain("'unsafe-eval'")
  })

  it('does not allow inline script anywhere', () => {
    // style-src keeps 'unsafe-inline'; script-src must not.
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'")
  })

  it('blocks framing and plugins', () => {
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"])
    expect(directive(csp, 'frame-src')).toEqual(["'none'"])
    expect(directive(csp, 'object-src')).toEqual(["'none'"])
  })

  it('pins base-uri so injected <base> cannot redirect script loads', () => {
    expect(directive(csp, 'base-uri')).toEqual(["'self'"])
  })

  it('permits exactly the backends the app must reach', () => {
    const connect = directive(csp, 'connect-src')
    expect(connect).toContain("'self'")
    expect(connect).toContain(ORIGINS.api)
    expect(connect).toContain(ORIGINS.cognitoHostedUi)
    expect(connect).toContain(ORIGINS.cognitoIdp)
    expect(connect).toContain(ORIGINS.uploadBucket)
  })

  it('does not open connect-src to the world', () => {
    expect(directive(csp, 'connect-src')).not.toContain('*')
  })

  it('allows blob: images for upload previews', () => {
    // The dashboard renders the selected file via URL.createObjectURL.
    expect(directive(csp, 'img-src')).toContain('blob:')
    expect(directive(csp, 'img-src')).toContain('data:')
  })

  it('restricts form submission to self and the identity provider', () => {
    const formAction = directive(csp, 'form-action')
    expect(formAction).toContain("'self'")
    expect(formAction).toContain(ORIGINS.cognitoHostedUi)
    expect(formAction).not.toContain('*')
  })

  it('upgrades insecure requests', () => {
    expect(csp).toContain('upgrade-insecure-requests')
  })

  it('omits empty origins rather than emitting blanks', () => {
    const minimal = buildCsp({})
    expect(minimal).not.toMatch(/\s{2,}/)
    expect(directive(minimal, 'connect-src')).toEqual(["'self'"])
  })

  it('strips trailing slashes from origins', () => {
    const csp2 = buildCsp({ api: 'https://api.example.com/' })
    expect(directive(csp2, 'connect-src')).toContain('https://api.example.com')
  })

  it('supports extra origins', () => {
    const csp2 = buildCsp({ extra: ['https://extra.example.com'] })
    expect(directive(csp2, 'connect-src')).toContain('https://extra.example.com')
  })
})

describe('development CSP', () => {
  const csp = buildCsp(ORIGINS, true)

  it('relaxes script-src only as far as HMR requires', () => {
    const script = directive(csp, 'script-src')
    expect(script).toContain("'unsafe-inline'")
    expect(script).toContain("'unsafe-eval'")
  })

  it('allows the HMR websocket', () => {
    expect(directive(csp, 'connect-src')).toContain('ws:')
  })

  it('keeps the structural protections even in dev', () => {
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"])
    expect(directive(csp, 'object-src')).toEqual(["'none'"])
    expect(directive(csp, 'default-src')).toEqual(["'none'"])
  })

  it('does not upgrade insecure requests on a plaintext dev server', () => {
    expect(csp).not.toContain('upgrade-insecure-requests')
  })
})

describe('security headers', () => {
  const headers = securityHeaders(buildCsp(ORIGINS), false)

  it('includes the CSP', () => {
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'")
  })

  it.each([
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ['X-Permitted-Cross-Domain-Policies', 'none'],
  ])('sets %s', (header, value) => {
    expect(headers[header]).toBe(value)
  })

  it('sets HSTS with a long max-age in production', () => {
    expect(headers['Strict-Transport-Security']).toContain('max-age=63072000')
    expect(headers['Strict-Transport-Security']).toContain('includeSubDomains')
  })

  it('disables powerful features the app never uses', () => {
    const permissions = headers['Permissions-Policy']
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
      expect(permissions).toContain(`${feature}=()`)
    }
  })

  it('omits HSTS on the dev server', () => {
    // Pinning localhost to https would break plaintext development.
    const dev = securityHeaders(buildCsp(ORIGINS, true), true)
    expect(dev['Strict-Transport-Security']).toBeUndefined()
  })
})

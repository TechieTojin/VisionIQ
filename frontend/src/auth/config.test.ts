import { describe, expect, it } from 'vitest'
import { resolveAuthConfig } from './config'

const COGNITO_ENV = {
  VITE_AUTH_MODE: 'cognito',
  VITE_COGNITO_DOMAIN: 'visioniq-dev.auth.us-east-1.amazoncognito.com',
  VITE_COGNITO_CLIENT_ID: 'abc123clientid',
} as ImportMetaEnv

describe('resolveAuthConfig — local mode', () => {
  it('defaults to local in a development build', () => {
    expect(resolveAuthConfig({} as ImportMetaEnv, false).mode).toBe('local')
  })

  it('allows an explicit local bypass in development', () => {
    const cfg = resolveAuthConfig(
      { VITE_AUTH_MODE: 'local' } as ImportMetaEnv,
      false,
    )
    expect(cfg.mode).toBe('local')
  })

  it('FAILS CLOSED when local mode reaches a production build', () => {
    // The critical regression guard: a shipped local bypass would
    // authenticate every visitor as the same tenant.
    const cfg = resolveAuthConfig(
      { VITE_AUTH_MODE: 'local' } as ImportMetaEnv,
      true,
    )
    expect(cfg.mode).toBe('misconfigured')
    expect(cfg.mode === 'misconfigured' && cfg.reason).toMatch(/not permitted/i)
  })

  it('defaults to cognito — never local — in a production build', () => {
    const cfg = resolveAuthConfig({} as ImportMetaEnv, true)
    // No Cognito settings supplied, so it must refuse rather than bypass.
    expect(cfg.mode).toBe('misconfigured')
  })
})

describe('resolveAuthConfig — cognito mode', () => {
  it('builds a usable config', () => {
    const cfg = resolveAuthConfig(COGNITO_ENV, false, 'http://localhost:5175')
    expect(cfg.mode).toBe('cognito')
    if (cfg.mode !== 'cognito') return
    expect(cfg.clientId).toBe('abc123clientid')
    expect(cfg.scopes).toBe('openid email profile')
  })

  it('normalises a bare domain to an https origin', () => {
    const cfg = resolveAuthConfig(COGNITO_ENV, false)
    expect(cfg.mode === 'cognito' && cfg.domain).toBe(
      'https://visioniq-dev.auth.us-east-1.amazoncognito.com',
    )
  })

  it('accepts a full URL and strips a trailing slash', () => {
    const cfg = resolveAuthConfig(
      { ...COGNITO_ENV, VITE_COGNITO_DOMAIN: 'https://example.auth.aws/' },
      false,
    )
    expect(cfg.mode === 'cognito' && cfg.domain).toBe('https://example.auth.aws')
  })

  it('defaults redirect_uri to the window origin, matching Terraform', () => {
    // Terraform registers bare origins (http://localhost:5175), and Cognito
    // requires an exact match, so no path may be appended.
    const cfg = resolveAuthConfig(COGNITO_ENV, false, 'http://localhost:5175')
    expect(cfg.mode === 'cognito' && cfg.redirectUri).toBe(
      'http://localhost:5175',
    )
  })

  it('uses the same URI for logout, as Terraform registers both', () => {
    const cfg = resolveAuthConfig(COGNITO_ENV, false, 'http://localhost:5175')
    expect(cfg.mode === 'cognito' && cfg.logoutUri).toBe(
      cfg.mode === 'cognito' ? cfg.redirectUri : '',
    )
  })

  it.each([
    ['VITE_COGNITO_DOMAIN', { ...COGNITO_ENV, VITE_COGNITO_DOMAIN: '' }],
    ['VITE_COGNITO_CLIENT_ID', { ...COGNITO_ENV, VITE_COGNITO_CLIENT_ID: '' }],
  ])('fails closed when %s is missing', (name, env) => {
    const cfg = resolveAuthConfig(env as ImportMetaEnv, false)
    expect(cfg.mode).toBe('misconfigured')
    expect(cfg.mode === 'misconfigured' && cfg.reason).toContain(name)
  })

  it('rejects a plaintext redirect URI in production', () => {
    const cfg = resolveAuthConfig(COGNITO_ENV, true, 'http://app.example.com')
    expect(cfg.mode).toBe('misconfigured')
    expect(cfg.mode === 'misconfigured' && cfg.reason).toMatch(/https/i)
  })

  it('accepts an https redirect URI in production', () => {
    const cfg = resolveAuthConfig(COGNITO_ENV, true, 'https://app.example.com')
    expect(cfg.mode).toBe('cognito')
  })

  it('rejects an unknown mode rather than guessing', () => {
    const cfg = resolveAuthConfig(
      { VITE_AUTH_MODE: 'disabled' } as ImportMetaEnv,
      false,
    )
    expect(cfg.mode).toBe('misconfigured')
  })
})

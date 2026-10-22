import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AuthFlowError,
  buildAuthorizeUrl,
  buildLogoutUrl,
  exchangeCodeForTokens,
  readClaimsUnsafe,
} from './cognito'
import type { CognitoConfig } from './config'
import { createCodeChallenge, createCodeVerifier, statesMatch } from './pkce'

const config: CognitoConfig = {
  mode: 'cognito',
  domain: 'https://visioniq-dev.auth.us-east-1.amazoncognito.com',
  clientId: 'abc123clientid',
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST',
  scopes: 'openid email profile',
  redirectUri: 'http://localhost:5175',
  logoutUri: 'http://localhost:5175',
}

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('authorize URL', () => {
  it('uses the authorization code flow, never implicit', async () => {
    const { url } = await buildAuthorizeUrl(config)
    const params = new URL(url).searchParams
    expect(params.get('response_type')).toBe('code')
    // An implicit flow would put the access token in the URL fragment.
    expect(params.get('response_type')).not.toBe('token')
  })

  it('sends an S256 PKCE challenge, not plain', async () => {
    const { url } = await buildAuthorizeUrl(config)
    const params = new URL(url).searchParams
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toBeTruthy()
  })

  it('does not leak the verifier into the URL', async () => {
    const { url, verifier } = await buildAuthorizeUrl(config)
    expect(url).not.toContain(verifier)
  })

  it('sends no client secret', async () => {
    const { url } = await buildAuthorizeUrl(config)
    expect(url).not.toMatch(/client_secret/)
  })

  it('targets the hosted UI authorize endpoint with the right client', async () => {
    const { url } = await buildAuthorizeUrl(config)
    expect(url.startsWith(`${config.domain}/oauth2/authorize?`)).toBe(true)
    expect(new URL(url).searchParams.get('client_id')).toBe(config.clientId)
  })

  it('requests the exact registered redirect URI', async () => {
    const { url } = await buildAuthorizeUrl(config)
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(
      'http://localhost:5175',
    )
  })

  it('omits prompt for an interactive sign-in', async () => {
    const { url } = await buildAuthorizeUrl(config)
    expect(new URL(url).searchParams.get('prompt')).toBeNull()
  })

  it('adds prompt=none for silent re-authentication', async () => {
    const { url } = await buildAuthorizeUrl(config, { silent: true })
    expect(new URL(url).searchParams.get('prompt')).toBe('none')
  })

  it('generates a fresh verifier and state per request', async () => {
    const a = await buildAuthorizeUrl(config)
    const b = await buildAuthorizeUrl(config)
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.state).not.toBe(b.state)
  })

  it('produces a challenge that matches its verifier', async () => {
    const verifier = createCodeVerifier()
    const first = await createCodeChallenge(verifier)
    const second = await createCodeChallenge(verifier)
    expect(first).toBe(second)
    expect(first).not.toBe(verifier)
    // base64url: no +, / or = padding
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('logout URL', () => {
  it('includes the client and registered logout target', () => {
    const url = new URL(buildLogoutUrl(config))
    expect(url.pathname).toBe('/logout')
    expect(url.searchParams.get('client_id')).toBe(config.clientId)
    expect(url.searchParams.get('logout_uri')).toBe('http://localhost:5175')
  })
})

describe('code exchange', () => {
  function stubToken(payload: unknown, ok = true, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => payload,
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('posts the verifier and no client secret', async () => {
    const fetchMock = stubToken({
      access_token: 'at',
      token_type: 'Bearer',
      expires_in: 3600,
    })
    await exchangeCodeForTokens(config, 'the-code', 'the-verifier')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${config.domain}/oauth2/token`)
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('code_verifier')).toBe('the-verifier')
    expect(body.get('client_secret')).toBeNull()
  })

  it('returns the access token with an absolute expiry', async () => {
    stubToken({ access_token: 'at', expires_in: 3600 })
    const before = Date.now()
    const tokens = await exchangeCodeForTokens(config, 'c', 'v')
    expect(tokens.accessToken).toBe('at')
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000 - 50)
  })

  it('DISCARDS the refresh token entirely', async () => {
    stubToken({
      access_token: 'at',
      id_token: 'it',
      refresh_token: 'SUPER-SECRET-REFRESH',
      expires_in: 3600,
    })
    const tokens = await exchangeCodeForTokens(config, 'c', 'v')

    // It must not appear anywhere on the returned object...
    expect(JSON.stringify(tokens)).not.toContain('SUPER-SECRET-REFRESH')
    expect('refreshToken' in tokens).toBe(false)
    // ...nor in any web storage.
    expect(JSON.stringify(localStorage)).not.toContain('SUPER-SECRET-REFRESH')
    expect(JSON.stringify(sessionStorage)).not.toContain('SUPER-SECRET-REFRESH')
  })

  it('rejects a response with no access token', async () => {
    stubToken({ id_token: 'only-id' })
    await expect(exchangeCodeForTokens(config, 'c', 'v')).rejects.toBeInstanceOf(
      AuthFlowError,
    )
  })

  it('rejects a non-bearer token type', async () => {
    stubToken({ access_token: 'at', token_type: 'mac', expires_in: 60 })
    await expect(exchangeCodeForTokens(config, 'c', 'v')).rejects.toThrow(
      /Unsupported token type/,
    )
  })

  it('does not leak the provider response body on failure', async () => {
    stubToken({ error: 'invalid_grant', code_verifier: 'leaky' }, false, 400)
    await expect(exchangeCodeForTokens(config, 'c', 'v')).rejects.toThrow(
      /could not be completed/i,
    )
    await expect(
      exchangeCodeForTokens(config, 'c', 'v'),
    ).rejects.not.toThrow(/leaky/)
  })

  it('reports a network failure clearly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await expect(exchangeCodeForTokens(config, 'c', 'v')).rejects.toThrow(
      /Could not reach the identity provider/,
    )
  })

  it('falls back to a one-hour lifetime when expires_in is absent', async () => {
    stubToken({ access_token: 'at' })
    const tokens = await exchangeCodeForTokens(config, 'c', 'v')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 3500_000)
  })
})

describe('state comparison', () => {
  it('matches identical states', () => {
    expect(statesMatch('abc', 'abc')).toBe(true)
  })

  it.each([
    ['different values', 'abc', 'abd'],
    ['different lengths', 'abc', 'abcd'],
    ['missing expected', null, 'abc'],
    ['missing returned', 'abc', null],
    ['both missing', null, null],
  ])('rejects %s', (_label, a, b) => {
    expect(statesMatch(a, b)).toBe(false)
  })
})

describe('readClaimsUnsafe', () => {
  it('decodes a payload for display', () => {
    const payload = btoa(JSON.stringify({ sub: 'user-1', email: 'a@b.c' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const claims = readClaimsUnsafe(`header.${payload}.sig`)
    expect(claims?.sub).toBe('user-1')
  })

  it.each(['not-a-jwt', 'a.b', 'a.!!!.c', ''])(
    'returns null for malformed input (%s)',
    (token) => {
      expect(readClaimsUnsafe(token)).toBeNull()
    },
  )
})

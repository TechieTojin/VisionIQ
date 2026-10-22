/**
 * Cross-component contract tests.
 *
 * These encode the agreements between the SPA, the FastAPI backend and the
 * Terraform Cognito module. They are cheap, but they fail loudly if one side
 * drifts — which is exactly the class of bug that only shows up against a
 * live deployment otherwise.
 *
 * Backend reference: backend/app/auth/jwt_verifier.py
 * Terraform reference: infrastructure/terraform/modules/auth/main.tf
 */

import { describe, expect, it, vi } from 'vitest'
import { buildAuthorizeUrl, buildLogoutUrl, exchangeCodeForTokens } from './cognito'
import type { CognitoConfig } from './config'
import { resolveAuthConfig } from './config'

const config: CognitoConfig = {
  mode: 'cognito',
  domain: 'https://visioniq-dev.auth.us-east-1.amazoncognito.com',
  clientId: 'abc123clientid',
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST',
  scopes: 'openid email profile',
  redirectUri: 'http://localhost:5175',
  logoutUri: 'http://localhost:5175',
}

describe('token type contract with the backend', () => {
  it('sends the ACCESS token, which is what the backend validates', async () => {
    // backend/app/config.py: VISIONIQ_JWT_TOKEN_USE defaults to "access",
    // and the verifier rejects a token whose token_use does not match.
    // Sending the id token here would fail with "Expected an 'access' token".
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'the-access-token',
          id_token: 'the-id-token',
          expires_in: 3600,
        }),
      }),
    )

    const tokens = await exchangeCodeForTokens(config, 'c', 'v')
    expect(tokens.accessToken).toBe('the-access-token')
    // The id token is kept only for displaying the user's email.
    expect(tokens.idToken).toBe('the-id-token')

    vi.unstubAllGlobals()
  })

  it('requests openid scope, without which Cognito issues no id token', async () => {
    const { url } = await buildAuthorizeUrl(config)
    expect(new URL(url).searchParams.get('scope')).toContain('openid')
  })

  it('uses the client id the backend checks as the audience', async () => {
    // A Cognito ACCESS token carries `client_id`, not `aud`. The backend
    // compares that claim against VISIONIQ_JWT_AUDIENCE, which must be the
    // same app client id the SPA authorises with.
    const { url } = await buildAuthorizeUrl(config)
    expect(new URL(url).searchParams.get('client_id')).toBe(config.clientId)
  })
})

describe('redirect URI contract with Terraform', () => {
  // Terraform registers BARE ORIGINS:
  //   cognito_callback_urls = ["http://localhost:5175", "http://127.0.0.1:5175"]
  // Cognito requires an exact match, so appending any path breaks sign-in.
  it('uses the bare origin with no path appended', () => {
    const cfg = resolveAuthConfig(
      {
        VITE_AUTH_MODE: 'cognito',
        VITE_COGNITO_DOMAIN: 'd.auth.us-east-1.amazoncognito.com',
        VITE_COGNITO_CLIENT_ID: 'cid',
      } as ImportMetaEnv,
      false,
      'http://localhost:5175',
    )
    expect(cfg.mode === 'cognito' && cfg.redirectUri).toBe(
      'http://localhost:5175',
    )
    expect(cfg.mode === 'cognito' && cfg.redirectUri.endsWith('/')).toBe(false)
  })

  it('sends a redirect_uri identical to the registered callback URL', async () => {
    const { url } = await buildAuthorizeUrl(config)
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(
      'http://localhost:5175',
    )
  })

  it('sends a logout_uri identical to the registered logout URL', () => {
    expect(new URL(buildLogoutUrl(config)).searchParams.get('logout_uri')).toBe(
      'http://localhost:5175',
    )
  })

  it('matches the 127.0.0.1 origin Terraform also registers', () => {
    const cfg = resolveAuthConfig(
      {
        VITE_AUTH_MODE: 'cognito',
        VITE_COGNITO_DOMAIN: 'd.auth.us-east-1.amazoncognito.com',
        VITE_COGNITO_CLIENT_ID: 'cid',
      } as ImportMetaEnv,
      false,
      'http://127.0.0.1:5175',
    )
    expect(cfg.mode === 'cognito' && cfg.redirectUri).toBe(
      'http://127.0.0.1:5175',
    )
  })
})

describe('OAuth flow contract with Terraform', () => {
  // Terraform sets allowed_oauth_flows = ["code"] and generate_secret = false.
  it('uses the code flow Terraform permits', async () => {
    const { url } = await buildAuthorizeUrl(config)
    expect(new URL(url).searchParams.get('response_type')).toBe('code')
  })

  it('never attempts the implicit flow, which Terraform does not allow', async () => {
    const { url } = await buildAuthorizeUrl(config)
    const responseType = new URL(url).searchParams.get('response_type')
    expect(responseType).not.toContain('token')
  })

  it('requests only scopes Terraform allows', async () => {
    // allowed_oauth_scopes = ["openid", "email", "profile"]
    const allowed = new Set(['openid', 'email', 'profile'])
    const { url } = await buildAuthorizeUrl(config)
    const requested = (new URL(url).searchParams.get('scope') ?? '').split(' ')
    for (const scope of requested) {
      expect(allowed.has(scope), `scope "${scope}" is not allowed`).toBe(true)
    }
  })

  it('sends no client secret, because the client is public', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at', expires_in: 3600 }),
      }),
    )
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    await exchangeCodeForTokens(config, 'c', 'v')

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string)
    expect(body.get('client_secret')).toBeNull()
    // PKCE is what replaces the secret.
    expect(body.get('code_verifier')).toBe('v')

    vi.unstubAllGlobals()
  })
})

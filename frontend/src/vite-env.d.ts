/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "local" (synchronous FastAPI) or "cloud" (API Gateway + async jobs). */
  readonly VITE_API_MODE?: string
  /**
   * API origin. Empty (the default) means same-origin relative `/api`
   * paths, which the Vite dev proxy forwards to the local backend.
   */
  readonly VITE_API_BASE_URL?: string
  /** Milliseconds between cloud job status polls. */
  readonly VITE_JOB_POLL_INTERVAL_MS?: string
  /** Give up polling a cloud job after this many milliseconds. */
  readonly VITE_JOB_POLL_TIMEOUT_MS?: string
  /** "local" (dev bypass) or "cognito". Never "local" in a production build. */
  readonly VITE_AUTH_MODE?: string
  /** Cognito hosted-UI domain, e.g. visioniq-dev-ab12cd34.auth.us-east-1.amazoncognito.com */
  readonly VITE_COGNITO_DOMAIN?: string
  /** App client id. Public by design — this is NOT a secret. */
  readonly VITE_COGNITO_CLIENT_ID?: string
  /** Issuer, used only to sanity-check config against the backend. */
  readonly VITE_COGNITO_ISSUER?: string
  /** Space-separated OAuth scopes. Defaults to "openid email profile". */
  readonly VITE_COGNITO_SCOPES?: string
  /** Override the redirect URI. Defaults to window.location.origin. */
  readonly VITE_COGNITO_REDIRECT_URI?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

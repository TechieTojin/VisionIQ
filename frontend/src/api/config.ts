/**
 * API transport configuration.
 *
 * Two modes, selected by `VITE_API_MODE`:
 *
 *   local  FastAPI. One synchronous request does everything:
 *          POST /api/images/detect returns the finished AnalysisRecord.
 *
 *   cloud  API Gateway + Lambda. Analysis is asynchronous:
 *          presign -> PUT to S3 -> create job -> poll until terminal.
 *
 * Both return the SAME response shapes for equivalent resources (Phase 3.8),
 * so only the *choreography* differs, never the parsing.
 */

/**
 * `demo` is a third transport: there is no backend at all. It replays
 * pre-recorded results captured from a real local YOLO run, and the UI
 * labels them as such. It exists so the project can be shown publicly at
 * zero hosting cost — no free host can run CPU YOLO inference reliably.
 */
export type ApiMode = 'local' | 'cloud' | 'demo'

export interface ApiConfig {
  mode: ApiMode
  /** Origin to prefix paths with. Empty means same-origin. */
  baseUrl: string
  pollIntervalMs: number
  pollTimeoutMs: number
}

const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function resolveApiConfig(
  env: ImportMetaEnv = import.meta.env,
): ApiConfig {
  const rawMode = (env.VITE_API_MODE ?? 'local').trim().toLowerCase()
  const mode: ApiMode =
    rawMode === 'cloud' ? 'cloud' : rawMode === 'demo' ? 'demo' : 'local'

  return {
    mode,
    // Trailing slashes would produce `//api/...`, which some gateways 404.
    baseUrl: (env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    pollIntervalMs: positiveInt(
      env.VITE_JOB_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
    ),
    pollTimeoutMs: positiveInt(
      env.VITE_JOB_POLL_TIMEOUT_MS,
      DEFAULT_POLL_TIMEOUT_MS,
    ),
  }
}

/** Join the configured origin with an absolute API path. */
export function apiUrl(path: string, config?: ApiConfig): string {
  const base = (config ?? resolveApiConfig()).baseUrl
  return base ? `${base}${path}` : path
}

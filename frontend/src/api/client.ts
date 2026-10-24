import type {
  AnalysisPage,
  AnalysisRecord,
  ComparisonResult,
  ErrorResponse,
  JobStatus,
  SystemStatus,
} from '../types'
import { authHeaders, getAccessToken } from './auth'
import { apiUrl, type ApiConfig } from './config'

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_BYTES = 10 * 1024 * 1024

export class ApiError extends Error {
  readonly code: string
  /** The server's machine-readable `error` field, when it sent one. */
  readonly reason: string | null
  constructor(message: string, code = 'error', reason: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.reason = reason
  }
}

/**
 * Listeners notified when the API rejects us as unauthenticated.
 *
 * The auth layer subscribes so a 401 anywhere — including a token that
 * expired between the scheduled refresh and the request — moves the UI to the
 * session-expired state instead of silently failing.
 */
type UnauthorizedListener = () => void
const unauthorizedListeners = new Set<UnauthorizedListener>()

export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

function notifyUnauthorized(status: number): void {
  if (status !== 401) return
  for (const listener of unauthorizedListeners) {
    try {
      listener()
    } catch {
      // A failing listener must not break error handling.
    }
  }
}

/** Client-side guard so obvious problems fail fast without a round-trip. */
export function validateFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return 'Unsupported file type. Please upload a JPEG, PNG, or WebP image.'
  }
  if (file.size > MAX_BYTES) {
    return 'File exceeds the 10 MB limit.'
  }
  return null
}

/** Pull a readable message out of whatever shape the backend returned. */
function extractError(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Partial<ErrorResponse> & { detail?: unknown }
    if (typeof b.detail === 'string') return b.detail
    // FastAPI request validation: [{loc, msg, ...}, ...]
    const detail: unknown = b.detail
    if (Array.isArray(detail) && detail.length) {
      const first = detail[0] as { msg?: unknown; loc?: unknown }
      if (typeof first?.msg === 'string') {
        const field = Array.isArray(first.loc) ? first.loc.filter((p) => p !== 'body').join('.') : ''
        return field ? `${field}: ${first.msg}` : first.msg
      }
    }
    if (b.detail && typeof b.detail === 'object') {
      const nested = b.detail as Partial<ErrorResponse>
      if (typeof nested.detail === 'string') return nested.detail
    }
  }
  return fallback
}

/**
 * Issue an authenticated API request.
 *
 * `config` overrides the environment-derived base URL. Callers that hold a
 * resolved config (the cloud analysis client) must pass it, or the request
 * would silently go same-origin instead of to the configured gateway.
 */
export async function request<T>(
  path: string,
  init?: RequestInit,
  config?: ApiConfig,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(apiUrl(path, config), {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(await authHeaders()) },
    })
  } catch {
    throw new ApiError(
      'Network error. Is the backend running on port 8080?',
      'network',
    )
  }

  if (response.status === 204) return undefined as T

  let body: unknown = null
  const text = await response.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }

  if (!response.ok) {
    notifyUnauthorized(response.status)
    const reason =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : null
    throw new ApiError(
      extractError(body, `Request failed (${response.status}).`),
      String(response.status),
      reason,
    )
  }
  return body as T
}

/**
 * Upload an image for detection.
 * Uses XMLHttpRequest so we can report real upload progress.
 */
export async function detectImage(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<AnalysisRecord> {
  // Resolve the token before opening the request so the header can be set.
  const token = await getAccessToken()

  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl('/api/images/detect'))
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    }

    xhr.onload = () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(xhr.responseText)
      } catch {
        reject(new ApiError('The server returned an unreadable response.'))
        return
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed as AnalysisRecord)
      } else {
        notifyUnauthorized(xhr.status)
        reject(
          new ApiError(
            extractError(parsed, 'Analysis failed.'),
            String(xhr.status),
          ),
        )
      }
    }

    xhr.onerror = () =>
      reject(
        new ApiError(
          'Network error. Is the backend running on port 8080?',
          'network',
        ),
      )

    xhr.send(form)
  })
}

export function listAnalyses(params: {
  limit?: number
  cursor?: string
  search?: string
  status?: JobStatus
}): Promise<AnalysisPage> {
  const q = new URLSearchParams()
  if (params.limit) q.set('limit', String(params.limit))
  if (params.cursor) q.set('cursor', params.cursor)
  if (params.search) q.set('search', params.search)
  if (params.status) q.set('status', params.status)
  return request<AnalysisPage>(`/api/analyses?${q.toString()}`)
}

export function getAnalysis(id: string): Promise<AnalysisRecord> {
  return request<AnalysisRecord>(`/api/analyses/${encodeURIComponent(id)}`)
}

export function deleteAnalysis(id: string): Promise<void> {
  return request<void>(`/api/analyses/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function compareAnalyses(
  baseId: string,
  targetId: string,
): Promise<ComparisonResult> {
  return request<ComparisonResult>(
    `/api/analyses/${encodeURIComponent(baseId)}/compare/${encodeURIComponent(targetId)}`,
  )
}

export function getSystemStatus(): Promise<SystemStatus> {
  return request<SystemStatus>('/api/system/status')
}

/**
 * Fetch a binary resource (a stored scan image) as a Blob.
 *
 * An `<img src>` cannot carry an Authorization header, so images are fetched
 * here with the same bearer token as every other request and handed to the
 * page as an object URL. Returns null for a 404 — a missing image is an
 * expected state (deleted file, cloud mode), not an error.
 */
export async function requestBlob(
  path: string,
  config?: ApiConfig,
): Promise<Blob | null> {
  let response: Response
  try {
    response = await fetch(apiUrl(path, config), { headers: await authHeaders() })
  } catch {
    throw new ApiError('Network error while loading the image.', 'network')
  }
  if (response.status === 404) return null
  if (!response.ok) {
    notifyUnauthorized(response.status)
    throw new ApiError(`Could not load the image (${response.status}).`, String(response.status))
  }
  return response.blob()
}

/**
 * Analysis transport: one interface, two choreographies.
 *
 * Because FastAPI and the Lambda return identical shapes for equivalent
 * resources (Phase 3.8), the differences here are purely about *how many
 * steps* an analysis takes — never about parsing.
 *
 *   local  POST /api/images/detect            -> AnalysisRecord (done)
 *   cloud  POST /api/uploads/presign          -> PresignResponse
 *          PUT  <presigned url>               -> S3 (direct, no API involved)
 *          POST /api/jobs                     -> AnalysisRecord (queued, 202)
 *          GET  /api/jobs/{id}  (polled)      -> AnalysisRecord (terminal)
 *
 * Reading history is identical in both modes, so it is not duplicated here —
 * `client.ts` handles it and the base URL makes it work against either.
 */

import { ApiError, detectImage, request } from './client'
import { getAccessToken } from './auth'
import { apiUrl, resolveApiConfig, type ApiConfig, type ApiMode } from './config'
import type { AnalysisRecord, JobStatus } from '../types'

/** Terminal states: polling stops here. */
const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'completed',
  'failed',
  'cancelled',
])

export interface PresignResponse {
  analysis_id: string
  upload: {
    url: string
    key: string
    expires_in: number
    required_headers: Record<string, string>
    max_bytes: number
  }
}

export interface AnalysisProgress {
  /** 0-100 for the upload leg. */
  percent?: number
  /** Latest known job state, once there is one. */
  status?: JobStatus
  stage: 'uploading' | 'queued' | 'processing' | 'done'
}

export interface AnalysisClient {
  readonly mode: ApiMode
  analyze(
    file: File,
    onProgress?: (progress: AnalysisProgress) => void,
    signal?: AbortSignal,
  ): Promise<AnalysisRecord>
}

// --------------------------------------------------------------------------
// local
// --------------------------------------------------------------------------

class LocalAnalysisClient implements AnalysisClient {
  readonly mode = 'local' as const

  async analyze(
    file: File,
    onProgress?: (progress: AnalysisProgress) => void,
  ): Promise<AnalysisRecord> {
    const record = await detectImage(file, (percent) =>
      onProgress?.({
        percent,
        stage: percent < 100 ? 'uploading' : 'processing',
      }),
    )
    onProgress?.({ percent: 100, stage: 'done', status: record.status })
    return record
  }
}

// --------------------------------------------------------------------------
// cloud
// --------------------------------------------------------------------------

/** Upload bytes straight to S3 with the presigned URL. */
function putToS3(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)

    // Exactly the headers that were signed; anything else breaks the
    // signature. Notably NO Authorization header — the signature in the URL
    // is the credential, and sending a bearer token to S3 would leak it.
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value)
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.round((event.loaded / event.total) * 100))
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        reject(
          new ApiError(
            `Upload failed (${xhr.status}). The upload link may have expired.`,
            String(xhr.status),
          ),
        )
      }
    }
    xhr.onerror = () =>
      reject(new ApiError('Network error while uploading the image.', 'network'))
    xhr.onabort = () => reject(new ApiError('Upload cancelled.', 'aborted'))

    if (signal) {
      if (signal.aborted) {
        xhr.abort()
        return
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    xhr.send(file)
  })
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new ApiError('Cancelled.', 'aborted'))
      },
      { once: true },
    )
  })

class CloudAnalysisClient implements AnalysisClient {
  readonly mode = 'cloud' as const

  // Declared explicitly rather than as a constructor parameter property:
  // tsconfig sets `erasableSyntaxOnly`, which forbids that TS-only syntax.
  private readonly config: ApiConfig

  constructor(config: ApiConfig) {
    this.config = config
  }

  async analyze(
    file: File,
    onProgress?: (progress: AnalysisProgress) => void,
    signal?: AbortSignal,
  ): Promise<AnalysisRecord> {
    // A missing token here would produce a confusing 401 from the gateway
    // three steps later; fail early and plainly instead.
    if (!(await getAccessToken())) {
      throw new ApiError(
        'You are not signed in. Please sign in and try again.',
        'unauthenticated',
      )
    }

    onProgress?.({ percent: 0, stage: 'uploading' })

    const presigned = await request<PresignResponse>('/api/uploads/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        content_type: file.type,
        size_bytes: file.size,
      }),
      signal,
    }, this.config)

    await putToS3(
      presigned.upload.url,
      file,
      presigned.upload.required_headers,
      (percent) => onProgress?.({ percent, stage: 'uploading' }),
      signal,
    )

    const queued = await request<AnalysisRecord>('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analysis_id: presigned.analysis_id,
        // The backend accepts either name; `image_key` is canonical.
        image_key: presigned.upload.key,
        object_key: presigned.upload.key,
      }),
      signal,
    }, this.config)

    onProgress?.({ percent: 100, stage: 'queued', status: queued.status })

    if (TERMINAL_STATUSES.has(queued.status)) return queued

    return this.pollUntilTerminal(queued.analysis_id, onProgress, signal)
  }

  /**
   * Poll a job to a terminal state.
   *
   * A transient 5xx or network blip must not abandon a job that is still
   * running, so those are retried a bounded number of times. A 404 is
   * terminal: the record is gone, and polling forever would be a lie.
   */
  private async pollUntilTerminal(
    analysisId: string,
    onProgress?: (progress: AnalysisProgress) => void,
    signal?: AbortSignal,
  ): Promise<AnalysisRecord> {
    const deadline = Date.now() + this.config.pollTimeoutMs
    const maxTransientFailures = 5
    let transientFailures = 0

    for (;;) {
      if (signal?.aborted) throw new ApiError('Cancelled.', 'aborted')
      if (Date.now() > deadline) {
        throw new ApiError(
          'The analysis is taking longer than expected. It may still ' +
            'finish — check the scan history shortly.',
          'poll_timeout',
        )
      }

      await sleep(this.config.pollIntervalMs, signal)

      let record: AnalysisRecord
      try {
        record = await request<AnalysisRecord>(
          `/api/jobs/${encodeURIComponent(analysisId)}`,
          { signal },
          this.config,
        )
      } catch (err) {
        const code = err instanceof ApiError ? err.code : ''
        // Do not retry a definitive answer.
        if (code === '404' || code === '401' || code === '403') throw err
        if (++transientFailures > maxTransientFailures) throw err
        continue
      }

      transientFailures = 0
      onProgress?.({
        percent: 100,
        stage: record.status === 'queued' ? 'queued' : 'processing',
        status: record.status,
      })

      if (TERMINAL_STATUSES.has(record.status)) {
        onProgress?.({ percent: 100, stage: 'done', status: record.status })
        return record
      }
    }
  }
}

// --------------------------------------------------------------------------

let cached: AnalysisClient | null = null
let cachedMode: string | null = null

/** Registered by the demo module so this factory need not import it. */
let demoClientFactory: (() => AnalysisClient) | null = null

export function registerDemoClientFactory(factory: () => AnalysisClient): void {
  demoClientFactory = factory
}

export function getAnalysisClient(config?: ApiConfig): AnalysisClient {
  const resolved = config ?? resolveApiConfig()
  if (cached && cachedMode === resolved.mode) return cached

  if (resolved.mode === 'demo') {
    // Defence in depth. The UI already removes the file input in demo mode,
    // so this path should be unreachable — but if it ever is reached, it
    // must NOT fall through to the local client, which would POST a user's
    // image to an endpoint that does not exist on a static deployment.
    cached = demoClientFactory
      ? demoClientFactory()
      : {
          mode: 'demo' as const,
          analyze: () => {
            throw new ApiError(
              'This is a demo deployment with no inference backend.',
              'demo_mode',
            )
          },
        }
  } else if (resolved.mode === 'cloud') {
    cached = new CloudAnalysisClient(resolved)
  } else {
    cached = new LocalAnalysisClient()
  }

  cachedMode = resolved.mode
  return cached
}

export function resetAnalysisClient(): void {
  cached = null
  cachedMode = null
}

/**
 * Cancel a queued cloud job.
 *
 * Takes the config for the same reason every other cloud call does: without
 * it the request resolves same-origin and would miss a configured gateway.
 */
export function cancelJob(
  analysisId: string,
  config?: ApiConfig,
): Promise<AnalysisRecord> {
  return request<AnalysisRecord>(
    `/api/jobs/${encodeURIComponent(analysisId)}/cancel`,
    { method: 'POST' },
    config ?? resolveApiConfig(),
  )
}

export { apiUrl }

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelJob, getAnalysisClient, resetAnalysisClient } from './analysisClient'
import { setTokenProvider } from './auth'
import { resolveApiConfig } from './config'
import type { AnalysisRecord, JobStatus } from '../types'
import { makeRecord } from '../test/fixtures'

const LOCAL = { mode: 'local' as const, baseUrl: '', pollIntervalMs: 1, pollTimeoutMs: 1000 }
const CLOUD = { mode: 'cloud' as const, baseUrl: '', pollIntervalMs: 1, pollTimeoutMs: 2000 }

function makeFile(): File {
  const file = new File(['bytes'], 'shelf.png', { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: 1234 })
  return file
}

/** Minimal XMLHttpRequest stand-in covering upload + response. */
class FakeXhr {
  static instances: FakeXhr[] = []
  static nextStatus = 200
  static nextResponse = '{}'

  status = 0
  responseText = ''
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = null

  constructor() {
    FakeXhr.instances.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  abort() {
    this.onabort?.()
  }
  send(body: unknown) {
    this.body = body
    queueMicrotask(() => {
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: 50,
        total: 100,
      } as ProgressEvent)
      this.status = FakeXhr.nextStatus
      this.responseText = FakeXhr.nextResponse
      this.onload?.()
    })
  }
}

let fetchMock: ReturnType<typeof vi.fn>

function jsonOk(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }
}

beforeEach(() => {
  resetAnalysisClient()
  FakeXhr.instances = []
  FakeXhr.nextStatus = 200
  FakeXhr.nextResponse = '{}'
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setTokenProvider(null)
  resetAnalysisClient()
})

// ---------------------------------------------------------------- config

describe('API configuration', () => {
  it('defaults to local mode with same-origin paths', () => {
    const config = resolveApiConfig({} as ImportMetaEnv)
    expect(config.mode).toBe('local')
    expect(config.baseUrl).toBe('')
  })

  it('selects cloud mode from the environment', () => {
    expect(
      resolveApiConfig({ VITE_API_MODE: 'cloud' } as ImportMetaEnv).mode,
    ).toBe('cloud')
  })

  it('treats an unknown mode as local rather than guessing', () => {
    expect(
      resolveApiConfig({ VITE_API_MODE: 'banana' } as ImportMetaEnv).mode,
    ).toBe('local')
  })

  it('strips a trailing slash so paths do not double up', () => {
    const config = resolveApiConfig({
      VITE_API_BASE_URL: 'https://api.example.com/',
    } as ImportMetaEnv)
    expect(config.baseUrl).toBe('https://api.example.com')
  })

  it('falls back to sane polling defaults on junk input', () => {
    const config = resolveApiConfig({
      VITE_JOB_POLL_INTERVAL_MS: 'soon',
      VITE_JOB_POLL_TIMEOUT_MS: '-5',
    } as ImportMetaEnv)
    expect(config.pollIntervalMs).toBeGreaterThan(0)
    expect(config.pollTimeoutMs).toBeGreaterThan(0)
  })
})

// ----------------------------------------------------------------- local

describe('local mode', () => {
  it('completes in a single request', async () => {
    const record = makeRecord()
    FakeXhr.nextResponse = JSON.stringify(record)

    const result = await getAnalysisClient(LOCAL).analyze(makeFile())

    expect(result.analysis_id).toBe(record.analysis_id)
    // One XHR, no presign/job/poll round trips.
    expect(FakeXhr.instances).toHaveLength(1)
    expect(FakeXhr.instances[0].url).toBe('/api/images/detect')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports upload progress', async () => {
    FakeXhr.nextResponse = JSON.stringify(makeRecord())
    const seen: number[] = []

    await getAnalysisClient(LOCAL).analyze(makeFile(), (p) => {
      if (p.percent !== undefined) seen.push(p.percent)
    })

    expect(seen).toContain(50)
    expect(seen.at(-1)).toBe(100)
  })

  it('surfaces a backend error', async () => {
    FakeXhr.nextStatus = 400
    FakeXhr.nextResponse = JSON.stringify({
      success: false,
      error: 'invalid_image',
      detail: 'not an image',
    })

    await expect(
      getAnalysisClient(LOCAL).analyze(makeFile()),
    ).rejects.toThrow('not an image')
  })
})

// ----------------------------------------------------------------- cloud

describe('cloud mode', () => {
  const presign = {
    analysis_id: 'abc12345',
    upload: {
      url: 'https://bucket.s3.amazonaws.com/signed?sig=x',
      key: 'uploads/alice/abc12345.png',
      expires_in: 900,
      required_headers: {
        'Content-Type': 'image/png',
        'x-amz-server-side-encryption': 'AES256',
      },
      max_bytes: 10485760,
    },
  }

  function queued(status: JobStatus = 'queued'): AnalysisRecord {
    return { ...makeRecord(), analysis_id: 'abc12345', status }
  }

  beforeEach(() => {
    setTokenProvider(() => 'access-token')
  })

  it('refuses to start when not signed in', async () => {
    setTokenProvider(null)
    await expect(
      getAnalysisClient(CLOUD).analyze(makeFile()),
    ).rejects.toThrow(/not signed in/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('runs presign -> S3 PUT -> create job -> poll', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign)) // presign
      .mockResolvedValueOnce(jsonOk(queued('queued'), 202)) // create job
      .mockResolvedValueOnce(jsonOk(queued('processing'))) // poll 1
      .mockResolvedValueOnce(jsonOk(queued('completed'))) // poll 2

    const result = await getAnalysisClient(CLOUD).analyze(makeFile())

    expect(result.status).toBe('completed')
    const paths = fetchMock.mock.calls.map((c) => c[0] as string)
    expect(paths[0]).toBe('/api/uploads/presign')
    expect(paths[1]).toBe('/api/jobs')
    expect(paths[2]).toBe('/api/jobs/abc12345')
  })

  it('uploads directly to S3 with exactly the signed headers', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign))
      .mockResolvedValueOnce(jsonOk(queued('completed'), 202))

    await getAnalysisClient(CLOUD).analyze(makeFile())

    const put = FakeXhr.instances[0]
    expect(put.method).toBe('PUT')
    expect(put.url).toBe(presign.upload.url)
    expect(put.headers['Content-Type']).toBe('image/png')
    expect(put.headers['x-amz-server-side-encryption']).toBe('AES256')
  })

  it('NEVER sends the bearer token to S3', async () => {
    // The presigned signature is the credential; a bearer token in this
    // request would leak it to the storage endpoint.
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign))
      .mockResolvedValueOnce(jsonOk(queued('completed'), 202))

    await getAnalysisClient(CLOUD).analyze(makeFile())

    const headerNames = Object.keys(FakeXhr.instances[0].headers).map((h) =>
      h.toLowerCase(),
    )
    expect(headerNames).not.toContain('authorization')
  })

  it('attaches the bearer token to API requests', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign))
      .mockResolvedValueOnce(jsonOk(queued('completed'), 202))

    await getAnalysisClient(CLOUD).analyze(makeFile())

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers.Authorization).toBe('Bearer access-token')
    }
  })

  it('sends the canonical image_key when creating the job', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign))
      .mockResolvedValueOnce(jsonOk(queued('completed'), 202))

    await getAnalysisClient(CLOUD).analyze(makeFile())

    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body.analysis_id).toBe('abc12345')
    expect(body.image_key).toBe('uploads/alice/abc12345.png')
  })

  it('stops polling as soon as the job completes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign))
      .mockResolvedValueOnce(jsonOk(queued('queued'), 202))
      .mockResolvedValueOnce(jsonOk(queued('completed')))

    await getAnalysisClient(CLOUD).analyze(makeFile())
    // presign + create + exactly one poll.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each<JobStatus>(['completed', 'failed', 'cancelled'])(
    'treats %s as terminal',
    async (status) => {
      fetchMock
        .mockResolvedValueOnce(jsonOk(presign))
        .mockResolvedValueOnce(jsonOk(queued('queued'), 202))
        .mockResolvedValueOnce(jsonOk(queued(status)))

      const result = await getAnalysisClient(CLOUD).analyze(makeFile())
      expect(result.status).toBe(status)
    },
  )

  it('does not poll at all when the job is already terminal', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign))
      .mockResolvedValueOnce(jsonOk(queued('completed'), 202))

    await getAnalysisClient(CLOUD).analyze(makeFile())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports queued and processing stages', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign))
      .mockResolvedValueOnce(jsonOk(queued('queued'), 202))
      .mockResolvedValueOnce(jsonOk(queued('processing')))
      .mockResolvedValueOnce(jsonOk(queued('completed')))

    const stages: string[] = []
    await getAnalysisClient(CLOUD).analyze(makeFile(), (p) =>
      stages.push(p.stage),
    )

    expect(stages).toContain('uploading')
    expect(stages).toContain('queued')
    expect(stages).toContain('processing')
    expect(stages.at(-1)).toBe('done')
  })

  it('retries a transient 503 while polling', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign))
      .mockResolvedValueOnce(jsonOk(queued('queued'), 202))
      .mockResolvedValueOnce(jsonOk({ detail: 'boom' }, 503))
      .mockResolvedValueOnce(jsonOk(queued('completed')))

    const result = await getAnalysisClient(CLOUD).analyze(makeFile())
    expect(result.status).toBe('completed')
  })

  it('gives up immediately on a 404 rather than polling a dead job', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign))
      .mockResolvedValueOnce(jsonOk(queued('queued'), 202))
      .mockResolvedValue(
        jsonOk({ success: false, error: 'not_found', detail: 'gone' }, 404),
      )

    await expect(
      getAnalysisClient(CLOUD).analyze(makeFile()),
    ).rejects.toThrow('gone')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry a 401 while polling', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign))
      .mockResolvedValueOnce(jsonOk(queued('queued'), 202))
      .mockResolvedValue(
        jsonOk({ success: false, error: 'unauthenticated', detail: 'nope' }, 401),
      )

    await expect(getAnalysisClient(CLOUD).analyze(makeFile())).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('stops with a clear message when polling exceeds the deadline', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign))
      .mockResolvedValueOnce(jsonOk(queued('queued'), 202))
      .mockResolvedValue(jsonOk(queued('processing')))

    const client = getAnalysisClient({ ...CLOUD, pollTimeoutMs: 5 })
    await expect(client.analyze(makeFile())).rejects.toThrow(
      /taking longer than expected/i,
    )
  })

  it('reports an expired upload link clearly', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk(presign))
    FakeXhr.nextStatus = 403

    await expect(
      getAnalysisClient(CLOUD).analyze(makeFile()),
    ).rejects.toThrow(/expired/i)
  })

  it('can be cancelled mid-poll', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(presign))
      .mockResolvedValueOnce(jsonOk(queued('queued'), 202))
      .mockResolvedValue(jsonOk(queued('processing')))

    const controller = new AbortController()
    const promise = getAnalysisClient(CLOUD).analyze(
      makeFile(),
      undefined,
      controller.signal,
    )
    queueMicrotask(() => controller.abort())

    await expect(promise).rejects.toThrow(/cancel/i)
  })
})

// ------------------------------------------------------------- base URL

describe('configurable API base URL', () => {
  it('prefixes API calls in cloud mode', async () => {
    setTokenProvider(() => 'tok')
    fetchMock.mockResolvedValue(
      jsonOk({ ...makeRecord(), status: 'completed' }, 202),
    )

    const client = getAnalysisClient({
      ...CLOUD,
      baseUrl: 'https://api.example.com',
    })
    // Only the presign call matters for the URL assertion.
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        analysis_id: 'abc12345',
        upload: {
          url: 'https://bucket.s3.amazonaws.com/s',
          key: 'uploads/a/abc12345.png',
          expires_in: 900,
          required_headers: {},
          max_bytes: 10485760,
        },
      }),
    )
    await client.analyze(makeFile())

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example.com/api/uploads/presign',
    )
  })
})

describe('cancelJob', () => {
  it('posts to the cancel route and returns the record', async () => {
    const cancelled = { ...makeRecord(), status: 'cancelled' as JobStatus }
    fetchMock.mockResolvedValue(jsonOk(cancelled))

    const result = await cancelJob('abc12345')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/jobs/abc12345/cancel')
    expect(result.status).toBe('cancelled')
  })

  it('honours the configured gateway base URL', async () => {
    // Regression: cancel was the one cloud call that ignored the config and
    // would have gone same-origin against a deployed gateway.
    fetchMock.mockResolvedValue(
      jsonOk({ ...makeRecord(), status: 'cancelled' as JobStatus }),
    )

    await cancelJob('abc12345', { ...CLOUD, baseUrl: 'https://api.example.com' })

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example.com/api/jobs/abc12345/cancel',
    )
  })

  it('url-encodes the id', async () => {
    fetchMock.mockResolvedValue(jsonOk(makeRecord()))
    await cancelJob('../admin')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/jobs/..%2Fadmin/cancel')
  })
})

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnnotatedImage } from './components/AnnotatedImage'
import { DetectionPanel } from './components/DetectionPanel'
import { Dropzone } from './components/Dropzone'
import { HistoryPanel } from './components/HistoryPanel'
import { InsightsPanel } from './components/InsightsPanel'
import { MetadataPanel } from './components/MetadataPanel'
import {
  ApiError,
  compareAnalyses,
  deleteAnalysis,
  getAnalysis,
  getSystemStatus,
  listAnalyses,
  validateFile,
} from './api/client'
import { getAnalysisClient, type AnalysisProgress } from './api/analysisClient'
import { resolveApiConfig } from './api/config'
import { DemoAnalysisClient } from './demo/demoClient'
import {
  DEMO_MODEL,
  DEMO_SAMPLES,
  demoHistory,
  type DemoSample,
} from './demo/demoData'
import { DemoBanner, SamplePicker } from './components/DemoPanel'
import type {
  AnalysisRecord,
  AnalysisSummary,
  ComparisonResult,
  SystemStatus,
} from './types'
import { buildColorMap } from './utils/colors'
import './App.css'

type Status = 'idle' | 'uploading' | 'done' | 'error'

const PAGE_SIZE = 10

interface DashboardProps {
  user?: { subject: string; email: string | null } | null
  mode?: 'local' | 'cognito' | 'misconfigured'
  onLogout?: () => void
}

function App({ user, mode, onLogout }: DashboardProps = {}) {
  // Demo mode replays recorded analyses; there is no backend to call.
  const apiConfig = useMemo(() => resolveApiConfig(), [])
  const isDemo = apiConfig.mode === 'demo'
  const demoClient = useMemo(() => new DemoAnalysisClient(), [])
  const [status, setStatus] = useState<Status>('idle')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState<AnalysisProgress['stage']>('uploading')
  const [record, setRecord] = useState<AnalysisRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [system, setSystem] = useState<SystemStatus | null>(null)

  // Detection view controls
  const [showBoxes, setShowBoxes] = useState(true)
  const [minConfidence, setMinConfidence] = useState(0)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  // History
  const [history, setHistory] = useState<AnalysisSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [search, setSearch] = useState('')
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [comparison, setComparison] = useState<ComparisonResult | null>(null)

  const previewRef = useRef<string | null>(null)

  // Revoke the previous object URL whenever it is replaced or unmounted.
  const setPreview = useCallback((url: string | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = url
    setPreviewUrl(url)
  }, [])

  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    }
  }, [])

  useEffect(() => {
    // Demo mode has no backend to ask; the banner states the model instead.
    if (isDemo) return
    getSystemStatus()
      .then(setSystem)
      .catch(() => setSystem(null))
  }, [isDemo])

  // -- history -----------------------------------------------------------

  const loadHistory = useCallback(
    async (opts: { reset?: boolean; term?: string } = {}) => {
      const term = opts.term ?? search

      if (isDemo) {
        // No backend to query: the "history" is the bundled samples.
        const rows = demoHistory().filter((row) =>
          term ? row.filename.toLowerCase().includes(term.toLowerCase()) : true,
        )
        setHistory(rows)
        setCursor(null)
        setHasMore(false)
        return
      }

      setHistoryLoading(true)
      try {
        const page = await listAnalyses({
          limit: PAGE_SIZE,
          cursor: opts.reset ? undefined : (cursor ?? undefined),
          search: term || undefined,
        })
        setHistory((prev) => (opts.reset ? page.items : [...prev, ...page.items]))
        setCursor(page.next_cursor)
        setHasMore(page.has_more)
      } catch {
        // History is secondary; a failure here must not break the workspace.
      } finally {
        setHistoryLoading(false)
      }
    },
    [cursor, search, isDemo],
  )

  // Loads the first page on mount and re-queries as the search term changes.
  // The debounce timer also keeps state updates out of the effect body.
  useEffect(() => {
    const id = setTimeout(
      () => {
        setCursor(null)
        void loadHistory({ reset: true, term: search })
      },
      search ? 300 : 0,
    )
    return () => clearTimeout(id)
    // loadHistory changes identity with the cursor; re-running on that would
    // re-query on every page load, so the search term is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // -- analysis ----------------------------------------------------------

  const reset = useCallback(() => {
    setStatus('idle')
    setProgress(0)
    setRecord(null)
    setError(null)
    setSelectedId(null)
    setPreview(null)
  }, [setPreview])

  const handleFile = useCallback(
    async (file: File) => {
      const clientError = validateFile(file)
      setPreview(URL.createObjectURL(file))
      setRecord(null)
      setSelectedId(null)

      if (clientError) {
        setError(clientError)
        setStatus('error')
        return
      }

      setError(null)
      setProgress(0)
      setStage('uploading')
      setStatus('uploading')

      try {
        // One call in local mode; presign -> S3 -> job -> poll in cloud mode.
        const result = await getAnalysisClient().analyze(file, (p) => {
          if (p.percent !== undefined) setProgress(p.percent)
          setStage(p.stage)
        })
        setRecord(result)
        setStatus('done')
        setCursor(null)
        void loadHistory({ reset: true })
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Unexpected error.')
        setStatus('error')
      }
    },
    [loadHistory, setPreview],
  )

  const handleDemoPick = useCallback(
    async (sample: DemoSample) => {
      setError(null)
      setProgress(100)
      setStage('processing')
      setStatus('uploading')
      setSelectedId(null)
      // The sample's own image, served statically - not an object URL.
      setPreview(sample.image_url)
      try {
        const result = await demoClient.replay(sample.id, (p) => {
          if (p.percent !== undefined) setProgress(p.percent)
          setStage(p.stage)
        })
        setRecord(result)
        setStatus('done')
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load sample.')
        setStatus('error')
      }
    },
    [demoClient, setPreview],
  )

  const openAnalysis = useCallback(
    async (id: string) => {
      if (isDemo) {
        const sample = DEMO_SAMPLES.find((x) => x.record.analysis_id === id)
        if (sample) {
          setRecord(sample.record)
          setPreview(sample.image_url)
          setStatus('done')
          setError(null)
          setSelectedId(null)
        }
        return
      }
      try {
        const full = await getAnalysis(id)
        setRecord(full)
        setStatus('done')
        setError(null)
        setSelectedId(null)
        // Historical records have no local object URL for the image.
        setPreview(null)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load analysis.')
        setStatus('error')
      }
    },
    [setPreview, isDemo],
  )

  const removeAnalysis = useCallback(
    async (id: string) => {
      try {
        await deleteAnalysis(id)
        setHistory((prev) => prev.filter((h) => h.analysis_id !== id))
        setCompareIds((prev) => prev.filter((c) => c !== id))
        if (record?.analysis_id === id) reset()
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not delete.')
      }
    },
    [record, reset],
  )

  const toggleCompare = useCallback((id: string) => {
    setCompareIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((p) => p !== id)
        : [...prev, id].slice(-2)
      // Clear a stale comparison here rather than in an effect, so the
      // selection and its result always change together.
      if (next.length !== 2) setComparison(null)
      return next
    })
  }, [])

  // Fetch a comparison once exactly two scans are selected.
  useEffect(() => {
    if (compareIds.length !== 2) return
    // No backend in demo mode, and the compare controls are hidden there.
    if (isDemo) return
    let cancelled = false
    compareAnalyses(compareIds[0], compareIds[1])
      .then((res) => {
        if (!cancelled) setComparison(res)
      })
      .catch(() => {
        if (!cancelled) setComparison(null)
      })
    return () => {
      cancelled = true
    }
  }, [compareIds, isDemo])

  // -- derived -----------------------------------------------------------

  const visibleDetections = useMemo(() => {
    if (!record?.detection) return []
    return record.detection.detections.filter(
      (d) => d.confidence >= minConfidence,
    )
  }, [record, minConfidence])

  const visibleCategories = useMemo(() => {
    if (!record?.retail) return []
    const allowed = new Set(visibleDetections.map((d) => d.label))
    return record.retail.categories.filter((c) => allowed.has(c.label))
  }, [record, visibleDetections])

  // Colours are assigned by category rank, so the categories present in this
  // analysis are always visually distinct.
  const colors = useMemo(
    () => buildColorMap((record?.retail?.categories ?? []).map((c) => c.label)),
    [record],
  )

  const detection = record?.detection ?? null
  const modelUnavailable = detection?.status === 'unavailable'

  return (
    <div className="app">
      <header className="app__header">
        <div className="brand">
          <span className="brand__mark">◆</span>
          <div>
            <h1>VisionIQ</h1>
            <p>Retail Shelf Intelligence</p>
          </div>
        </div>
        <div className="statusbar">
          {system && (
            <>
              <span
                className={`pill ${system.model_available ? 'pill--ok' : 'pill--warn'}`}
                title={system.model_unavailable_reason ?? 'Model loaded'}
              >
                {system.model_available
                  ? `${system.model.name}`
                  : 'model unavailable'}
              </span>
              <span className="pill">{system.execution_mode}</span>
            </>
          )}
          {mode === 'cognito' && onLogout && (
            <div className="account">
              <span className="account__name" title={user?.subject ?? ''}>
                {user?.email ?? user?.subject ?? 'Signed in'}
              </span>
              <button type="button" className="chip" onClick={onLogout}>
                Sign out
              </button>
            </div>
          )}
          {mode === 'local' && (
            <span
              className="pill pill--warn"
              title="VITE_AUTH_MODE=local — no authentication. Never used in a production build."
            >
              auth off (local)
            </span>
          )}
        </div>
      </header>

      {system && !system.model_available && (
        <p className="notice notice--warn notice--wide">
          <strong>No detection model is loaded.</strong>{' '}
          {system.model_unavailable_reason} Images will still be validated, but
          no objects can be detected.
        </p>
      )}

      {isDemo && <DemoBanner modelName={DEMO_MODEL?.name} />}

      <main className="layout">
        {/* ---- Workspace ---- */}
        <section className="column column--main">
          {isDemo ? (
            <SamplePicker
              activeId={record?.analysis_id ?? null}
              busy={status === 'uploading'}
              onPick={handleDemoPick}
            />
          ) : (
            <Dropzone
              disabled={status === 'uploading'}
              onFileSelected={handleFile}
            />
          )}

          {status === 'uploading' && (
            <div className="panel">
              <div className="progress" aria-label="Analysis progress">
                <div
                  className="progress__bar"
                  style={{ width: `${Math.max(progress, 8)}%` }}
                />
                <span className="progress__label">
                  {stage === 'uploading' && progress < 100
                    ? `Uploading… ${progress}%`
                    : stage === 'queued'
                      ? 'Queued for analysis…'
                      : 'Running detection…'}
                </span>
              </div>
            </div>
          )}

          {status === 'error' && error && (
            <div className="panel state state--error">
              <span className="badge badge--error">Error</span>
              <h2>Could not analyze image</h2>
              <p>{error}</p>
              <button className="btn" type="button" onClick={reset}>
                Try another image
              </button>
            </div>
          )}

          {record && detection && (
            <>
              {previewUrl ? (
                <div className="panel">
                  <div className="panel__header">
                    <h2>Annotated image</h2>
                    <button className="link-btn" onClick={reset} type="button">
                      Clear
                    </button>
                  </div>
                  <AnnotatedImage
                    src={previewUrl}
                    imageWidth={detection.image_width}
                    imageHeight={detection.image_height}
                    detections={visibleDetections}
                    colors={colors}
                    showBoxes={showBoxes}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                </div>
              ) : (
                <div className="panel state state--empty">
                  <h2>Image preview unavailable</h2>
                  <p>
                    This analysis was loaded from history. The original image is
                    not held in the browser, so boxes cannot be overlaid — the
                    detection data below is complete.
                  </p>
                </div>
              )}

              {detection.warnings.length > 0 && (
                <div className="panel notice-panel">
                  <h3 className="subhead">Model notes</h3>
                  <ul className="bullets">
                    {detection.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {modelUnavailable ? (
                <div className="panel state state--empty">
                  <span className="badge badge--warn">No inference</span>
                  <h2>Detection did not run</h2>
                  <p>
                    The image was validated successfully, but no detection model
                    was available. No objects were analysed — this does not mean
                    the shelf is empty.
                  </p>
                </div>
              ) : (
                <DetectionPanel
                  detection={detection}
                  categories={visibleCategories}
                  visible={visibleDetections}
                  colors={colors}
                  minConfidence={minConfidence}
                  onMinConfidenceChange={setMinConfidence}
                  showBoxes={showBoxes}
                  onToggleBoxes={setShowBoxes}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              )}
            </>
          )}

          {status === 'idle' && !record && (
            <div className="panel state state--empty">
              <div className="state__icon" aria-hidden="true">
                ☷
              </div>
              <h2>No analysis yet</h2>
              <p>
                Upload a shelf image to detect objects, view bounding boxes and
                confidence scores, and build a scan history.
              </p>
            </div>
          )}
        </section>

        {/* ---- Side rail ---- */}
        <section className="column column--side">
          {record?.insights && record.retail && (
            <InsightsPanel insights={record.insights} retail={record.retail} />
          )}

          {record && (
            <>
              <MetadataPanel metadata={record.image} />
              {detection && (
                <div className="panel">
                  <div className="panel__header">
                    <h2>Model</h2>
                  </div>
                  <dl className="facts">
                    <div>
                      <dt>Name</dt>
                      <dd>{detection.model.name}</dd>
                    </div>
                    <div>
                      <dt>Provider</dt>
                      <dd>{detection.model.provider}</dd>
                    </div>
                    <div>
                      <dt>Taxonomy</dt>
                      <dd>{detection.model.taxonomy}</dd>
                    </div>
                    <div>
                      <dt>Device</dt>
                      <dd>{detection.model.device}</dd>
                    </div>
                    <div>
                      <dt>Inference</dt>
                      <dd>{Math.round(detection.processing_ms)} ms</dd>
                    </div>
                    <div>
                      <dt>Threshold</dt>
                      <dd>
                        {Math.round(detection.confidence_threshold * 100)}%
                      </dd>
                    </div>
                  </dl>
                </div>
              )}
            </>
          )}

          <HistoryPanel
            items={history}
            loading={historyLoading}
            search={search}
            onSearchChange={setSearch}
            activeId={record?.analysis_id ?? null}
            compareIds={compareIds}
            comparison={comparison}
            hasMore={hasMore}
            readOnly={isDemo}
            onSelect={openAnalysis}
            onDelete={removeAnalysis}
            onToggleCompare={toggleCompare}
            onLoadMore={() => void loadHistory()}
            onClearComparison={() => {
              setCompareIds([])
              setComparison(null)
            }}
          />
        </section>
      </main>
    </div>
  )
}

export default App

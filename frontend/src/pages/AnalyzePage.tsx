import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, validateFile } from '../api/client'
import { getAnalysisClient, type AnalysisProgress } from '../api/analysisClient'
import { AnnotatedImage } from '../components/AnnotatedImage'
import { DetectionPanel } from '../components/DetectionPanel'
import { DemoBanner, SamplePicker } from '../components/DemoPanel'
import { Dropzone } from '../components/Dropzone'
import { InsightsPanel } from '../components/InsightsPanel'
import { MetadataPanel } from '../components/MetadataPanel'
import { ConfidenceExplorer } from '../components/analyze/ConfidenceExplorer'
import { ExplainabilityPanel } from '../components/analyze/Explainability'
import { HeatmapControls, HeatmapLayer } from '../components/analyze/Heatmap'
import { ViewerToolbar, type ViewerLayers } from '../components/analyze/ViewerToolbar'
import { ZoneDrawLayer, ZoneLayer, ZonePanel } from '../components/analyze/Zones'
import { Tabs } from '../components/ui/Controls'
import { EmptyState, ErrorState, Skeleton } from '../components/ui/States'
import { useScanData } from '../data/useScanData'
import { primeScanImage, useScanImage } from '../data/useScanImage'
import { DEMO_MODEL } from '../demo/demoData'
import {
  filterByThreshold,
  inferenceThreshold,
  scanOutcome,
  sortNewestFirst,
  summarizeDetections,
} from '../lib/analytics'
import { formatDateTime, formatPercent, formatRelative, pluralize } from '../lib/format'
import { href, navigate } from '../lib/router'
import { loadZones, newZoneId, normalizeZone, saveZones, UNASSIGNED, zoneFor, type Zone } from '../lib/zones'
import type { AnalysisRecord, CategoryCount } from '../types'
import { buildColorMap } from '../utils/colors'
import { ReportButton } from './reportActions'
import { quality as qualityApi } from '../api/workbench'
import { QualityCard } from '../components/analyze/QualityCard'
import { useAsync } from '../hooks/useAsync'

export function AnalyzePage({ scanId }: { scanId?: string }) {
  return scanId ? <ScanLoader key={scanId} id={scanId} /> : <AnalyzeStart />
}

// ---------------------------------------------------------------------------
// Start: upload a new image (or pick a recorded sample in the demo)
// ---------------------------------------------------------------------------

type UploadState =
  | { phase: 'idle' }
  | { phase: 'running'; percent: number; stage: AnalysisProgress['stage'] }
  | { phase: 'error'; message: string }

function AnalyzeStart() {
  const data = useScanData()
  const { source } = data
  const [upload, setUpload] = useState<UploadState>({ phase: 'idle' })
  const [preview, setPreview] = useState<string | null>(null)
  const previewRef = useRef<string | null>(null)

  const handleFile = useCallback(
    async (file: File) => {
      const problem = validateFile(file)
      if (problem) {
        setUpload({ phase: 'error', message: problem })
        return
      }
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
      const url = URL.createObjectURL(file)
      previewRef.current = url
      setPreview(url)
      setUpload({ phase: 'running', percent: 0, stage: 'uploading' })

      try {
        const record = await getAnalysisClient().analyze(file, (p) =>
          setUpload({ phase: 'running', percent: p.percent ?? 100, stage: p.stage }),
        )
        // Hand the already-loaded image to the scan view and keep it alive.
        primeScanImage(source.mode, record.analysis_id, url)
        previewRef.current = null
        data.upsert(record)
        navigate(href('analyze', { id: record.analysis_id }))
      } catch (err) {
        setUpload({
          phase: 'error',
          message: err instanceof ApiError ? err.message : 'Unexpected error.',
        })
      }
    },
    [data, source.mode],
  )

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    },
    [],
  )

  const recent = sortNewestFirst(data.summaries).slice(0, 6)
  const busy = upload.phase === 'running'

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Analyze</p>
          <h1 className="page-title">Run shelf detection</h1>
          <p className="page-subtitle">
            Upload a shelf photo. VisionIQ runs the local YOLO model and records every detection
            it returns — nothing is estimated or filled in.
          </p>
        </div>
      </header>

      {source.mode === 'demo' && <DemoBanner modelName={DEMO_MODEL?.name} />}

      <div className="start-grid">
        <div className="start-grid__main">
          {source.canAnalyze ? (
            <Dropzone disabled={busy} onFileSelected={handleFile} />
          ) : (
            <SamplePicker
              activeId={null}
              busy={false}
              onPick={(sample) => navigate(href('analyze', { id: sample.record.analysis_id }))}
            />
          )}

          {upload.phase === 'running' && (
            <div className="card upload-progress" aria-live="polite">
              {preview && <img src={preview} alt="" className="upload-progress__thumb" />}
              <div className="upload-progress__body">
                <strong>
                  {upload.stage === 'uploading' && upload.percent < 100
                    ? `Uploading… ${upload.percent}%`
                    : upload.stage === 'queued'
                      ? 'Queued for analysis…'
                      : 'Running detection…'}
                </strong>
                <div className="progress" aria-hidden="true">
                  <div className="progress__bar" style={{ width: `${Math.max(8, upload.percent)}%` }} />
                </div>
                <span className="fineprint">
                  CPU inference typically takes a few seconds; the first run also loads the model.
                </span>
              </div>
            </div>
          )}

          {upload.phase === 'error' && (
            <ErrorState
              title="Could not analyze image"
              message={upload.message}
              onRetry={() => setUpload({ phase: 'idle' })}
            />
          )}
        </div>

        <aside className="card start-grid__side">
          <header className="card__header">
            <h2 className="card__title">Recent scans</h2>
            <a className="link" href={href('timeline')}>
              Timeline →
            </a>
          </header>
          {data.status === 'loading' ? (
            <div className="stack-sm">
              <Skeleton height={44} />
              <Skeleton height={44} />
              <Skeleton height={44} />
            </div>
          ) : recent.length === 0 ? (
            <EmptyState title="No scans yet" compact>
              Your analyses will appear here.
            </EmptyState>
          ) : (
            <ul className="recent-list">
              {recent.map((s) => (
                <li key={s.analysis_id}>
                  <a className="recent-list__item" href={href('analyze', { id: s.analysis_id })}>
                    <span className="recent-list__name">{s.filename}</span>
                    <span className="recent-list__meta">
                      {pluralize(s.detection_count, 'detection')} · {formatRelative(s.created_at)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Load one scan
// ---------------------------------------------------------------------------

function ScanLoader({ id }: { id: string }) {
  const data = useScanData()
  const cached = data.recordFor(id)
  const { ensureRecord } = data
  const [state, setState] = useState<{ record?: AnalysisRecord; error?: string }>({})

  useEffect(() => {
    if (cached) return
    let cancelled = false
    ensureRecord(id)
      .then((record) => {
        if (!cancelled) setState({ record })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            error:
              err instanceof ApiError && err.code === '404'
                ? 'This scan does not exist or was deleted.'
                : err instanceof ApiError
                  ? err.message
                  : 'This scan could not be loaded.',
          })
      })
    return () => {
      cancelled = true
    }
  }, [id, cached, ensureRecord])

  const record = cached ?? state.record
  if (record) return <ScanWorkspace key={record.analysis_id} record={record} />

  return (
    <div className="page">
      {state.error ? (
        <ErrorState
          title="Scan unavailable"
          message={state.error}
          onRetry={() => navigate(href('timeline'))}
        />
      ) : (
        <div className="stack">
          <Skeleton height={36} width="40%" />
          <Skeleton height={420} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The workspace: viewer + explorer + side panels
// ---------------------------------------------------------------------------

type SideTab = 'detections' | 'zones' | 'model' | 'quality' | 'insights'

function ScanWorkspace({ record }: { record: AnalysisRecord }) {
  const data = useScanData()
  const image = useScanImage(record)
  const detection = record.detection
  const outcome = scanOutcome(record)
  const floor = inferenceThreshold(record)
  const all = useMemo(() => detection?.detections ?? [], [detection])
  const width = detection?.image_width ?? record.image.width
  const height = detection?.image_height ?? record.image.height

  // Every view below reads this one threshold, so boxes, charts, zones, the
  // heatmap and the detection list can never disagree.
  const [threshold, setThreshold] = useState(floor)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [layers, setLayers] = useState<ViewerLayers>({
    boxes: true,
    labels: false,
    heatmap: false,
    zones: false,
  })
  const [heatOpacity, setHeatOpacity] = useState(0.65)
  const [zones, setZonesState] = useState<Zone[]>(() => loadZones())
  const [selectedZone, setSelectedZone] = useState<string | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [tab, setTab] = useState<SideTab>('detections')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const setZones = useCallback((next: Zone[]) => {
    setZonesState(next)
    saveZones(next)
  }, [])

  const visible = useMemo(() => filterByThreshold(all, threshold), [all, threshold])
  const summary = useMemo(() => summarizeDetections(visible), [visible])
  const colors = useMemo(
    () => buildColorMap(summarizeDetections(all).categories.map((c) => c.label)),
    [all],
  )
  // DetectionPanel speaks the backend's CategoryCount shape; feed it counts
  // recomputed for the visible set, not the unfiltered totals.
  const visibleCategories: CategoryCount[] = useMemo(
    () =>
      summary.categories.map((c) => ({
        label: c.label,
        count: c.count,
        mean_confidence: c.meanConfidence,
        min_confidence: c.minConfidence,
        max_confidence: c.maxConfidence,
      })),
    [summary],
  )

  // Detections outside the selected zone are faded on the image.
  const dimmedIds = useMemo(() => {
    if (!selectedZone || !layers.zones) return undefined
    return new Set(
      visible
        .filter((d) => {
          const z = zoneFor(d, zones, width, height)
          return selectedZone === UNASSIGNED ? z !== UNASSIGNED : z !== selectedZone
        })
        .map((d) => d.id),
    )
  }, [selectedZone, layers.zones, visible, zones, width, height])

  const showZoneLayer = layers.zones || tab === 'zones'
  const modelRan = outcome === 'analyzed' || outcome === 'empty'

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head__text">
          <nav className="crumbs" aria-label="Breadcrumb">
            <a href={href('analyze')}>Analyze</a>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{record.image.filename}</span>
          </nav>
          <h1 className="page-title page-title--file">{record.image.filename}</h1>
          <p className="page-subtitle">
            {formatDateTime(record.created_at)} · {detection?.model.name ?? 'no model'} ·{' '}
            {pluralize(all.length, 'detection')} at ≥{formatPercent(floor)}
            {record.execution_mode === 'demo' && ' · recorded demo result'}
          </p>
        </div>
        <div className="page-head__actions">
          <a className="btn btn--ghost" href={href('compare', { params: { a: record.analysis_id } })}>
            Compare
          </a>
          <ReportButton
            record={record}
            imageUrl={image.url}
            threshold={threshold}
            zones={zones}
            colors={colors}
          />
          {data.source.canDelete &&
            (confirmDelete ? (
              <span className="confirm">
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    data
                      .remove(record.analysis_id)
                      .then(() => navigate(href('timeline')))
                      .catch(() => setConfirmDelete(false))
                  }}
                >
                  Confirm delete
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="btn btn--ghost" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            ))}
          {data.source.mode === 'local' && modelRan && (
            <a className="btn btn--ghost" href={href('annotate', { id: record.analysis_id })}>
              Annotate
            </a>
          )}
          <a className="btn btn--primary" href={href('analyze')}>
            New analysis
          </a>
        </div>
      </header>

      {record.execution_mode === 'demo' && <DemoBanner modelName={detection?.model.name} />}

      {outcome === 'unavailable' && (
        <div className="callout callout--warn" role="note">
          <strong>Detection did not run.</strong> The image was validated, but no model was
          available, so nothing was analysed. This is not evidence of an empty shelf.
        </div>
      )}
      {outcome === 'failed' && (
        <div className="callout callout--error" role="alert">
          <strong>Analysis failed.</strong> {record.error ?? 'No results were produced.'}
        </div>
      )}
      {outcome === 'pending' && (
        <div className="callout" role="status">
          <strong>Still processing.</strong> This cloud job is {record.status}.{' '}
          <button type="button" className="link-btn" onClick={data.refresh}>
            Refresh
          </button>
        </div>
      )}

      <div className="workspace">
        <div className="workspace__main">
          <section className="card viewer" aria-label="Annotated image">
            <ViewerToolbar layers={layers} onChange={setLayers} disabled={!modelRan} />
            <div className="viewer__stage">
              {image.status === 'ready' && image.url ? (
                <AnnotatedImage
                  src={image.url}
                  alt={`${record.image.filename} with ${visible.length} detections`}
                  imageWidth={width}
                  imageHeight={height}
                  detections={visible}
                  colors={colors}
                  showBoxes={layers.boxes}
                  showLabels={layers.labels}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  dimmedIds={dimmedIds}
                  underlay={
                    <>
                      {layers.heatmap && (
                        <HeatmapLayer
                          detections={visible}
                          imageWidth={width}
                          imageHeight={height}
                          opacity={heatOpacity}
                        />
                      )}
                      {showZoneLayer && (
                        <ZoneLayer
                          zones={zones}
                          imageWidth={width}
                          imageHeight={height}
                          selectedId={selectedZone}
                        />
                      )}
                    </>
                  }
                  overlay={
                    drawing ? (
                      <ZoneDrawLayer
                        imageWidth={width}
                        imageHeight={height}
                        onDraw={(rect) => {
                          setZones([
                            ...zones,
                            normalizeZone({
                              id: newZoneId(zones),
                              name: `Zone ${zones.length + 1}`,
                              ...rect,
                            }),
                          ])
                          setDrawing(false)
                        }}
                      />
                    ) : null
                  }
                />
              ) : image.status === 'loading' || image.status === 'idle' ? (
                <Skeleton height={380} />
              ) : (
                <EmptyState title="Image not available" icon="▢">
                  {data.source.mode === 'cloud'
                    ? 'Images are stored in a private bucket and are not served to the dashboard in cloud mode. All detection data below is complete.'
                    : 'The stored image for this scan could not be found. All detection data below is complete.'}
                </EmptyState>
              )}
            </div>
            <HeatmapControls
              enabled={layers.heatmap}
              opacity={heatOpacity}
              onOpacity={setHeatOpacity}
              detectionCount={visible.length}
              onReset={() => {
                setHeatOpacity(0.65)
                setLayers((l) => ({ ...l, heatmap: false }))
              }}
            />
            {drawing && (
              <p className="fineprint viewer__hint">
                Drag on the image to draw a zone.{' '}
                <button type="button" className="link-btn" onClick={() => setDrawing(false)}>
                  Cancel
                </button>
              </p>
            )}
          </section>

          {modelRan && (
            <ConfidenceExplorer
              detections={all}
              inferenceThreshold={floor}
              threshold={threshold}
              onChange={(t) => {
                setThreshold(t)
                setSelectedId(null)
              }}
              colors={colors}
            />
          )}
        </div>

        <aside className="card workspace__side">
          <Tabs<SideTab>
            label="Scan details"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'detections', label: 'Detections', badge: visible.length },
              { value: 'zones', label: 'Zones' },
              { value: 'model', label: 'Model' },
              ...(data.source.mode === 'local' ? [{ value: 'quality' as const, label: 'Quality' }] : []),
              { value: 'insights', label: 'Insights' },
            ]}
          >
            {tab === 'detections' &&
              (detection && modelRan ? (
                <DetectionPanel
                  detection={detection}
                  categories={visibleCategories}
                  visible={visible}
                  colors={colors}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              ) : (
                <p className="note">No detections — the model did not run on this scan.</p>
              ))}
            {tab === 'zones' && (
              <ZonePanel
                zones={zones}
                onZonesChange={setZones}
                detections={visible}
                imageWidth={width}
                imageHeight={height}
                selectedId={selectedZone}
                onSelect={(z) => {
                  setSelectedZone(z)
                  if (z) setLayers((l) => ({ ...l, zones: true }))
                }}
                drawing={drawing}
                onDrawingChange={(d) => {
                  setDrawing(d)
                  if (d) setLayers((l) => ({ ...l, zones: true }))
                }}
                threshold={threshold}
              />
            )}
            {tab === 'model' && (
              <ExplainabilityPanel
                record={record}
                visible={visible}
                threshold={threshold}
                inferenceThreshold={floor}
                onThreshold={setThreshold}
                colors={colors}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            )}
            {tab === 'quality' && <ScanQuality analysisId={record.analysis_id} hasImage={!!record.image_key} />}
            {tab === 'insights' && (
              <div className="stack">
                {record.insights && record.retail ? (
                  <InsightsPanel insights={record.insights} retail={record.retail} />
                ) : (
                  <p className="note">No insights are attached to this scan.</p>
                )}
                <MetadataPanel metadata={record.image} />
              </div>
            )}
          </Tabs>
        </aside>
      </div>
    </div>
  )
}

/** Image-quality report for this scan (computed once on the backend, cached). */
function ScanQuality({ analysisId, hasImage }: { analysisId: string; hasImage: boolean }) {
  const q = useAsync(() => (hasImage ? qualityApi.get(analysisId) : Promise.resolve(null)), [analysisId, hasImage])
  if (!hasImage) return <p className="note">No stored image, so quality cannot be inspected.</p>
  if (q.error) return <ErrorState message={q.error} onRetry={q.reload} />
  if (!q.data) return <Skeleton height={160} />
  return (
    <div className="stack">
      <QualityCard report={q.data.report} />
      <a className="link" href={href('quality')}>
        All scans in the quality inspector →
      </a>
    </div>
  )
}

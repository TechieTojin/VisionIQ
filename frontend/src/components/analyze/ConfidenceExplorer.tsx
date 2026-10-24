import { useId, useMemo } from 'react'
import {
  confidenceHistogram,
  filterByThreshold,
  LOW_CONFIDENCE,
  summarizeDetections,
} from '../../lib/analytics'
import { formatPercent } from '../../lib/format'
import { colorFor } from '../../utils/colors'
import type { Detection } from '../../types'
import { BarList, Histogram } from '../charts/Charts'

interface ConfidenceExplorerProps {
  /** Everything the model returned for this scan. */
  detections: readonly Detection[]
  /** The threshold the model itself applied. The slider cannot go below it. */
  inferenceThreshold: number
  /** The current display threshold. */
  threshold: number
  onChange: (threshold: number) => void
  colors: Record<string, string>
}

/**
 * Explore detections by confidence without re-running inference.
 *
 * The slider only HIDES detections the model already returned. Its floor is
 * the model's own inference threshold: anything below that was discarded
 * during inference and cannot be recovered here, and the copy says so.
 */
export function ConfidenceExplorer({
  detections,
  inferenceThreshold,
  threshold,
  onChange,
  colors,
}: ConfidenceExplorerProps) {
  const sliderId = useId()
  const visible = useMemo(() => filterByThreshold(detections, threshold), [detections, threshold])
  const summary = useMemo(() => summarizeDetections(visible), [visible])
  const bins = useMemo(
    () => confidenceHistogram(detections, inferenceThreshold),
    [detections, inferenceThreshold],
  )

  const hidden = detections.length - visible.length
  const atDefault = Math.abs(threshold - inferenceThreshold) < 1e-6
  const pct = Math.round(threshold * 100)
  const floorPct = Math.round(inferenceThreshold * 100)

  return (
    <section className="card explorer" aria-labelledby={`${sliderId}-title`}>
      <header className="card__header">
        <div>
          <h2 id={`${sliderId}-title`} className="card__title">
            Confidence explorer
          </h2>
          <p className="card__subtitle">
            Filter the model&apos;s existing detections — inference is not re-run.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => onChange(inferenceThreshold)}
          disabled={atDefault}
        >
          Reset to {floorPct}%
        </button>
      </header>

      <div className="explorer__control">
        <label htmlFor={sliderId} className="explorer__label">
          Show detections at or above
          <output htmlFor={sliderId} className="explorer__value" aria-live="polite">
            {pct}%
          </output>
        </label>
        <input
          id={sliderId}
          type="range"
          className="range"
          min={Math.round(inferenceThreshold * 100)}
          max={100}
          step={1}
          value={pct}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          aria-valuetext={`${pct}% minimum confidence, ${visible.length} of ${detections.length} detections shown`}
        />
        <div className="explorer__scale" aria-hidden="true">
          <span>{floorPct}% · inference floor</span>
          <span>100%</span>
        </div>
      </div>

      <div className="explorer__stats" aria-live="polite">
        <div className="explorer__stat">
          <span className="explorer__stat-value">{visible.length}</span>
          <span className="explorer__stat-label">
            of {detections.length} shown
            {hidden > 0 && <> · {hidden} hidden</>}
          </span>
        </div>
        <div className="explorer__stat">
          <span className="explorer__stat-value">{summary.categories.length}</span>
          <span className="explorer__stat-label">
            {summary.categories.length === 1 ? 'category' : 'categories'}
          </span>
        </div>
        <div className="explorer__stat">
          <span className="explorer__stat-value">{formatPercent(summary.meanConfidence)}</span>
          <span className="explorer__stat-label">mean confidence</span>
        </div>
        <div className="explorer__stat">
          <span
            className={`explorer__stat-value${summary.lowConfidenceCount ? ' is-warn' : ''}`}
          >
            {summary.lowConfidenceCount}
          </span>
          <span className="explorer__stat-label">below {Math.round(LOW_CONFIDENCE * 100)}%</span>
        </div>
      </div>

      {detections.length === 0 ? (
        <p className="note">
          The model returned no detections at or above {floorPct}%, so there is nothing to
          filter. Lowering this slider cannot reveal objects — that would need a new inference
          run with a lower threshold.
        </p>
      ) : (
        <>
          <Histogram
            label="Confidence distribution. Select a bar to set the threshold to its lower edge."
            bins={bins}
            threshold={threshold}
            lowBelow={LOW_CONFIDENCE}
            onSelectBin={(bin) => onChange(Math.max(inferenceThreshold, bin.start))}
            height={88}
          />
          {visible.length === 0 ? (
            <p className="note">
              No detections reach {pct}%. Lower the threshold to bring them back.
            </p>
          ) : (
            <BarList
              label="Visible detections by category"
              items={summary.categories.map((c) => ({
                key: c.label,
                label: c.label,
                value: c.count,
                detail: `avg ${formatPercent(c.meanConfidence)}`,
                color: colorFor(colors, c.label),
              }))}
            />
          )}
        </>
      )}

      <p className="fineprint">
        The model reported nothing below {floorPct}% — those objects were discarded during
        inference and cannot be recovered by this slider. Confidence scores are the model&apos;s
        own scores, not calibrated probabilities.
      </p>
    </section>
  )
}

import { useMemo, useState } from 'react'
import {
  boxAreaShare,
  confidenceHistogram,
  LOW_CONFIDENCE,
  sizeDistribution,
  summarizeDetections,
} from '../../lib/analytics'
import { formatMs, formatPercent } from '../../lib/format'
import { colorFor } from '../../utils/colors'
import type { AnalysisRecord, Detection } from '../../types'
import { BarList, Histogram } from '../charts/Charts'

type SortKey = 'confidence' | 'size' | 'label'

interface ExplainabilityProps {
  record: AnalysisRecord
  /** Detections at or above the current threshold. */
  visible: readonly Detection[]
  threshold: number
  inferenceThreshold: number
  onThreshold: (t: number) => void
  colors: Record<string, string>
  selectedId: number | null
  onSelect: (id: number | null) => void
}

/**
 * Model diagnostics.
 *
 * Deliberately called diagnostics, not "explanations": a confidence
 * histogram and box sizes describe WHAT the model output, not WHY. Nothing
 * here is a saliency map or a causal account of the model's reasoning, and
 * the panel says so.
 */
export function ExplainabilityPanel({
  record,
  visible,
  threshold,
  inferenceThreshold,
  onThreshold,
  colors,
  selectedId,
  onSelect,
}: ExplainabilityProps) {
  const detection = record.detection
  const all = useMemo(() => detection?.detections ?? [], [detection])
  const width = detection?.image_width ?? record.image.width
  const height = detection?.image_height ?? record.image.height

  const summary = useMemo(() => summarizeDetections(visible), [visible])
  const bins = useMemo(() => confidenceHistogram(all, inferenceThreshold), [all, inferenceThreshold])
  const sizes = useMemo(() => sizeDistribution(visible, width, height), [visible, width, height])
  const low = useMemo(
    () => visible.filter((d) => d.confidence < LOW_CONFIDENCE).sort((a, b) => a.confidence - b.confidence),
    [visible],
  )

  const [sort, setSort] = useState<SortKey>('confidence')
  const [showAll, setShowAll] = useState(false)
  const rows = useMemo(() => {
    const list = [...visible]
    if (sort === 'confidence') list.sort((a, b) => b.confidence - a.confidence)
    if (sort === 'size') list.sort((a, b) => b.box.area - a.box.area)
    if (sort === 'label') list.sort((a, b) => a.label.localeCompare(b.label) || b.confidence - a.confidence)
    return list
  }, [visible, sort])
  const shown = showAll ? rows : rows.slice(0, 12)

  if (!detection) {
    return <p className="note">No inference metadata is attached to this scan.</p>
  }

  return (
    <div className="explain">
      <section className="explain__section">
        <h3 className="section-title">Model</h3>
        <dl className="kv">
          <Kv label="Model" value={detection.model.name} />
          <Kv label="Version" value={detection.model.version || 'Not available'} />
          <Kv label="Provider" value={detection.model.provider} />
          <Kv
            label="Taxonomy"
            value={detection.model.taxonomy}
            hint="The label space. COCO-80 is a generic object set, not a retail product catalogue."
          />
          <Kv label="Device" value={detection.model.device} />
          <Kv
            label="Inference time"
            value={formatMs(detection.processing_ms)}
            hint="Wall-clock duration measured by the backend for this run."
          />
          <Kv label="Inference threshold" value={formatPercent(inferenceThreshold)} />
          <Kv label="Status" value={detection.status} />
        </dl>
      </section>

      <section className="explain__section">
        <h3 className="section-title">Confidence distribution</h3>
        <p className="fineprint">
          All {all.length} detections the model returned. Bars left of the marker are hidden by
          the current {formatPercent(threshold)} threshold; select a bar to move it there.
        </p>
        {all.length ? (
          <Histogram
            label="Confidence histogram"
            bins={bins}
            threshold={threshold}
            lowBelow={LOW_CONFIDENCE}
            onSelectBin={(bin) => onThreshold(Math.max(inferenceThreshold, bin.start))}
          />
        ) : (
          <p className="note">No detections to chart.</p>
        )}
      </section>

      <section className="explain__section">
        <h3 className="section-title">Detection size</h3>
        <p className="fineprint">Box area as a share of the whole image, for visible detections.</p>
        <BarList
          label="Detections by box size"
          items={sizes.map((s) => ({ key: s.label, label: s.label, value: s.count }))}
          emptyText="No visible detections."
        />
      </section>

      <section className="explain__section">
        <h3 className="section-title">Categories</h3>
        <BarList
          label="Visible detections by category"
          items={summary.categories.map((c) => ({
            key: c.label,
            label: c.label,
            value: c.count,
            detail: `${formatPercent(c.minConfidence)}–${formatPercent(c.maxConfidence)}`,
            color: colorFor(colors, c.label),
          }))}
          emptyText="No visible detections."
        />
      </section>

      {low.length > 0 && (
        <section className="explain__section">
          <div className="callout callout--warn" role="note">
            <strong>
              {low.length} low-confidence detection{low.length === 1 ? '' : 's'}
            </strong>{' '}
            below {formatPercent(LOW_CONFIDENCE)}. These are the model&apos;s least certain outputs
            and should be checked against the image before anyone relies on them.
            <ul className="chips">
              {low.slice(0, 8).map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    className={`chip-btn${selectedId === d.id ? ' is-active' : ''}`}
                    onClick={() => onSelect(selectedId === d.id ? null : d.id)}
                  >
                    {d.label} {formatPercent(d.confidence)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="explain__section">
        <div className="section-head">
          <h3 className="section-title">Detections ({visible.length})</h3>
          <label className="select-inline">
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="confidence">Confidence</option>
              <option value="size">Size</option>
              <option value="label">Label</option>
            </select>
          </label>
        </div>
        {visible.length === 0 ? (
          <p className="note">No detections at this threshold.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Label</th>
                  <th scope="col" className="num">
                    Confidence
                  </th>
                  <th scope="col" className="num">
                    Box (px)
                  </th>
                  <th scope="col" className="num">
                    Area
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <tr
                    key={d.id}
                    className={selectedId === d.id ? 'is-selected' : undefined}
                    aria-selected={selectedId === d.id}
                  >
                    <td>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => onSelect(selectedId === d.id ? null : d.id)}
                        aria-label={`Highlight detection ${d.id}, ${d.label}`}
                      >
                        {d.id}
                      </button>
                    </td>
                    <td>
                      <span
                        className="dot"
                        style={{ background: colorFor(colors, d.label) }}
                        aria-hidden="true"
                      />
                      {d.label}
                    </td>
                    <td className={`num${d.confidence < LOW_CONFIDENCE ? ' text-warn' : ''}`}>
                      {formatPercent(d.confidence, 1)}
                    </td>
                    <td className="num">
                      {Math.round(d.box.width)}×{Math.round(d.box.height)}
                    </td>
                    <td className="num">{formatPercent(boxAreaShare(d, width, height), 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 12 && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        )}
      </section>

      <section className="explain__section">
        <h3 className="section-title">Reliability and limitations</h3>
        <ul className="bullets">
          <li>
            <strong>Confidence is not probability.</strong> These are the model&apos;s own scores.
            They have not been calibrated against ground truth for shelf images, so 80% does not
            mean an 80% chance of being right.
          </li>
          <li>
            <strong>This is diagnostics, not explanation.</strong> Boxes and score distributions
            show what the model output — not why. No saliency or causal analysis is performed.
          </li>
          <li>
            <strong>No SKU recognition.</strong> A generic {detection.model.taxonomy} detector
            sees &ldquo;bottle&rdquo;, not a product. Counts are detections, not inventory.
          </li>
          <li>
            <strong>No shelf-gap detection.</strong> Empty space is never inferred from missing
            boxes; occlusion, angle and lighting all cause misses.
          </li>
          {detection.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function Kv({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kv__row" title={hint}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

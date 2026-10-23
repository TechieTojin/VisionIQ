import type { CategoryCount, Detection, DetectionResult } from '../types'
import { colorFor } from '../utils/colors'

interface DetectionPanelProps {
  detection: DetectionResult
  categories: CategoryCount[]
  visible: Detection[]
  colors: Record<string, string>
  minConfidence: number
  onMinConfidenceChange: (value: number) => void
  showBoxes: boolean
  onToggleBoxes: (value: boolean) => void
  showLabels: boolean
  onToggleLabels: (value: boolean) => void
  selectedId: number | null
  onSelect: (id: number | null) => void
}

export function DetectionPanel({
  detection,
  categories,
  visible,
  colors,
  minConfidence,
  onMinConfidenceChange,
  showBoxes,
  onToggleBoxes,
  showLabels,
  onToggleLabels,
  selectedId,
  onSelect,
}: DetectionPanelProps) {
  const hidden = detection.detections.length - visible.length

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Detections</h2>
        <span className="muted-sm">
          {visible.length} shown
          {hidden > 0 && ` · ${hidden} filtered`}
        </span>
      </div>

      <div className="controls">
        <label className="switch">
          <input
            type="checkbox"
            checked={showBoxes}
            onChange={(e) => onToggleBoxes(e.target.checked)}
          />
          <span>Bounding boxes</span>
        </label>

        <label className="switch">
          <input
            type="checkbox"
            checked={showLabels}
            disabled={!showBoxes}
            onChange={(e) => onToggleLabels(e.target.checked)}
          />
          <span
            title="Off by default: on a dense shelf, dozens of labels obscure the image. Hover, focus or click a box to read its label."
          >
            All labels
          </span>
        </label>

        <label className="slider">
          <span>
            Min confidence: <strong>{Math.round(minConfidence * 100)}%</strong>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(minConfidence * 100)}
            onChange={(e) => onMinConfidenceChange(Number(e.target.value) / 100)}
            aria-label="Minimum confidence filter"
          />
        </label>
      </div>

      {categories.length > 0 && (
        <>
          <h3 className="subhead">Category breakdown</h3>
          <ul className="categories">
            {categories.map((cat) => {
              const max = categories[0].count || 1
              return (
                <li key={cat.label}>
                  <span
                    className="categories__swatch"
                    style={{ background: colorFor(colors, cat.label) }}
                    aria-hidden="true"
                  />
                  <span className="categories__label">{cat.label}</span>
                  <span className="categories__bar" aria-hidden="true">
                    <span
                      style={{
                        width: `${(cat.count / max) * 100}%`,
                        background: colorFor(colors, cat.label),
                      }}
                    />
                  </span>
                  <span className="categories__count">{cat.count}</span>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {visible.length > 0 ? (
        <>
          <h3 className="subhead">All detections</h3>
          <ul className="detections">
            {visible.map((det) => (
              <li key={det.id}>
                <button
                  type="button"
                  className={`detections__row${
                    selectedId === det.id ? ' is-selected' : ''
                  }`}
                  onClick={() => onSelect(selectedId === det.id ? null : det.id)}
                  aria-pressed={selectedId === det.id}
                >
                  <span
                    className="categories__swatch"
                    style={{ background: colorFor(colors, det.label) }}
                    aria-hidden="true"
                  />
                  <span className="detections__label">{det.label}</span>
                  <span
                    className={`conf${det.confidence < 0.5 ? ' conf--low' : ''}`}
                  >
                    {Math.round(det.confidence * 100)}%
                  </span>
                  <span className="detections__box">
                    {Math.round(det.box.width)}×{Math.round(det.box.height)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">
          {detection.detections.length === 0
            ? 'No objects were detected in this image.'
            : 'No detections meet the current confidence filter. Lower the threshold to see more.'}
        </p>
      )}
    </div>
  )
}

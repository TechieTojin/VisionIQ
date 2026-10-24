import { useId, useMemo, useState } from 'react'
import { formatPercent } from '../../lib/format'
import {
  DEFAULT_ZONES,
  isDefaultLayout,
  newZoneId,
  normalizeZone,
  rectFromDrag,
  UNASSIGNED,
  zoneStats,
  zoneTint,
  type Zone,
} from '../../lib/zones'
import type { Detection } from '../../types'


// ---------------------------------------------------------------------------
// SVG layers (drawn inside AnnotatedImage, in original-image coordinates)
// ---------------------------------------------------------------------------

export function ZoneLayer({
  zones,
  imageWidth,
  imageHeight,
  selectedId,
}: {
  zones: readonly Zone[]
  imageWidth: number
  imageHeight: number
  selectedId: string | null
}) {
  const stroke = Math.max(1.5, Math.max(imageWidth, imageHeight) / 400)
  const font = Math.max(11, Math.round(Math.max(imageWidth, imageHeight) / 50))
  return (
    <g className="zone-layer" pointerEvents="none" aria-hidden="true">
      {zones.map((z, i) => {
        const x = z.x0 * imageWidth
        const y = z.y0 * imageHeight
        // Zones sharing a top-left corner would draw their labels on top of
        // each other; stack each later label one line lower.
        const stacked = zones.slice(0, i).filter((o) => Math.abs(o.x0 - z.x0) < 0.02 && Math.abs(o.y0 - z.y0) < 0.02).length
        const w = (z.x1 - z.x0) * imageWidth
        const h = (z.y1 - z.y0) * imageHeight
        const selected = selectedId === z.id
        const faded = selectedId !== null && !selected
        const tint = zoneTint(i)
        return (
          <g key={z.id} opacity={faded ? 0.35 : 1}>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill={tint}
              fillOpacity={selected ? 0.16 : 0.06}
              stroke={tint}
              strokeWidth={selected ? stroke * 2 : stroke}
              strokeDasharray={selected ? undefined : `${stroke * 4} ${stroke * 3}`}
            />
            <text
              x={x + font * 0.5}
              y={y + font * 1.35 + stacked * font * 1.25}
              fontSize={font}
              fontWeight={700}
              fill={tint}
              className="zone-layer__label"
            >
              {z.name}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/**
 * A full-image capture surface for drawing a new zone with the pointer.
 * Only mounted while drawing, so it never blocks box interaction otherwise.
 * (Keyboard users create and edit zones with the numeric fields instead.)
 */
export function ZoneDrawLayer({
  imageWidth,
  imageHeight,
  onDraw,
}: {
  imageWidth: number
  imageHeight: number
  onDraw: (rect: { x0: number; y0: number; x1: number; y1: number }) => void
}) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [current, setCurrent] = useState<{ x: number; y: number } | null>(null)

  const toImage = (e: React.PointerEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return null
    const point = svg.createSVGPoint()
    point.x = e.clientX
    point.y = e.clientY
    const p = point.matrixTransform(matrix.inverse())
    return {
      x: Math.min(imageWidth, Math.max(0, p.x)),
      y: Math.min(imageHeight, Math.max(0, p.y)),
    }
  }

  const preview = start && current ? rectFromDrag(start, current, imageWidth, imageHeight) : null

  return (
    <g className="zone-draw">
      <rect
        x={0}
        y={0}
        width={imageWidth}
        height={imageHeight}
        fill="transparent"
        pointerEvents="all"
        style={{ cursor: 'crosshair', touchAction: 'none' }}
        onPointerDown={(e) => {
          const p = toImage(e)
          if (!p) return
          e.currentTarget.setPointerCapture?.(e.pointerId)
          setStart(p)
          setCurrent(p)
        }}
        onPointerMove={(e) => {
          if (!start) return
          const p = toImage(e)
          if (p) setCurrent(p)
        }}
        onPointerUp={(e) => {
          const p = toImage(e) ?? current
          if (start && p) {
            const rect = rectFromDrag(start, p, imageWidth, imageHeight)
            // Ignore a click without a meaningful drag.
            if (rect.x1 - rect.x0 > 0.01 && rect.y1 - rect.y0 > 0.01) onDraw(rect)
          }
          setStart(null)
          setCurrent(null)
        }}
      />
      {preview && (
        <rect
          x={preview.x0 * imageWidth}
          y={preview.y0 * imageHeight}
          width={(preview.x1 - preview.x0) * imageWidth}
          height={(preview.y1 - preview.y0) * imageHeight}
          fill="#38bdf8"
          fillOpacity={0.15}
          stroke="#38bdf8"
          strokeWidth={2}
          strokeDasharray="6 4"
          pointerEvents="none"
        />
      )}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface ZonePanelProps {
  zones: Zone[]
  onZonesChange: (zones: Zone[]) => void
  detections: readonly Detection[]
  imageWidth: number
  imageHeight: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  drawing: boolean
  onDrawingChange: (drawing: boolean) => void
  threshold: number
}

export function ZonePanel({
  zones,
  onZonesChange,
  detections,
  imageWidth,
  imageHeight,
  selectedId,
  onSelect,
  drawing,
  onDrawingChange,
  threshold,
}: ZonePanelProps) {
  const [editing, setEditing] = useState(false)
  const stats = useMemo(
    () => zoneStats(detections, zones, imageWidth, imageHeight),
    [detections, zones, imageWidth, imageHeight],
  )
  const total = detections.length

  const update = (id: string, patch: Partial<Zone>) =>
    onZonesChange(zones.map((z) => (z.id === id ? normalizeZone({ ...z, ...patch }) : z)))

  return (
    <div className="zones">
      <div className="zones__toolbar">
        <button
          type="button"
          className={`btn btn--sm ${editing ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => {
            setEditing((v) => !v)
            if (editing) onDrawingChange(false)
          }}
          aria-pressed={editing}
        >
          {editing ? 'Done editing' : 'Edit zones'}
        </button>
        {editing && (
          <>
            <button
              type="button"
              className={`btn btn--sm ${drawing ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => onDrawingChange(!drawing)}
              aria-pressed={drawing}
            >
              {drawing ? 'Drawing… drag on image' : 'Draw on image'}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={zones.length >= 12}
              onClick={() =>
                onZonesChange([
                  ...zones,
                  normalizeZone({
                    id: newZoneId(zones),
                    name: `Zone ${zones.length + 1}`,
                    x0: 0.25,
                    y0: 0.25,
                    x1: 0.75,
                    y1: 0.75,
                  }),
                ])
              }
            >
              Add zone
            </button>
          </>
        )}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={isDefaultLayout(zones)}
          onClick={() => {
            onZonesChange(DEFAULT_ZONES.map((z) => ({ ...z })))
            onSelect(null)
          }}
        >
          Reset zones
        </button>
      </div>

      <p className="fineprint">
        Each detection is counted in exactly one zone: the first zone in this list that contains
        the <strong>centre of its box</strong>. Counts use detections at or above{' '}
        {Math.round(threshold * 100)}%. Zones are saved in this browser.
      </p>

      {total === 0 && (
        <p className="note">No detections at this threshold, so every zone is empty.</p>
      )}

      <ul className="zones__list">
        {stats.map((stat, i) => {
          const zoneIndex = zones.findIndex((z) => z.id === stat.id)
          const zone = zoneIndex >= 0 ? zones[zoneIndex] : null
          const selected = selectedId === stat.id
          const share = total ? stat.summary.count / total : 0
          return (
            <li key={stat.id} className={`zone-row${selected ? ' is-selected' : ''}`}>
              <button
                type="button"
                className="zone-row__main"
                onClick={() => onSelect(selected ? null : stat.id)}
                aria-pressed={selected}
                disabled={stat.id === UNASSIGNED}
              >
                <span
                  className="zone-row__swatch"
                  style={{ background: stat.id === UNASSIGNED ? '#64748b' : zoneTint(zoneIndex) }}
                  aria-hidden="true"
                />
                <span className="zone-row__name">{stat.name}</span>
                <span className="zone-row__count">
                  {stat.summary.count}
                  <span className="zone-row__share"> · {formatPercent(share)}</span>
                </span>
              </button>
              <div className="zone-row__meta">
                <span>avg {formatPercent(stat.summary.meanConfidence)}</span>
                {stat.summary.lowConfidenceCount > 0 && (
                  <span className="text-warn">{stat.summary.lowConfidenceCount} low-confidence</span>
                )}
                <span className="zone-row__cats">
                  {stat.summary.categories.length
                    ? stat.summary.categories
                        .slice(0, 3)
                        .map((c) => `${c.label} ${c.count}`)
                        .join(', ')
                    : 'no detections'}
                </span>
              </div>
              {editing && zone && (
                <ZoneEditor
                  zone={zone}
                  index={i}
                  onChange={(patch) => update(zone.id, patch)}
                  onDelete={() => {
                    onZonesChange(zones.filter((z) => z.id !== zone.id))
                    if (selected) onSelect(null)
                  }}
                  canDelete={zones.length > 1}
                />
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ZoneEditor({
  zone,
  index,
  onChange,
  onDelete,
  canDelete,
}: {
  zone: Zone
  index: number
  onChange: (patch: Partial<Zone>) => void
  onDelete: () => void
  canDelete: boolean
}) {
  const base = useId()
  const field = (key: 'x0' | 'y0' | 'x1' | 'y1', label: string) => (
    <label className="zone-editor__field" htmlFor={`${base}-${key}`}>
      <span>{label}</span>
      <input
        id={`${base}-${key}`}
        type="number"
        min={0}
        max={100}
        step={1}
        value={Math.round(zone[key] * 100)}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange({ [key]: v / 100 })
        }}
        aria-label={`${zone.name} ${label} edge, percent of image`}
      />
      <span aria-hidden="true">%</span>
    </label>
  )

  return (
    <div className="zone-editor" role="group" aria-label={`Edit ${zone.name}`}>
      <label className="zone-editor__name">
        <span className="sr-only">Zone {index + 1} name</span>
        <input
          type="text"
          value={zone.name}
          maxLength={40}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </label>
      <div className="zone-editor__grid">
        {field('x0', 'Left')}
        {field('y0', 'Top')}
        {field('x1', 'Right')}
        {field('y1', 'Bottom')}
      </div>
      <button
        type="button"
        className="btn btn--danger btn--sm"
        onClick={onDelete}
        disabled={!canDelete}
      >
        Delete zone
      </button>
    </div>
  )
}

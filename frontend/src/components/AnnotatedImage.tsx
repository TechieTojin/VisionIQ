import { useCallback, useMemo, useRef, useState } from 'react'
import type { Detection } from '../types'
import { colorFor } from '../utils/colors'

interface AnnotatedImageProps {
  src: string
  imageWidth: number
  imageHeight: number
  detections: Detection[]
  colors: Record<string, string>
  showBoxes: boolean
  /** Pin every label open. Off by default — see the density note below. */
  showLabels: boolean
  selectedId: number | null
  onSelect: (id: number | null) => void
}

/**
 * The image with an SVG bounding-box overlay.
 *
 * SCALING
 * The SVG's viewBox is the ORIGINAL image size and it is stretched over the
 * rendered image, so backend pixel coordinates need no JS measurement and
 * survive any resize. `preserveAspectRatio="xMidYMid meet"` mirrors the
 * image's `object-fit: contain`, so the two letterbox identically.
 *
 * LABEL DENSITY
 * A dense shelf produces dozens of detections — 36 bottles in one real
 * image. Drawing a filled label chip on every box turns the photo into
 * unreadable confetti and hides the very thing being annotated. So labels
 * are revealed on demand: hover, keyboard focus, or click pins one open,
 * and a toggle shows them all for sparse images where that is useful.
 *
 * Boxes and labels render in two separate passes. Within one pass SVG paints
 * in document order, so a single pass would let a later box draw over an
 * earlier label. Labels therefore always sit above every box.
 *
 * KEYBOARD
 * The overlay is a listbox with a roving tabindex: it takes ONE tab stop,
 * not one per detection, then arrow keys move between boxes. Tabbing through
 * 36 stops to reach the next control would be its own accessibility problem.
 */
export function AnnotatedImage({
  src,
  imageWidth,
  imageHeight,
  detections,
  colors,
  showBoxes,
  showLabels,
  selectedId,
  onSelect,
}: AnnotatedImageProps) {
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const svgRef = useRef<SVGSVGElement>(null)

  // Scale type and strokes to the source resolution so a 4000px photo and a
  // 640px one look the same once letterboxed into the panel.
  const fontSize = useMemo(
    () => Math.max(11, Math.round(Math.max(imageWidth, imageHeight) / 55)),
    [imageWidth, imageHeight],
  )
  const strokeWidth = useMemo(
    () => Math.max(1.25, Math.max(imageWidth, imageHeight) / 520),
    [imageWidth, imageHeight],
  )

  /**
   * Paint largest first so small boxes end up on top and stay clickable.
   * A big box drawn last would swallow pointer events for everything nested
   * inside it — common on a shelf, where a crate contains its bottles.
   */
  const ordered = useMemo(
    () => [...detections].sort((a, b) => b.box.area - a.box.area),
    [detections],
  )

  // Clamp the roving index by derivation rather than in an effect: the
  // confidence filter can shrink the detection set at any time, and a stale
  // index would otherwise leave nothing focusable.
  const focusIndex = ordered.length
    ? Math.min(focusedIndex, ordered.length - 1)
    : 0

  const activeId = hoveredId ?? selectedId

  const focusBox = useCallback((index: number) => {
    setFocusedIndex(index)
    const node = svgRef.current?.querySelector<SVGGElement>(
      `[data-box-index="${index}"]`,
    )
    node?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, det: Detection, index: number) => {
      const last = ordered.length - 1
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault()
          focusBox(index >= last ? 0 : index + 1)
          break
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault()
          focusBox(index <= 0 ? last : index - 1)
          break
        case 'Home':
          event.preventDefault()
          focusBox(0)
          break
        case 'End':
          event.preventDefault()
          focusBox(last)
          break
        case 'Enter':
        case ' ':
          event.preventDefault()
          onSelect(selectedId === det.id ? null : det.id)
          break
        case 'Escape':
          if (selectedId !== null) {
            event.preventDefault()
            onSelect(null)
          }
          break
      }
    },
    [ordered.length, focusBox, onSelect, selectedId],
  )

  if (!showBoxes || imageWidth <= 0 || imageHeight <= 0) {
    return (
      <div className="annotated">
        <img src={src} alt="Analyzed shelf" className="annotated__img" />
      </div>
    )
  }

  /** A label chip, clamped to stay inside the frame. */
  const renderLabel = (det: Detection, emphasised: boolean) => {
    const color = colorFor(colors, det.label)
    const text = `${det.label} ${Math.round(det.confidence * 100)}%`
    const padding = fontSize * 0.42
    const width = text.length * fontSize * 0.56 + padding * 2
    const height = fontSize * 1.4

    // Prefer above the box; drop inside it when the box hugs the top edge.
    const above = det.box.y1 > height + 2
    const y = above ? det.box.y1 - height - 2 : det.box.y1 + 2
    // Never let the chip run off the right edge.
    const x = Math.max(0, Math.min(det.box.x1, imageWidth - width))

    return (
      <g key={`label-${det.id}`} className="box__label" pointerEvents="none">
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          fill={color}
          rx={2}
          opacity={emphasised ? 1 : 0.92}
        />
        <text
          x={x + padding}
          y={y + height * 0.73}
          fontSize={fontSize}
          fill="#0b0f1a"
          fontWeight="700"
        >
          {text}
        </text>
      </g>
    )
  }

  const activeDetection = ordered.find((d) => d.id === activeId) ?? null

  return (
    <div className="annotated">
      <img src={src} alt="Analyzed shelf" className="annotated__img" />

      <svg
        ref={svgRef}
        className="annotated__svg"
        viewBox={`0 0 ${imageWidth} ${imageHeight}`}
        preserveAspectRatio="xMidYMid meet"
        role="listbox"
        aria-label={`${detections.length} detected objects`}
        onMouseLeave={() => setHoveredId(null)}
      >
        {/* Pass 1 — boxes only. */}
        {ordered.map((det, index) => {
          const color = colorFor(colors, det.label)
          const isSelected = selectedId === det.id
          const isActive = activeId === det.id
          const dimmed = selectedId !== null && !isSelected

          return (
            <g
              key={det.id}
              data-box-index={index}
              className={`box${dimmed ? ' box--dim' : ''}${
                isActive ? ' box--active' : ''
              }`}
              role="option"
              aria-selected={isSelected}
              aria-label={`${det.label}, ${Math.round(
                det.confidence * 100,
              )}% confidence`}
              // Roving tabindex: one tab stop for the whole overlay.
              tabIndex={index === focusIndex ? 0 : -1}
              onFocus={() => {
                setFocusedIndex(index)
                setHoveredId(det.id)
              }}
              onBlur={() => setHoveredId(null)}
              onMouseEnter={() => setHoveredId(det.id)}
              onClick={(e) => {
                e.stopPropagation()
                onSelect(isSelected ? null : det.id)
              }}
              onKeyDown={(e) => handleKeyDown(e, det, index)}
            >
              <rect
                x={det.box.x1}
                y={det.box.y1}
                width={det.box.width}
                height={det.box.height}
                fill={color}
                // A faint wash on the active box only; a transparent fill
                // still gives the whole box area as a hit target.
                fillOpacity={isSelected ? 0.2 : isActive ? 0.1 : 0}
                stroke={color}
                strokeWidth={isActive || isSelected ? strokeWidth * 2 : strokeWidth}
                rx={2}
                pointerEvents="all"
              />
            </g>
          )
        })}

        {/* Pass 2 — labels, always above every box. */}
        {showLabels &&
          ordered
            .filter((det) => det.id !== activeId)
            .map((det) => renderLabel(det, false))}

        {/* The active label renders last so it is never occluded. */}
        {activeDetection && renderLabel(activeDetection, true)}
      </svg>
    </div>
  )
}

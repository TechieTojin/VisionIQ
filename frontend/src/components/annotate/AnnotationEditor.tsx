import { useRef, useState } from 'react'
import {
  boxKind,
  isValidRect,
  moveBox,
  nextHumanId,
  rectFromPoints,
  resizeBox,
  type EditorBox,
  type Handle,
} from '../../lib/annotation'

export type EditorMode = 'select' | 'draw'

type Drag =
  | { kind: 'move'; id: string; start: { x: number; y: number }; origin: EditorBox; base: EditorBox[] }
  | { kind: 'resize'; id: string; handle: Handle; origin: EditorBox; base: EditorBox[] }
  | { kind: 'draw'; start: { x: number; y: number }; current: { x: number; y: number }; base: EditorBox[] }

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

function handlePoint(b: EditorBox, h: Handle) {
  const x = h.includes('w') ? b.x1 : h.includes('e') ? b.x2 : (b.x1 + b.x2) / 2
  const y = h.includes('n') ? b.y1 : h.includes('s') ? b.y2 : (b.y1 + b.y2) / 2
  return { x, y }
}

/**
 * Bounding-box editor. Coordinates are original-image pixels: the SVG's
 * viewBox is the image size, so boxes stay aligned at every display size.
 *
 * Mouse/touch: drag a box to move it, drag a handle to resize, drag on the
 * image in Draw mode to add a box.
 * Keyboard (when the canvas has focus): arrows move the selected box (Shift
 * = 10 px), Alt+arrows resize it, Delete removes it, [ and ] cycle the
 * selection, N toggles Draw mode, Escape clears the selection.
 */
export function AnnotationEditor({
  imageUrl,
  width,
  height,
  boxes,
  selectedId,
  mode,
  newLabel,
  onSelect,
  onChange,
  onModeChange,
}: {
  imageUrl: string | null
  width: number
  height: number
  boxes: EditorBox[]
  selectedId: string | null
  mode: EditorMode
  newLabel: string
  onSelect: (id: string | null) => void
  /** `commit=false` for live drag previews, `true` once an edit is finished. */
  onChange: (boxes: EditorBox[], commit: boolean) => void
  onModeChange: (mode: EditorMode) => void
}) {
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)
  const [preview, setPreview] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const unit = Math.max(width, height) / 100
  const stroke = Math.max(1.5, unit * 0.28)
  const handleSize = Math.max(5, unit * 1.1)

  const toImage = (e: React.PointerEvent): { x: number; y: number } => {
    const el = svg.current
    const ctm = el?.getScreenCTM?.()
    if (!el || !ctm) return { x: 0, y: 0 }
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    return { x: pt.x, y: pt.y }
  }

  const begin = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation()
    e.preventDefault()
    drag.current = d
    svg.current?.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = toImage(e)
    if (d.kind === 'draw') {
      d.current = p
      setPreview(rectFromPoints(d.start, p, width, height))
      return
    }
    const next = d.base.map((b) => {
      if (b.id !== d.id) return b
      return d.kind === 'move'
        ? moveBox(d.origin, p.x - d.start.x, p.y - d.start.y, width, height)
        : resizeBox(d.origin, d.handle, p.x, p.y, width, height)
    })
    onChange(next, false)
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'draw') {
      const rect = rectFromPoints(d.start, d.current, width, height)
      setPreview(null)
      if (isValidRect(rect) && rect.x2 - rect.x1 >= 4 && rect.y2 - rect.y1 >= 4) {
        const id = nextHumanId(d.base)
        onChange(
          [...d.base, { id, label: newLabel, ...rect, source: 'human', origin_detection_id: null, model_label: null, model_confidence: null, original: null }],
          true,
        )
        onSelect(id)
      }
      return
    }
    onChange(boxes, true)
  }

  const selected = boxes.find((b) => b.id === selectedId) ?? null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'n' || e.key === 'N') {
      onModeChange(mode === 'draw' ? 'select' : 'draw')
      e.preventDefault()
      return
    }
    if (e.key === 'Escape') {
      onSelect(null)
      return
    }
    if (e.key === '[' || e.key === ']') {
      if (!boxes.length) return
      const i = boxes.findIndex((b) => b.id === selectedId)
      const next = e.key === ']' ? (i + 1) % boxes.length : (i - 1 + boxes.length) % boxes.length
      onSelect(boxes[i === -1 ? 0 : next].id)
      e.preventDefault()
      return
    }
    if (!selected) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      onChange(boxes.filter((b) => b.id !== selected.id), true)
      onSelect(null)
      e.preventDefault()
      return
    }
    const step = e.shiftKey ? 10 : 1
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const d = delta[e.key]
    if (!d) return
    e.preventDefault()
    const next = boxes.map((b) => {
      if (b.id !== selected.id) return b
      if (e.altKey) return resizeBox(b, 'se', b.x2 + d[0], b.y2 + d[1], width, height)
      return moveBox(b, d[0], d[1], width, height)
    })
    onChange(next, true)
  }

  return (
    <div className="annot-editor">
      <svg
        ref={svg}
        className={`annot-editor__svg annot-editor__svg--${mode}`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="application"
        aria-label={`Annotation canvas, ${boxes.length} boxes. ${mode === 'draw' ? 'Draw mode: drag to add a box.' : 'Select mode.'} Arrow keys move the selected box, Alt+arrows resize, Delete removes, [ and ] change selection, N toggles draw mode.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          if (mode === 'draw') {
            const p = toImage(e)
            begin(e, { kind: 'draw', start: p, current: p, base: boxes })
          } else {
            onSelect(null)
          }
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {imageUrl ? (
          <image href={imageUrl} x={0} y={0} width={width} height={height} preserveAspectRatio="none" />
        ) : (
          <rect x={0} y={0} width={width} height={height} className="annot-editor__blank" />
        )}
        {boxes.map((b) => {
          const kind = boxKind(b)
          const isSel = b.id === selectedId
          return (
            <g key={b.id} className={`annot-box annot-box--${kind}${isSel ? ' is-selected' : ''}`}>
              <rect
                x={b.x1}
                y={b.y1}
                width={b.x2 - b.x1}
                height={b.y2 - b.y1}
                strokeWidth={isSel ? stroke * 1.8 : stroke}
                vectorEffect="non-scaling-stroke"
                onPointerDown={(e) => {
                  if (mode === 'draw') return
                  onSelect(b.id)
                  begin(e, { kind: 'move', id: b.id, start: toImage(e), origin: b, base: boxes })
                }}
              >
                <title>
                  {b.label} · {kind === 'human' ? 'human-added' : kind === 'edited' ? 'model prediction, edited' : `model prediction ${b.model_confidence !== null ? `${Math.round(b.model_confidence * 100)}%` : ''}`}
                </title>
              </rect>
              {isSel && (
                <text x={b.x1 + stroke * 2} y={Math.max(unit * 2.4, b.y1 - unit * 0.6)} fontSize={unit * 2.2} className="annot-box__label">
                  {b.label}
                </text>
              )}
            </g>
          )
        })}
        {selected &&
          mode === 'select' &&
          HANDLES.map((h) => {
            const p = handlePoint(selected, h)
            return (
              <rect
                key={h}
                className={`annot-handle annot-handle--${h}`}
                x={p.x - handleSize / 2}
                y={p.y - handleSize / 2}
                width={handleSize}
                height={handleSize}
                onPointerDown={(e) => begin(e, { kind: 'resize', id: selected.id, handle: h, origin: selected, base: boxes })}
              />
            )
          })}
        {preview && (
          <rect className="annot-preview" x={preview.x1} y={preview.y1} width={preview.x2 - preview.x1} height={preview.y2 - preview.y1} strokeWidth={stroke} />
        )}
      </svg>
    </div>
  )
}

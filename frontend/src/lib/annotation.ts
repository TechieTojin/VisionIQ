/**
 * Annotation geometry and edit history (pure functions).
 *
 * Boxes are xyxy in ORIGINAL image pixels, exactly like detections, so the
 * editor's SVG uses the image size as its viewBox and needs no scaling code.
 * Every edit is clamped to the image and to a 2px minimum size — the same
 * rule the backend enforces on save (MIN_BOX_PX).
 */

import type { AnnotationBox, BoxInput } from '../api/workbench'

export const MIN_BOX_PX = 2
export const HISTORY_LIMIT = 100

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface EditorBox {
  id: string
  label: string
  x1: number
  y1: number
  x2: number
  y2: number
  source: 'model' | 'human'
  origin_detection_id: number | null
  model_label: string | null
  model_confidence: number | null
  /** Original geometry of a model box, for the "edited" indicator. */
  original?: { x1: number; y1: number; x2: number; y2: number; label: string } | null
}

const round = (v: number) => Math.round(v * 100) / 100
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function fromDoc(boxes: AnnotationBox[], predictions?: Map<number, { x1: number; y1: number; x2: number; y2: number; label: string }>): EditorBox[] {
  return boxes.map((b) => ({
    id: b.id,
    label: b.label,
    x1: b.x1,
    y1: b.y1,
    x2: b.x2,
    y2: b.y2,
    source: b.source,
    origin_detection_id: b.origin_detection_id,
    model_label: b.model_label,
    model_confidence: b.model_confidence,
    original: b.origin_detection_id !== null ? predictions?.get(b.origin_detection_id) ?? null : null,
  }))
}

export function toInput(boxes: EditorBox[]): BoxInput[] {
  return boxes.map((b) => ({
    id: b.id,
    label: b.label,
    x1: round(b.x1),
    y1: round(b.y1),
    x2: round(b.x2),
    y2: round(b.y2),
    source: b.source,
    origin_detection_id: b.source === 'model' ? b.origin_detection_id : null,
  }))
}

export function isEdited(b: EditorBox): boolean {
  if (b.source !== 'model' || !b.original) return false
  const o = b.original
  return (
    Math.abs(b.x1 - o.x1) > 0.5 ||
    Math.abs(b.y1 - o.y1) > 0.5 ||
    Math.abs(b.x2 - o.x2) > 0.5 ||
    Math.abs(b.y2 - o.y2) > 0.5 ||
    b.label !== o.label
  )
}

/** How a box is drawn: human-added, edited prediction, or untouched prediction. */
export function boxKind(b: EditorBox): 'human' | 'edited' | 'model' {
  return b.source === 'human' ? 'human' : isEdited(b) ? 'edited' : 'model'
}

/** A rectangle from two drag points, clamped to the image. */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }, w: number, h: number) {
  return {
    x1: round(clamp(Math.min(a.x, b.x), 0, w)),
    y1: round(clamp(Math.min(a.y, b.y), 0, h)),
    x2: round(clamp(Math.max(a.x, b.x), 0, w)),
    y2: round(clamp(Math.max(a.y, b.y), 0, h)),
  }
}

export function isValidRect(r: { x1: number; y1: number; x2: number; y2: number }): boolean {
  return r.x2 - r.x1 >= MIN_BOX_PX && r.y2 - r.y1 >= MIN_BOX_PX
}

/** Translate a box, keeping its size, so it stays fully inside the image. */
export function moveBox<T extends EditorBox>(b: T, dx: number, dy: number, w: number, h: number): T {
  const bw = b.x2 - b.x1
  const bh = b.y2 - b.y1
  const x1 = clamp(b.x1 + dx, 0, w - bw)
  const y1 = clamp(b.y1 + dy, 0, h - bh)
  return { ...b, x1: round(x1), y1: round(y1), x2: round(x1 + bw), y2: round(y1 + bh) }
}

/** Drag one edge/corner to (x, y). Edges never cross and never leave the image. */
export function resizeBox<T extends EditorBox>(b: T, handle: Handle, x: number, y: number, w: number, h: number): T {
  let { x1, y1, x2, y2 } = b
  if (handle.includes('w')) x1 = clamp(x, 0, x2 - MIN_BOX_PX)
  if (handle.includes('e')) x2 = clamp(x, x1 + MIN_BOX_PX, w)
  if (handle.includes('n')) y1 = clamp(y, 0, y2 - MIN_BOX_PX)
  if (handle.includes('s')) y2 = clamp(y, y1 + MIN_BOX_PX, h)
  return { ...b, x1: round(x1), y1: round(y1), x2: round(x2), y2: round(y2) }
}

export interface BoxProblem {
  id: string
  message: string
}

export function validate(boxes: EditorBox[], w: number, h: number): BoxProblem[] {
  const out: BoxProblem[] = []
  const ids = new Set<string>()
  for (const b of boxes) {
    if (ids.has(b.id)) out.push({ id: b.id, message: 'Duplicate box id.' })
    ids.add(b.id)
    if (![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite)) out.push({ id: b.id, message: 'Coordinates must be numbers.' })
    else if (b.x1 < 0 || b.y1 < 0 || b.x2 > w || b.y2 > h) out.push({ id: b.id, message: `Outside the ${w}×${h} image.` })
    else if (!isValidRect(b)) out.push({ id: b.id, message: `Must be at least ${MIN_BOX_PX}px wide and tall, with x1 < x2 and y1 < y2.` })
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(b.label)) out.push({ id: b.id, message: 'Invalid label.' })
  }
  return out
}

export function nextHumanId(boxes: EditorBox[]): string {
  let n = boxes.length + 1
  const ids = new Set(boxes.map((b) => b.id))
  while (ids.has(`h${n}`)) n++
  return `h${n}`
}

// -- undo / redo ------------------------------------------------------------------

export interface History {
  past: EditorBox[][]
  present: EditorBox[]
  future: EditorBox[][]
}

export function initHistory(boxes: EditorBox[]): History {
  return { past: [], present: boxes, future: [] }
}

export function commit(h: History, next: EditorBox[]): History {
  if (next === h.present) return h
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] }
}

export function undo(h: History): History {
  if (!h.past.length) return h
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] }
}

export function redo(h: History): History {
  if (!h.future.length) return h
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }
}

// -- export -----------------------------------------------------------------------

export function yoloLabelFile(boxes: EditorBox[], classes: string[], w: number, h: number): string {
  const lines = boxes
    .filter((b) => classes.includes(b.label))
    .map((b) => {
      const cx = (b.x1 + b.x2) / 2 / w
      const cy = (b.y1 + b.y2) / 2 / h
      return `${classes.indexOf(b.label)} ${cx.toFixed(6)} ${cy.toFixed(6)} ${((b.x2 - b.x1) / w).toFixed(6)} ${((b.y2 - b.y1) / h).toFixed(6)}`
    })
  return lines.length ? `${lines.join('\n')}\n` : ''
}

export function sameBoxes(a: EditorBox[], b: EditorBox[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => {
    const y = b[i]
    return x.id === y.id && x.label === y.label && x.x1 === y.x1 && x.y1 === y.y1 && x.x2 === y.x2 && x.y2 === y.y2
  })
}

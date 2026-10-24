import { describe, expect, it } from 'vitest'
import {
  commit,
  HISTORY_LIMIT,
  initHistory,
  isEdited,
  moveBox,
  nextHumanId,
  rectFromPoints,
  redo,
  resizeBox,
  toInput,
  undo,
  validate,
  yoloLabelFile,
  type EditorBox,
} from './annotation'

const box = (over: Partial<EditorBox> = {}): EditorBox => ({
  id: 'b1', label: 'bottle', x1: 10, y1: 10, x2: 50, y2: 60, source: 'human',
  origin_detection_id: null, model_label: null, model_confidence: null, ...over,
})

describe('geometry', () => {
  it('builds a normalised rectangle from any drag direction, clamped to the image', () => {
    expect(rectFromPoints({ x: 90, y: 80 }, { x: 10, y: 20 }, 100, 100)).toEqual({ x1: 10, y1: 20, x2: 90, y2: 80 })
    expect(rectFromPoints({ x: -20, y: 50 }, { x: 150, y: 120 }, 100, 100)).toEqual({ x1: 0, y1: 50, x2: 100, y2: 100 })
  })

  it('moves a box without resizing it or leaving the image', () => {
    const b = moveBox(box(), 500, -500, 100, 100)
    expect(b).toMatchObject({ x1: 60, y1: 0, x2: 100, y2: 50 })
  })

  it('resizes from any handle without inverting or going below the minimum', () => {
    expect(resizeBox(box(), 'se', 80, 90, 100, 100)).toMatchObject({ x2: 80, y2: 90 })
    expect(resizeBox(box(), 'w', 200, 0, 100, 100)).toMatchObject({ x1: 48, x2: 50 })
    expect(resizeBox(box(), 'n', 0, -40, 100, 100)).toMatchObject({ y1: 0 })
    expect(resizeBox(box(), 'e', 999, 0, 100, 100)).toMatchObject({ x2: 100 })
  })

  it('validates bounds, size, labels and duplicates', () => {
    const problems = validate(
      [box(), box({ id: 'b1' }), box({ id: 'z', x2: 11 }), box({ id: 'o', x2: 140 }), box({ id: 'l', label: '../x' })],
      100,
      100,
    )
    expect(problems.map((p) => p.id)).toEqual(['b1', 'z', 'o', 'l'])
  })

  it('tracks whether a model box was edited', () => {
    const m = box({ source: 'model', origin_detection_id: 3, original: { x1: 10, y1: 10, x2: 50, y2: 60, label: 'bottle' } })
    expect(isEdited(m)).toBe(false)
    expect(isEdited({ ...m, label: 'cup' })).toBe(true)
    expect(isEdited(moveBox(m, 5, 0, 100, 100))).toBe(true)
  })

  it('serialises for the API with rounded coordinates and no forged origins', () => {
    const [h] = toInput([box({ x1: 10.123456, origin_detection_id: 4 })])
    expect(h.x1).toBe(10.12)
    expect(h.origin_detection_id).toBeNull() // human boxes never claim a prediction
  })

  it('picks a fresh human id', () => {
    expect(nextHumanId([box({ id: 'h2' }), box({ id: 'h3' })])).toBe('h4')
  })
})

describe('history', () => {
  it('undoes and redoes, and a new edit clears the redo stack', () => {
    let h = initHistory([box()])
    h = commit(h, [box({ x1: 20 })])
    h = commit(h, [box({ x1: 30 })])
    h = undo(h)
    expect(h.present[0].x1).toBe(20)
    h = redo(h)
    expect(h.present[0].x1).toBe(30)
    h = undo(undo(h))
    expect(h.present[0].x1).toBe(10)
    expect(undo(h)).toBe(h) // nothing further to undo
    h = commit(h, [])
    expect(h.future).toEqual([])
  })

  it('caps the undo stack', () => {
    let h = initHistory([])
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = commit(h, [box({ x1: i })])
    expect(h.past.length).toBe(HISTORY_LIMIT)
  })
})

describe('YOLO export', () => {
  it('normalises to class cx cy w h and skips labels without a class', () => {
    const text = yoloLabelFile([box(), box({ id: 'c', label: 'cup' }), box({ id: 'x', label: 'other' })], ['bottle', 'cup'], 100, 200)
    expect(text.split('\n').filter(Boolean)).toEqual([
      '0 0.300000 0.175000 0.400000 0.250000',
      '1 0.300000 0.175000 0.400000 0.250000',
    ])
  })
})

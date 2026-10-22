import { describe, expect, it } from 'vitest'
import { buildColorMap, colorFor, FALLBACK_COLOR } from './colors'

describe('buildColorMap', () => {
  it('gives every label in one analysis a distinct colour', () => {
    // These COCO classes co-occur constantly in shelf photos; a hashed
    // palette collided on bottle/cup, which this scheme rules out.
    const labels = ['bottle', 'cup', 'person', 'bowl', 'banana', 'apple']
    const map = buildColorMap(labels)
    const used = Object.values(map)
    expect(new Set(used).size).toBe(labels.length)
  })

  it('is deterministic for the same ordering', () => {
    const a = buildColorMap(['bottle', 'cup'])
    const b = buildColorMap(['bottle', 'cup'])
    expect(a).toEqual(b)
  })

  it('assigns by rank, so the most frequent label leads', () => {
    const map = buildColorMap(['bottle', 'cup'])
    const flipped = buildColorMap(['cup', 'bottle'])
    expect(map.bottle).toBe(flipped.cup)
  })

  it('ignores duplicate labels', () => {
    const map = buildColorMap(['bottle', 'bottle', 'cup'])
    expect(Object.keys(map)).toEqual(['bottle', 'cup'])
    expect(map.bottle).not.toBe(map.cup)
  })

  it('returns valid hex colours', () => {
    for (const color of Object.values(buildColorMap(['a', 'b', 'c']))) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('handles an empty label list', () => {
    expect(buildColorMap([])).toEqual({})
  })

  it('wraps around rather than running out of colours', () => {
    const many = Array.from({ length: 30 }, (_, i) => `label${i}`)
    const map = buildColorMap(many)
    expect(Object.keys(map)).toHaveLength(30)
  })
})

describe('colorFor', () => {
  it('returns the mapped colour', () => {
    const map = buildColorMap(['bottle'])
    expect(colorFor(map, 'bottle')).toBe(map.bottle)
  })

  it('falls back for an unknown label instead of throwing', () => {
    expect(colorFor({}, 'unseen')).toBe(FALLBACK_COLOR)
  })
})

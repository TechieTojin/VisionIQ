import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ZONES,
  isDefaultLayout,
  loadZones,
  normalizeZone,
  saveZones,
  UNASSIGNED,
  zoneContains,
  zoneFor,
  zoneStats,
  type Zone,
} from './zones'
import { makeDetection } from '../test/fixtures'

const W = 300
const H = 300

/** A box whose centre sits at (cx, cy) in original pixels. */
const at = (id: number, cx: number, cy: number, conf = 0.9, label = 'bottle') =>
  makeDetection(id, label, conf, [cx - 5, cy - 5, cx + 5, cy + 5])

describe('zone membership', () => {
  it('uses the bounding-box centre point', () => {
    // Box spans two default zones; its centre is in the top one.
    const straddling = makeDetection(0, 'bottle', 0.9, [10, 40, 30, 150]) // centre y = 95
    expect(zoneFor(straddling, DEFAULT_ZONES, W, H)).toBe('top')
  })

  it('splits the default layout into thirds', () => {
    expect(zoneFor(at(0, 50, 50), DEFAULT_ZONES, W, H)).toBe('top')
    expect(zoneFor(at(0, 50, 150), DEFAULT_ZONES, W, H)).toBe('middle')
    expect(zoneFor(at(0, 50, 250), DEFAULT_ZONES, W, H)).toBe('bottom')
  })

  it('gives a point on a shared border to exactly one zone', () => {
    const border = at(0, 50, 100) // y = 1/3 exactly
    const owners = DEFAULT_ZONES.filter((z) => zoneContains(z, 50, 100, W, H))
    expect(owners).toHaveLength(1)
    expect(zoneFor(border, DEFAULT_ZONES, W, H)).toBe('middle')
  })

  it('counts a box touching the bottom-right image edge', () => {
    expect(zoneContains(DEFAULT_ZONES[2], 300, 300, W, H)).toBe(true)
  })

  it('reports a centre outside every zone as unassigned', () => {
    const zones: Zone[] = [{ id: 'left', name: 'Left', x0: 0, y0: 0, x1: 0.5, y1: 1 }]
    expect(zoneFor(at(0, 250, 50), zones, W, H)).toBe(UNASSIGNED)
  })
})

describe('zoneStats', () => {
  const dets = [at(0, 50, 50), at(1, 60, 60, 0.4), at(2, 50, 150), at(3, 50, 250, 0.7, 'cup')]

  it('counts every detection exactly once', () => {
    const stats = zoneStats(dets, DEFAULT_ZONES, W, H)
    const total = stats.reduce((s, z) => s + z.summary.count, 0)
    expect(total).toBe(dets.length)
  })

  it('never double-counts across overlapping custom zones', () => {
    const overlapping: Zone[] = [
      { id: 'a', name: 'A', x0: 0, y0: 0, x1: 1, y1: 1 },
      { id: 'b', name: 'B', x0: 0, y0: 0, x1: 1, y1: 1 },
    ]
    const stats = zoneStats(dets, overlapping, W, H)
    expect(stats.find((z) => z.id === 'a')!.summary.count).toBe(4)
    expect(stats.find((z) => z.id === 'b')!.summary.count).toBe(0) // first match wins
  })

  it('reports per-zone confidence and categories', () => {
    const top = zoneStats(dets, DEFAULT_ZONES, W, H).find((z) => z.id === 'top')!
    expect(top.summary.count).toBe(2)
    expect(top.summary.lowConfidenceCount).toBe(1)
    expect(top.summary.meanConfidence).toBeCloseTo(0.65)
    const bottom = zoneStats(dets, DEFAULT_ZONES, W, H).find((z) => z.id === 'bottom')!
    expect(bottom.summary.categories[0].label).toBe('cup')
  })

  it('adds an Unassigned bucket only when needed', () => {
    expect(zoneStats(dets, DEFAULT_ZONES, W, H).some((z) => z.id === UNASSIGNED)).toBe(false)
    const half: Zone[] = [{ id: 'l', name: 'L', x0: 0, y0: 0, x1: 0.1, y1: 1 }]
    expect(zoneStats(dets, half, W, H).some((z) => z.id === UNASSIGNED)).toBe(true)
  })

  it('handles zero detections', () => {
    const stats = zoneStats([], DEFAULT_ZONES, W, H)
    expect(stats).toHaveLength(3)
    expect(stats.every((z) => z.summary.count === 0 && z.summary.meanConfidence === null)).toBe(true)
  })

  it('works in original-pixel space regardless of image size', () => {
    const big = [makeDetection(0, 'a', 0.9, [0, 3000, 100, 3100])] // centre y = 3050 of 4000
    expect(zoneFor(big[0], DEFAULT_ZONES, 4000, 4000)).toBe('bottom')
  })
})

describe('normalizeZone', () => {
  it('orders inverted edges', () => {
    const z = normalizeZone({ id: 'z', name: 'Z', x0: 0.8, y0: 0.9, x1: 0.2, y1: 0.1 })
    expect([z.x0, z.y0, z.x1, z.y1]).toEqual([0.2, 0.1, 0.8, 0.9])
  })

  it('clamps to the image', () => {
    const z = normalizeZone({ id: 'z', name: 'Z', x0: -1, y0: -1, x1: 2, y1: 2 })
    expect([z.x0, z.y0, z.x1, z.y1]).toEqual([0, 0, 1, 1])
  })

  it('enforces a minimum size', () => {
    const z = normalizeZone({ id: 'z', name: 'Z', x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5 })
    expect(z.x1 - z.x0).toBeGreaterThan(0)
    expect(z.y1 - z.y0).toBeGreaterThan(0)
  })

  it('gives an unnamed zone a name and caps length', () => {
    expect(normalizeZone({ id: 'z', name: '   ', x0: 0, y0: 0, x1: 1, y1: 1 }).name).toBe('Zone')
    expect(normalizeZone({ id: 'z', name: 'x'.repeat(99), x0: 0, y0: 0, x1: 1, y1: 1 }).name).toHaveLength(40)
  })
})

describe('zone persistence', () => {
  function memoryStorage() {
    const data = new Map<string, string>()
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
  }

  it('round-trips a custom layout', () => {
    const storage = memoryStorage()
    const zones: Zone[] = [{ id: 'z1', name: 'Eye level', x0: 0, y0: 0.3, x1: 1, y1: 0.6 }]
    saveZones(zones, storage)
    expect(loadZones(storage)).toEqual(zones)
  })

  it('falls back to defaults on missing or corrupt data', () => {
    expect(isDefaultLayout(loadZones(memoryStorage()))).toBe(true)
    const storage = memoryStorage()
    storage.setItem('visioniq.zones.v1', '{not json')
    expect(isDefaultLayout(loadZones(storage))).toBe(true)
  })

  it('drops malformed entries', () => {
    const storage = memoryStorage()
    storage.setItem('visioniq.zones.v1', JSON.stringify([{ id: 1 }, { foo: 'bar' }]))
    expect(isDefaultLayout(loadZones(storage))).toBe(true)
  })

  it('survives storage that throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => saveZones(DEFAULT_ZONES, throwing)).not.toThrow()
    expect(isDefaultLayout(loadZones(throwing))).toBe(true)
  })

  it('recognises the default layout', () => {
    expect(isDefaultLayout(DEFAULT_ZONES)).toBe(true)
    expect(isDefaultLayout([DEFAULT_ZONES[0]])).toBe(false)
  })
})

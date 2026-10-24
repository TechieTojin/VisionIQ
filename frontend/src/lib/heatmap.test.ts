import { describe, expect, it } from 'vitest'
import { densityGrid, heatColor, legendGradient, renderHeatmap } from './heatmap'
import { makeDetection } from '../test/fixtures'

describe('densityGrid', () => {
  it('peaks at the detection centre', () => {
    const grid = densityGrid([makeDetection(0, 'a', 0.9, [40, 40, 60, 60])], 100, 100, 20)
    let best = 0
    for (let i = 1; i < grid.values.length; i++) if (grid.values[i] > grid.values[best]) best = i
    const x = best % grid.cols
    const y = Math.floor(best / grid.cols)
    // Centre (50, 50) of 100px is cell 10 of 20.
    expect(Math.abs(x - 9.5)).toBeLessThanOrEqual(1)
    expect(Math.abs(y - 9.5)).toBeLessThanOrEqual(1)
  })

  it('normalises so the densest cell is exactly 1', () => {
    const grid = densityGrid(
      [makeDetection(0, 'a', 0.9, [10, 10, 20, 20]), makeDetection(1, 'a', 0.9, [70, 70, 90, 90])],
      100,
      100,
      30,
    )
    expect(Math.max(...grid.values)).toBeCloseTo(1)
  })

  it('is denser where detections cluster', () => {
    const cluster = [0, 1, 2].map((i) => makeDetection(i, 'a', 0.9, [10, 10, 20, 20]))
    const lone = makeDetection(9, 'a', 0.9, [80, 80, 90, 90])
    const grid = densityGrid([...cluster, lone], 100, 100, 20)
    const cell = (px: number, py: number) =>
      grid.values[Math.floor((py / 100) * grid.rows) * grid.cols + Math.floor((px / 100) * grid.cols)]
    expect(cell(15, 15)).toBeGreaterThan(cell(85, 85))
  })

  it('is deterministic', () => {
    const dets = [makeDetection(0, 'a', 0.9, [5, 5, 50, 60])]
    expect(Array.from(densityGrid(dets, 120, 80).values)).toEqual(
      Array.from(densityGrid(dets, 120, 80).values),
    )
  })

  it('preserves the image aspect ratio', () => {
    const grid = densityGrid([], 400, 100, 40)
    expect(grid.cols).toBe(40)
    expect(grid.rows).toBe(10)
    const tall = densityGrid([], 100, 400, 40)
    expect(tall.rows).toBe(40)
    expect(tall.cols).toBe(10)
  })

  it('reports no peak for zero detections', () => {
    // Callers rely on this to render nothing rather than a tinted image.
    const grid = densityGrid([], 100, 100)
    expect(grid.peak).toBe(0)
    expect(grid.values.every((v) => v === 0)).toBe(true)
  })

  it('handles an unknown image size', () => {
    expect(densityGrid([makeDetection(0, 'a', 0.9)], 0, 0).cols).toBe(0)
  })

  it('stays bounded for a dense shelf', () => {
    const dense = Array.from({ length: 300 }, (_, i) =>
      makeDetection(i, 'bottle', 0.9, [(i % 30) * 10, Math.floor(i / 30) * 30, (i % 30) * 10 + 9, Math.floor(i / 30) * 30 + 28]),
    )
    const start = performance.now()
    const grid = densityGrid(dense, 300, 300)
    expect(performance.now() - start).toBeLessThan(500)
    expect(grid.values.length).toBe(96 * 96)
  })
})

describe('heat colours', () => {
  it('is fully transparent at zero density', () => {
    expect(heatColor(0)[3]).toBe(0)
    expect(heatColor(0.01)[3]).toBe(0)
  })

  it('never fully hides the photograph', () => {
    expect(heatColor(1)[3]).toBeLessThan(255)
  })

  it('gets more opaque with density', () => {
    expect(heatColor(0.9)[3]).toBeGreaterThan(heatColor(0.2)[3])
  })

  it('produces a CSS legend gradient', () => {
    expect(legendGradient()).toMatch(/^linear-gradient\(90deg, rgb/)
  })
})

describe('renderHeatmap', () => {
  it('renders nothing for an empty grid', () => {
    expect(renderHeatmap(densityGrid([], 100, 100))).toBeNull()
  })

  it('renders nothing when canvas is unavailable rather than throwing', () => {
    // jsdom has no canvas implementation: getContext returns null.
    const grid = densityGrid([makeDetection(0, 'a', 0.9)], 100, 100)
    expect(() => renderHeatmap(grid)).not.toThrow()
  })
})

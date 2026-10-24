/**
 * Detected-object concentration heatmap.
 *
 * WHAT IT IS: a kernel-density estimate of where the model placed boxes.
 * Each detection contributes one 2-D Gaussian centred on its box, with a
 * spread proportional to the box's own size. The surface is normalised so
 * the densest cell is 1.
 *
 * WHAT IT IS NOT: customer attention, dwell time, sales activity or stock
 * level. It shows where objects were DETECTED in one photo, nothing more.
 *
 * The computation is deterministic (same input, same output), runs on a
 * coarse grid in original-image coordinates, and is only recomputed when the
 * detection set changes — opacity changes are a CSS/SVG attribute, not a
 * recompute.
 */

import type { Detection } from '../types'

export interface DensityGrid {
  cols: number
  rows: number
  /** Row-major, normalised 0..1. */
  values: Float32Array
  /** Raw maximum before normalisation; 0 means nothing to draw. */
  peak: number
}

/** Grid resolution along the longer image axis. Coarse on purpose: cheap. */
export const DEFAULT_RESOLUTION = 96

export function densityGrid(
  detections: readonly Detection[],
  imageWidth: number,
  imageHeight: number,
  resolution = DEFAULT_RESOLUTION,
): DensityGrid {
  if (imageWidth <= 0 || imageHeight <= 0) {
    return { cols: 0, rows: 0, values: new Float32Array(0), peak: 0 }
  }
  const landscape = imageWidth >= imageHeight
  const cols = landscape ? resolution : Math.max(8, Math.round((resolution * imageWidth) / imageHeight))
  const rows = landscape ? Math.max(8, Math.round((resolution * imageHeight) / imageWidth)) : resolution
  const values = new Float32Array(cols * rows)

  if (detections.length === 0) return { cols, rows, values, peak: 0 }

  const sx = cols / imageWidth
  const sy = rows / imageHeight

  for (const d of detections) {
    // Centre and spread in grid units. A box's half-extent is one sigma, so
    // a big box spreads wide and a small one stays tight.
    const cx = ((d.box.x1 + d.box.x2) / 2) * sx
    const cy = ((d.box.y1 + d.box.y2) / 2) * sy
    const sigX = Math.max(0.75, (d.box.width * sx) / 2)
    const sigY = Math.max(0.75, (d.box.height * sy) / 2)

    // Only visit cells within 3 sigma: beyond that the kernel is < 1.2%.
    const xMin = Math.max(0, Math.floor(cx - 3 * sigX))
    const xMax = Math.min(cols - 1, Math.ceil(cx + 3 * sigX))
    const yMin = Math.max(0, Math.floor(cy - 3 * sigY))
    const yMax = Math.min(rows - 1, Math.ceil(cy + 3 * sigY))

    const inv2x = 1 / (2 * sigX * sigX)
    const inv2y = 1 / (2 * sigY * sigY)
    for (let y = yMin; y <= yMax; y++) {
      const dy = y + 0.5 - cy
      const ey = dy * dy * inv2y
      const row = y * cols
      for (let x = xMin; x <= xMax; x++) {
        const dx = x + 0.5 - cx
        values[row + x] += Math.exp(-(dx * dx * inv2x + ey))
      }
    }
  }

  let peak = 0
  for (let i = 0; i < values.length; i++) if (values[i] > peak) peak = values[i]
  if (peak > 0) for (let i = 0; i < values.length; i++) values[i] /= peak
  return { cols, rows, values, peak }
}

/** Sequential palette, dark-to-bright. Perceptually ordered; colourblind-safe. */
export const HEATMAP_STOPS: readonly [number, [number, number, number]][] = [
  [0.0, [32, 18, 77]],
  [0.25, [96, 32, 140]],
  [0.5, [188, 55, 84]],
  [0.75, [244, 133, 49]],
  [1.0, [252, 236, 120]],
]

/** Map a normalised value to RGBA. Low density fades to fully transparent. */
export function heatColor(v: number): [number, number, number, number] {
  if (!(v > 0.02)) return [0, 0, 0, 0]
  const t = Math.min(1, v)
  let i = 0
  while (i < HEATMAP_STOPS.length - 2 && t > HEATMAP_STOPS[i + 1][0]) i++
  const [p0, c0] = HEATMAP_STOPS[i]
  const [p1, c1] = HEATMAP_STOPS[i + 1]
  const f = (t - p0) / (p1 - p0 || 1)
  const rgb = c0.map((c, k) => Math.round(c + (c1[k] - c) * f)) as [number, number, number]
  // Alpha rises quickly so mid densities read, but never fully hides the photo.
  const alpha = Math.round(255 * Math.min(0.92, Math.pow(t, 0.55)))
  return [rgb[0], rgb[1], rgb[2], alpha]
}

export function legendGradient(): string {
  return `linear-gradient(90deg, ${HEATMAP_STOPS.map(
    ([p, [r, g, b]]) => `rgb(${r} ${g} ${b}) ${Math.round(p * 100)}%`,
  ).join(', ')})`
}

/**
 * Rasterise a grid to a PNG data URL.
 *
 * Returns null when there is nothing to draw (no detections) or when canvas
 * is unavailable (e.g. jsdom): the caller then renders no overlay at all
 * rather than a misleading empty-but-tinted one.
 */
export function renderHeatmap(grid: DensityGrid, doc: Document = document): string | null {
  if (grid.peak <= 0 || grid.cols === 0) return null
  const canvas = doc.createElement('canvas')
  canvas.width = grid.cols
  canvas.height = grid.rows
  let ctx: CanvasRenderingContext2D | null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return null

  const image = ctx.createImageData(grid.cols, grid.rows)
  for (let i = 0; i < grid.values.length; i++) {
    const [r, g, b, a] = heatColor(grid.values[i])
    image.data[i * 4] = r
    image.data[i * 4 + 1] = g
    image.data[i * 4 + 2] = b
    image.data[i * 4 + 3] = a
  }
  ctx.putImageData(image, 0, 0)
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

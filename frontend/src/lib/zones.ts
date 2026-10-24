/**
 * Shelf zones: rectangular regions of the image with per-zone statistics.
 *
 * COORDINATES
 * A zone is stored as fractions (0..1) of the ORIGINAL image's width and
 * height. Membership is computed in original pixel space, so a zone means
 * the same thing however large the image is drawn on screen.
 *
 * ASSIGNMENT RULE — documented because it decides every number below
 * A detection belongs to the FIRST zone, in list order, that contains the
 * centre point of its bounding box. Each detection is therefore counted in
 * exactly one zone, never two, even where custom zones overlap. A detection
 * whose centre lies in no zone is reported as "Unassigned".
 */

import { summarizeDetections, type DetectionSummary } from './analytics'
import type { Detection } from '../types'

export interface Zone {
  id: string
  name: string
  /** Left edge, fraction of image width. */
  x0: number
  /** Top edge, fraction of image height. */
  y0: number
  x1: number
  y1: number
}

export const DEFAULT_ZONES: readonly Zone[] = Object.freeze([
  { id: 'top', name: 'Top shelf', x0: 0, y0: 0, x1: 1, y1: 1 / 3 },
  { id: 'middle', name: 'Middle shelf', x0: 0, y0: 1 / 3, x1: 1, y1: 2 / 3 },
  { id: 'bottom', name: 'Bottom shelf', x0: 0, y0: 2 / 3, x1: 1, y1: 1 },
])

export const UNASSIGNED = 'unassigned'

/** Zone tints — distinct from the category palette so the two never blur. */
const ZONE_TINTS = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee']

export function zoneTint(index: number): string {
  return ZONE_TINTS[((index % ZONE_TINTS.length) + ZONE_TINTS.length) % ZONE_TINTS.length]
}

/** Normalised rectangle from two drag points in original-image pixels. */
export function rectFromDrag(
  a: { x: number; y: number },
  b: { x: number; y: number },
  imageWidth: number,
  imageHeight: number,
): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: Math.min(a.x, b.x) / imageWidth,
    y0: Math.min(a.y, b.y) / imageHeight,
    x1: Math.max(a.x, b.x) / imageWidth,
    y1: Math.max(a.y, b.y) / imageHeight,
  }
}

/** Smallest allowed zone edge, as a fraction. Prevents invisible zones. */
export const MIN_ZONE_SIZE = 0.02

export function boxCenter(d: Detection): { x: number; y: number } {
  return { x: (d.box.x1 + d.box.x2) / 2, y: (d.box.y1 + d.box.y2) / 2 }
}

/**
 * Does the zone contain this original-pixel point?
 *
 * Edges are half-open [x0, x1) so two adjacent zones never both claim a
 * point on their shared border — except at the image's own right and bottom
 * edges, which are closed so a box hugging the frame is still counted.
 */
export function zoneContains(
  zone: Zone,
  px: number,
  py: number,
  imageWidth: number,
  imageHeight: number,
): boolean {
  if (imageWidth <= 0 || imageHeight <= 0) return false
  const fx = px / imageWidth
  const fy = py / imageHeight
  const withinX = fx >= zone.x0 && (fx < zone.x1 || (zone.x1 >= 1 && fx <= 1))
  const withinY = fy >= zone.y0 && (fy < zone.y1 || (zone.y1 >= 1 && fy <= 1))
  return withinX && withinY
}

/** The id of the zone a detection belongs to, or UNASSIGNED. */
export function zoneFor(
  d: Detection,
  zones: readonly Zone[],
  imageWidth: number,
  imageHeight: number,
): string {
  const c = boxCenter(d)
  const zone = zones.find((z) => zoneContains(z, c.x, c.y, imageWidth, imageHeight))
  return zone ? zone.id : UNASSIGNED
}

export interface ZoneStat {
  zone: Zone | null
  id: string
  name: string
  detections: Detection[]
  summary: DetectionSummary
}

/**
 * Per-zone statistics. Always includes an "Unassigned" bucket last when it
 * is non-empty, so the zone counts always sum to the number of detections.
 */
export function zoneStats(
  detections: readonly Detection[],
  zones: readonly Zone[],
  imageWidth: number,
  imageHeight: number,
): ZoneStat[] {
  const groups = new Map<string, Detection[]>(zones.map((z) => [z.id, []]))
  groups.set(UNASSIGNED, [])
  for (const d of detections) {
    groups.get(zoneFor(d, zones, imageWidth, imageHeight))!.push(d)
  }

  const stats: ZoneStat[] = zones.map((z) => {
    const list = groups.get(z.id) ?? []
    return { zone: z, id: z.id, name: z.name, detections: list, summary: summarizeDetections(list) }
  })
  const unassigned = groups.get(UNASSIGNED) ?? []
  if (unassigned.length > 0) {
    stats.push({
      zone: null,
      id: UNASSIGNED,
      name: 'Unassigned',
      detections: unassigned,
      summary: summarizeDetections(unassigned),
    })
  }
  return stats
}

/** Clamp and order a zone's edges so it is always a valid rectangle. */
export function normalizeZone(zone: Zone): Zone {
  const clamp = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
  let x0 = clamp(Math.min(zone.x0, zone.x1))
  let x1 = clamp(Math.max(zone.x0, zone.x1))
  let y0 = clamp(Math.min(zone.y0, zone.y1))
  let y1 = clamp(Math.max(zone.y0, zone.y1))
  if (x1 - x0 < MIN_ZONE_SIZE) {
    x1 = Math.min(1, x0 + MIN_ZONE_SIZE)
    x0 = x1 - MIN_ZONE_SIZE
  }
  if (y1 - y0 < MIN_ZONE_SIZE) {
    y1 = Math.min(1, y0 + MIN_ZONE_SIZE)
    y0 = y1 - MIN_ZONE_SIZE
  }
  return { ...zone, x0, y0, x1, y1, name: zone.name.trim().slice(0, 40) || 'Zone' }
}

export function newZoneId(existing: readonly Zone[]): string {
  let n = existing.length + 1
  while (existing.some((z) => z.id === `zone-${n}`)) n++
  return `zone-${n}`
}

// ---------------------------------------------------------------------------
// Persistence — a UI preference, so localStorage is appropriate here.
// Never put credentials or analysis data in this key.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'visioniq.zones.v1'

function isZone(value: unknown): value is Zone {
  if (!value || typeof value !== 'object') return false
  const z = value as Record<string, unknown>
  return (
    typeof z.id === 'string' &&
    typeof z.name === 'string' &&
    ['x0', 'y0', 'x1', 'y1'].every((k) => typeof z[k] === 'number' && Number.isFinite(z[k]))
  )
}

export function loadZones(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Zone[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_ZONES.map((z) => ({ ...z }))
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_ZONES.map((z) => ({ ...z }))
    const zones = parsed.filter(isZone).map(normalizeZone).slice(0, 12)
    return zones.length ? zones : DEFAULT_ZONES.map((z) => ({ ...z }))
  } catch {
    return DEFAULT_ZONES.map((z) => ({ ...z }))
  }
}

export function saveZones(
  zones: readonly Zone[],
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(zones))
  } catch {
    // Storage full or blocked: zones still work for this session.
  }
}

export function isDefaultLayout(zones: readonly Zone[]): boolean {
  return (
    zones.length === DEFAULT_ZONES.length &&
    zones.every((z, i) => {
      const d = DEFAULT_ZONES[i]
      return (
        z.id === d.id &&
        z.name === d.name &&
        Math.abs(z.x0 - d.x0) < 1e-6 &&
        Math.abs(z.y0 - d.y0) < 1e-6 &&
        Math.abs(z.x1 - d.x1) < 1e-6 &&
        Math.abs(z.y1 - d.y1) < 1e-6
      )
    })
  )
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

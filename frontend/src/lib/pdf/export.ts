/**
 * Browser glue for the report: draw the annotated image to a canvas, encode
 * it as JPEG, build the PDF and hand it to the user as a download.
 */

import { compareRecords, filterByThreshold } from '../analytics'
import type { Zone } from '../zones'
import type { AnalysisRecord } from '../../types'
import { colorFor } from '../../utils/colors'
import { buildInspectionReport, reportFilename, type ReportImage } from './report'

/** Longest edge of the embedded image. Keeps the PDF small and memory low. */
const MAX_EDGE = 1600

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

/**
 * Render the image with its boxes, as a baseline JPEG. Returns null where
 * there is no canvas (tests, very old browsers) or the image cannot load —
 * the report then says the image is unavailable rather than failing.
 */
export async function renderAnnotatedJpeg(
  url: string,
  record: AnalysisRecord,
  threshold: number,
  colors: Record<string, string>,
): Promise<ReportImage | null> {
  try {
    const img = await loadImage(url)
    const srcW = record.detection?.image_width || img.naturalWidth
    const srcH = record.detection?.image_height || img.naturalHeight
    if (!srcW || !srcH) return null
    const scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH))
    const w = Math.max(1, Math.round(srcW * scale))
    const h = Math.max(1, Math.round(srcH * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, w, h)

    const line = Math.max(2, Math.round(Math.max(w, h) / 400))
    ctx.lineWidth = line
    for (const d of filterByThreshold(record.detection?.detections ?? [], threshold)) {
      ctx.strokeStyle = colorFor(colors, d.label)
      ctx.strokeRect(d.box.x1 * scale, d.box.y1 * scale, d.box.width * scale, d.box.height * scale)
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob) return null
    const jpeg = new Uint8Array(await blob.arrayBuffer())
    // Release the backing store promptly rather than waiting for GC.
    canvas.width = 0
    canvas.height = 0
    return { jpeg, width: w, height: h }
  } catch {
    return null
  }
}

export interface ExportOptions {
  record: AnalysisRecord
  imageUrl: string | null
  imageUnavailableReason?: string
  threshold: number
  zones: readonly Zone[]
  colors: Record<string, string>
  /** Earlier scan to compare against. */
  base?: AnalysisRecord | null
  now?: Date
}

export async function createReport(options: ExportOptions): Promise<{ bytes: Uint8Array; filename: string }> {
  const now = options.now ?? new Date()
  const image = options.imageUrl
    ? await renderAnnotatedJpeg(options.imageUrl, options.record, options.threshold, options.colors)
    : null
  const comparison = options.base
    ? { base: options.base, result: compareRecords(options.base, options.record) }
    : null
  const bytes = buildInspectionReport({
    record: options.record,
    threshold: options.threshold,
    zones: options.zones,
    colors: options.colors,
    generatedAt: now,
    image,
    imageNote: image
      ? undefined
      : (options.imageUnavailableReason ??
        'The image could not be included in this report. All detection data below is complete.'),
    comparison,
  })
  return { bytes, filename: reportFilename(options.record, now, options.base) }
}

export function downloadBytes(bytes: Uint8Array, filename: string, type = 'application/pdf'): void {
  const blob = new Blob([bytes as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the browser time to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/**
 * The VisionIQ inspection report.
 *
 * Everything printed here is computed from the scan record by the same
 * `lib/analytics` and `lib/zones` functions the dashboard uses, so the PDF
 * and the screen cannot disagree. Sections that have no data say so instead
 * of being filled in.
 */

import {
  confidenceHistogram,
  filterByThreshold,
  GENERIC_TAXONOMY_CAVEAT,
  inferenceThreshold,
  LOW_CONFIDENCE,
  scanOutcome,
  sizeDistribution,
  summarizeDetections,
  type ScanComparison,
} from '../analytics'
import { zoneStats, type Zone } from '../zones'
import type { AnalysisRecord } from '../../types'
import { fitText, textWidth, wrapText, type FontName } from './fonts'
import { A4, hexToRgb, PdfDocument, type PdfImage, type PdfPage, type Rgb } from './writer'

export interface ReportImage {
  /** Baseline JPEG bytes of the annotated image. */
  jpeg: Uint8Array
  width: number
  height: number
}

export interface ReportInput {
  record: AnalysisRecord
  /** The confidence filter applied in the UI when the report was made. */
  threshold: number
  zones: readonly Zone[]
  colors: Record<string, string>
  generatedAt: Date
  image?: ReportImage | null
  /** Why the image is missing, when it is. */
  imageNote?: string
  comparison?: { base: AnalysisRecord; result: ScanComparison } | null
}

// -- palette ----------------------------------------------------------------

const INK: Rgb = hexToRgb('#0f172a')
const MUTED: Rgb = hexToRgb('#64748b')
const RULE: Rgb = hexToRgb('#e2e8f0')
const PANEL: Rgb = hexToRgb('#f8fafc')
const BRAND: Rgb = hexToRgb('#0b1220')
const ACCENT: Rgb = hexToRgb('#5b8cff')
const WARN_BG: Rgb = hexToRgb('#fff7ed')
const WARN: Rgb = hexToRgb('#c2410c')
const WHITE: Rgb = [1, 1, 1]

const MARGIN = 48
const CONTENT = A4.width - MARGIN * 2
const TOP = 56
const BOTTOM = A4.height - 54

// -- formatting -------------------------------------------------------------

const pct = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(digits)}%`

function isoMinute(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function timeZoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'
  } catch {
    return 'local time'
  }
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : isoMinute(d)
}

/**
 * A safe, descriptive download name: lowercase ASCII, no path separators,
 * bounded length. e.g. visioniq-report-shelf-a-2026-10-23-1a2b3c4d.pdf
 */
export function reportFilename(record: AnalysisRecord, generatedAt: Date, compared?: AnalysisRecord | null): string {
  const slug =
    record.image.filename
      .replace(/\.[a-z0-9]+$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'scan'
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${generatedAt.getFullYear()}-${p(generatedAt.getMonth() + 1)}-${p(generatedAt.getDate())}`
  const id = record.analysis_id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'id'
  return `visioniq-report-${slug}${compared ? '-comparison' : ''}-${date}-${id}.pdf`
}

// -- layout -----------------------------------------------------------------

class Layout {
  readonly doc: PdfDocument
  page!: PdfPage
  y = TOP

  constructor(doc: PdfDocument) {
    this.doc = doc
    this.newPage()
  }

  newPage(): void {
    this.page = this.doc.addPage()
    this.y = TOP
  }

  /** Start a new page unless `height` points still fit. */
  ensure(height: number): void {
    if (this.y + height > BOTTOM) this.newPage()
  }

  gap(h: number): void {
    this.y += h
  }

  heading(text: string): void {
    this.ensure(48)
    this.gap(10)
    this.page.text(MARGIN, this.y + 12, text, { size: 13, font: 'bold', color: INK })
    this.y += 18
    this.page.line(MARGIN, this.y, MARGIN + CONTENT, this.y, { color: RULE, width: 0.75 })
    this.y += 10
  }

  paragraph(text: string, opts: { size?: number; color?: Rgb; font?: FontName; indent?: number } = {}): void {
    const size = opts.size ?? 9.5
    const indent = opts.indent ?? 0
    const lead = size * 1.4
    for (const line of wrapText(text, CONTENT - indent, size, opts.font)) {
      this.ensure(lead)
      this.page.text(MARGIN + indent, this.y + size, line, { size, color: opts.color ?? INK, font: opts.font })
      this.y += lead
    }
  }

  bullets(items: readonly string[], size = 9.5): void {
    for (const item of items) {
      const lines = wrapText(item, CONTENT - 14, size)
      const lead = size * 1.4
      this.ensure(lead * Math.min(lines.length, 2))
      this.page.text(MARGIN + 2, this.y + size, '•', { size, color: MUTED })
      for (const line of lines) {
        this.ensure(lead)
        this.page.text(MARGIN + 14, this.y + size, line, { size, color: INK })
        this.y += lead
      }
      this.y += 2
    }
  }

  /** Two-column key/value list. */
  keyValues(rows: readonly [string, string][]): void {
    const size = 9.5
    const keyW = 150
    for (const [k, v] of rows) {
      const lines = wrapText(v, CONTENT - keyW, size)
      const h = lines.length * size * 1.4 + 4
      this.ensure(h)
      this.page.text(MARGIN, this.y + size, k, { size, color: MUTED })
      lines.forEach((line, i) => {
        this.page.text(MARGIN + keyW, this.y + size + i * size * 1.4, line, { size, color: INK })
      })
      this.y += h
    }
  }

  /**
   * A table with a header row, repeating the header after a page break.
   * `align` is 'r' for numeric columns.
   */
  table(columns: readonly { title: string; width: number; align?: 'l' | 'r' }[], rows: readonly string[][]): void {
    const size = 8.5
    const rowH = 15
    const totalW = columns.reduce((s, c) => s + c.width, 0)
    const scale = CONTENT / totalW
    const widths = columns.map((c) => c.width * scale)

    const header = () => {
      this.page.rect(MARGIN, this.y, CONTENT, rowH, { fill: PANEL })
      let x = MARGIN
      columns.forEach((c, i) => {
        const t = fitText(c.title, widths[i] - 8, size, 'bold')
        const tx = c.align === 'r' ? x + widths[i] - 4 - textWidth(t, size, 'bold') : x + 4
        this.page.text(tx, this.y + 10.5, t, { size, font: 'bold', color: MUTED })
        x += widths[i]
      })
      this.y += rowH
    }

    this.ensure(rowH * 2)
    header()
    for (const row of rows) {
      if (this.y + rowH > BOTTOM) {
        this.newPage()
        header()
      }
      let x = MARGIN
      columns.forEach((c, i) => {
        const t = fitText(row[i] ?? '', widths[i] - 8, size)
        const tx = c.align === 'r' ? x + widths[i] - 4 - textWidth(t, size) : x + 4
        this.page.text(tx, this.y + 10.5, t, { size, color: INK })
        x += widths[i]
      })
      this.y += rowH
      this.page.line(MARGIN, this.y, MARGIN + CONTENT, this.y, { color: RULE, width: 0.5 })
    }
    this.y += 6
  }

  /** Horizontal bars, one per item, scaled to the largest value. */
  barChart(items: readonly { label: string; value: number; color?: Rgb; detail?: string }[]): void {
    const size = 8.5
    const rowH = 14
    const labelW = 120
    const valueW = 70
    const barW = CONTENT - labelW - valueW
    const max = Math.max(1, ...items.map((i) => i.value))
    for (const item of items) {
      this.ensure(rowH)
      this.page.text(MARGIN, this.y + 10, fitText(item.label, labelW - 8, size), { size, color: INK })
      this.page.rect(MARGIN + labelW, this.y + 3, barW, 8, { fill: PANEL })
      this.page.rect(MARGIN + labelW, this.y + 3, (item.value / max) * barW, 8, { fill: item.color ?? ACCENT })
      const v = item.detail ?? String(item.value)
      this.page.text(MARGIN + CONTENT - textWidth(v, size), this.y + 10, v, { size, color: MUTED })
      this.y += rowH
    }
    this.y += 4
  }

  /** Vertical columns with labels under the first, middle and last bar. */
  columnChart(
    bins: readonly { label: string; value: number; dim?: boolean; warn?: boolean }[],
    caption: string,
  ): void {
    const height = 90
    this.ensure(height + 34)
    const max = Math.max(1, ...bins.map((b) => b.value))
    const top = this.y
    const slot = CONTENT / Math.max(1, bins.length)
    this.page.line(MARGIN, top + height, MARGIN + CONTENT, top + height, { color: RULE, width: 0.75 })
    bins.forEach((b, i) => {
      const h = (b.value / max) * (height - 12)
      const x = MARGIN + i * slot + slot * 0.12
      const fill = b.dim ? RULE : b.warn ? hexToRgb('#f59e0b') : ACCENT
      this.page.rect(x, top + height - h, slot * 0.76, h, { fill })
      if (b.value > 0) {
        const v = String(b.value)
        this.page.text(x + (slot * 0.76 - textWidth(v, 7)) / 2, top + height - h - 2, v, { size: 7, color: MUTED })
      }
    })
    const ticks = [0, Math.floor((bins.length - 1) / 2), bins.length - 1]
    for (const i of [...new Set(ticks)]) {
      const label = bins[i]?.label
      if (!label) continue
      const x = MARGIN + i * slot + slot / 2 - textWidth(label, 7.5) / 2
      this.page.text(Math.max(MARGIN, Math.min(x, MARGIN + CONTENT - textWidth(label, 7.5))), top + height + 11, label, {
        size: 7.5,
        color: MUTED,
      })
    }
    this.y = top + height + 18
    this.paragraph(caption, { size: 8, color: MUTED })
  }

  callout(title: string, body: string): void {
    const size = 9
    const lines = wrapText(body, CONTENT - 20, size)
    const h = 18 + lines.length * size * 1.4 + 8
    this.ensure(h)
    this.page.rect(MARGIN, this.y, CONTENT, h, { fill: WARN_BG })
    this.page.rect(MARGIN, this.y, 3, h, { fill: WARN })
    this.page.text(MARGIN + 12, this.y + 14, title, { size: 9.5, font: 'bold', color: WARN })
    lines.forEach((line, i) => {
      this.page.text(MARGIN + 12, this.y + 28 + i * size * 1.4, line, { size, color: INK })
    })
    this.y += h + 8
  }

  image(img: PdfImage, maxHeight: number): void {
    const scale = Math.min(CONTENT / img.width, maxHeight / img.height)
    const w = img.width * scale
    const h = img.height * scale
    this.ensure(h + 8)
    const x = MARGIN + (CONTENT - w) / 2
    this.page.rect(x - 1, this.y - 1, w + 2, h + 2, { stroke: RULE, lineWidth: 1 })
    this.page.image(img, x, this.y, w, h)
    this.y += h + 8
  }
}

// -- report -----------------------------------------------------------------

export function buildInspectionReport(input: ReportInput): Uint8Array {
  const { record, threshold, zones, colors, generatedAt, comparison } = input
  const detection = record.detection
  const outcome = scanOutcome(record)
  const floor = inferenceThreshold(record)
  const all = detection?.detections ?? []
  const visible = filterByThreshold(all, threshold)
  const summary = summarizeDetections(visible)
  const width = detection?.image_width ?? record.image.width
  const height = detection?.image_height ?? record.image.height
  const isDemo = record.execution_mode === 'demo'

  const doc = new PdfDocument({
    title: `VisionIQ inspection report - ${record.image.filename}`,
    author: 'VisionIQ',
    subject: `Scan ${record.analysis_id}`,
  })
  const L = new Layout(doc)

  // ---- cover band -----------------------------------------------------------
  L.page.rect(0, 0, A4.width, 92, { fill: BRAND })
  L.page.rect(MARGIN, 30, 10, 10, { fill: ACCENT })
  L.page.text(MARGIN + 18, 40, 'VisionIQ', { size: 18, font: 'bold', color: WHITE })
  L.page.text(MARGIN, 64, comparison ? 'AI Shelf Inspection Report - with comparison' : 'AI Shelf Inspection Report', {
    size: 11,
    color: hexToRgb('#cbd5e1'),
  })
  const stamp = `Generated ${isoMinute(generatedAt)} (${timeZoneLabel()})`
  L.page.text(A4.width - MARGIN - textWidth(stamp, 8.5), 64, stamp, { size: 8.5, color: hexToRgb('#94a3b8') })
  L.y = 112

  L.page.text(MARGIN, L.y + 14, fitText(record.image.filename, CONTENT, 16, 'bold'), { size: 16, font: 'bold', color: INK })
  L.y += 26

  L.keyValues([
    ['Scan ID', record.analysis_id],
    ['Captured', `${fmtDate(record.created_at)} (${timeZoneLabel()})`],
    ['Status', `${record.status} - ${outcomeText(outcome)}`],
    ['Execution mode', isDemo ? 'demo (recorded fixture, not a live inference)' : record.execution_mode],
    ['Image', `${record.image.width} x ${record.image.height} px, ${record.image.format}`],
    ['Confidence filter', `${pct(threshold)} (model reported detections at >= ${pct(floor)})`],
  ])

  L.gap(4)
  L.callout(
    'Read this first',
    'Counts in this report are object DETECTIONS from a generic ' +
      `${detection?.model.taxonomy ?? 'object'} model, not inventory, SKUs or stock levels. ` +
      'Confidence scores are the model’s own and are not calibrated probabilities. ' +
      (isDemo ? 'This scan is a recorded demo fixture. ' : '') +
      'See "Limitations and disclaimers" at the end.',
  )

  // ---- image ----------------------------------------------------------------
  L.heading('Annotated image')
  if (input.image) {
    const img = doc.addJpeg(input.image.jpeg, input.image.width, input.image.height)
    L.image(img, 330)
    L.paragraph(
      `Boxes show the ${visible.length} detection${visible.length === 1 ? '' : 's'} at or above ${pct(threshold)}, ` +
        'coloured by category as on screen.',
      { size: 8, color: MUTED },
    )
  } else {
    L.paragraph(input.imageNote ?? 'The image is not available for this scan. All detection data below is complete.', {
      color: MUTED,
    })
  }

  // ---- summary --------------------------------------------------------------
  L.heading('Detection summary')
  if (outcome === 'unavailable' || outcome === 'failed' || outcome === 'pending') {
    L.callout(
      outcome === 'unavailable' ? 'Detection did not run' : outcome === 'failed' ? 'Analysis failed' : 'Not finished',
      outcome === 'unavailable'
        ? 'No model was available, so nothing was analysed. This is NOT evidence of an empty shelf.'
        : outcome === 'failed'
          ? record.error ?? 'The scan did not complete and produced no results.'
          : `The job is ${record.status}; no results exist yet.`,
    )
  } else {
    L.keyValues([
      ['Detections shown', `${summary.count} of ${all.length} reported by the model`],
      ['Hidden by filter', String(all.length - visible.length)],
      ['Categories', String(summary.categories.length)],
      ['Mean confidence', pct(summary.meanConfidence, 1)],
      ['Confidence range', summary.count ? `${pct(summary.minConfidence, 1)} - ${pct(summary.maxConfidence, 1)}` : '-'],
      ['Low confidence (< 50%)', String(summary.lowConfidenceCount)],
    ])
  }

  // ---- model ----------------------------------------------------------------
  L.heading('Model')
  if (detection) {
    L.keyValues([
      ['Model', detection.model.name],
      ['Version', detection.model.version || 'Not available'],
      ['Provider', detection.model.provider],
      ['Taxonomy', detection.model.taxonomy],
      ['Device', detection.model.device],
      ['Inference time', detection.processing_ms > 0 ? `${Math.round(detection.processing_ms)} ms` : 'Not available'],
      ['Inference threshold', pct(floor)],
      ['Inference status', detection.status],
    ])
  } else {
    L.paragraph('No inference metadata is attached to this scan.', { color: MUTED })
  }

  // ---- categories -----------------------------------------------------------
  if (summary.count > 0) {
    L.heading('Categories')
    L.barChart(
      summary.categories.slice(0, 15).map((c) => ({
        label: c.label,
        value: c.count,
        color: colors[c.label] ? hexToRgb(colors[c.label]) : ACCENT,
        detail: `${c.count} (${pct(c.share)})`,
      })),
    )
    L.table(
      [
        { title: 'Category', width: 150 },
        { title: 'Count', width: 60, align: 'r' },
        { title: 'Share', width: 60, align: 'r' },
        { title: 'Mean conf.', width: 80, align: 'r' },
        { title: 'Min - max conf.', width: 110, align: 'r' },
      ],
      summary.categories.map((c) => [
        c.label,
        String(c.count),
        pct(c.share, 1),
        pct(c.meanConfidence, 1),
        `${pct(c.minConfidence)} - ${pct(c.maxConfidence)}`,
      ]),
    )

    // ---- confidence ---------------------------------------------------------
    L.heading('Confidence distribution')
    const bins = confidenceHistogram(all, floor)
    L.columnChart(
      bins.map((b) => ({
        label: `${Math.round(b.start * 100)}%`,
        value: b.count,
        dim: b.end <= threshold + 1e-9,
        warn: b.start < LOW_CONFIDENCE,
      })),
      `All ${all.length} detections in 5-point bins from ${pct(floor)}. Grey bars fall below the ${pct(threshold)} filter; ` +
        'amber bars are below 50%.',
    )

    L.heading('Detection size')
    L.table(
      [
        { title: 'Box area (share of image)', width: 200 },
        { title: 'Detections', width: 80, align: 'r' },
      ],
      sizeDistribution(visible, width, height).map((s) => [s.label, String(s.count)]),
    )

    // ---- zones --------------------------------------------------------------
    L.heading('Shelf zones')
    L.paragraph(
      'Each detection is assigned to the first zone that contains the centre of its box, so no detection is counted twice. ' +
        'Zones are rectangles drawn by the user; they do not come from the model.',
      { size: 8.5, color: MUTED },
    )
    L.gap(4)
    L.table(
      [
        { title: 'Zone', width: 120 },
        { title: 'Bounds (L,T,R,B %)', width: 120 },
        { title: 'Detections', width: 70, align: 'r' },
        { title: 'Share', width: 55, align: 'r' },
        { title: 'Mean conf.', width: 65, align: 'r' },
        { title: 'Top categories', width: 140 },
      ],
      zoneStats(visible, zones, width, height).map((z) => [
        z.name,
        z.zone
          ? [z.zone.x0, z.zone.y0, z.zone.x1, z.zone.y1].map((v) => Math.round(v * 100)).join(', ')
          : 'outside all zones',
        String(z.summary.count),
        pct(visible.length ? z.summary.count / visible.length : null),
        pct(z.summary.meanConfidence),
        z.summary.categories
          .slice(0, 3)
          .map((c) => `${c.label} ${c.count}`)
          .join(', ') || '-',
      ]),
    )
  }

  // ---- warnings -------------------------------------------------------------
  const warnings: string[] = []
  if (summary.lowConfidenceCount > 0) {
    warnings.push(
      `${summary.lowConfidenceCount} detection${summary.lowConfidenceCount === 1 ? ' is' : 's are'} below 50% confidence; verify them against the image.`,
    )
  }
  if (detection?.status === 'timeout') warnings.push('Inference exceeded its time budget; treat this run as degraded.')
  for (const w of detection?.warnings ?? []) warnings.push(w)
  for (const c of record.retail?.caveats ?? []) if (!warnings.includes(c)) warnings.push(c)
  // Detector warnings and retail caveats often restate the same fact in
  // different words; keep the first statement of each topic.
  const topic = (w: string) => (/below 50%/i.test(w) ? 'low-confidence' : /COCO-80/i.test(w) ? 'taxonomy' : w)
  const seenTopics = new Set<string>()
  const uniqueWarnings = warnings.filter((w) => {
    const t = topic(w)
    if (seenTopics.has(t)) return false
    seenTopics.add(t)
    return true
  })
  warnings.splice(0, warnings.length, ...uniqueWarnings)
  L.heading('Warnings')
  if (warnings.length) L.bullets(warnings)
  else L.paragraph('No warnings were recorded for this scan.', { color: MUTED })

  // ---- comparison -----------------------------------------------------------
  if (comparison) {
    const { base, result } = comparison
    L.heading('Comparison with an earlier scan')
    L.keyValues([
      ['Before (base)', `${base.image.filename} - ${fmtDate(base.created_at)}`],
      ['After (this scan)', `${record.image.filename} - ${fmtDate(record.created_at)}`],
      ['Common threshold', pct(result.threshold)],
      ['Detections', `${result.total_before} -> ${result.total_after} (${signed(result.total_delta)})`],
      ['Mean confidence', `${pct(result.meanBefore, 1)} -> ${pct(result.meanAfter, 1)}`],
      ['Same model', result.comparable ? 'yes' : 'NO - label spaces may not align'],
    ])
    if (result.dimensionsDiffer) {
      L.paragraph('The two images have different dimensions; they were not taken from an identical position.', {
        size: 8.5,
        color: WARN,
      })
    }
    L.gap(4)
    L.table(
      [
        { title: 'Category', width: 150 },
        { title: 'Before', width: 60, align: 'r' },
        { title: 'After', width: 60, align: 'r' },
        { title: 'Change', width: 60, align: 'r' },
        { title: 'Mean conf. before -> after', width: 150, align: 'r' },
      ],
      result.categories.map((c) => {
        const conf = result.confidence.find((x) => x.label === c.label)
        return [c.label, String(c.before), String(c.after), signed(c.delta), `${pct(conf?.before)} -> ${pct(conf?.after)}`]
      }),
    )
    L.bullets(result.notable_changes, 9)
    L.paragraph('These are changes in what the model detected, not verified stock movement.', {
      size: 9,
      font: 'bold',
      color: INK,
    })
    L.bullets(result.caveats, 8.5)
  }

  // ---- detection appendix ---------------------------------------------------
  if (visible.length > 0) {
    L.heading('Detections')
    const sorted = [...visible].sort((a, b) => b.confidence - a.confidence)
    const cap = 300
    L.table(
      [
        { title: '#', width: 40, align: 'r' },
        { title: 'Label', width: 140 },
        { title: 'Confidence', width: 80, align: 'r' },
        { title: 'Box x1,y1 - x2,y2 (px)', width: 180, align: 'r' },
      ],
      sorted
        .slice(0, cap)
        .map((d) => [
          String(d.id),
          d.label,
          pct(d.confidence, 1),
          `${Math.round(d.box.x1)},${Math.round(d.box.y1)} - ${Math.round(d.box.x2)},${Math.round(d.box.y2)}`,
        ]),
    )
    if (sorted.length > cap) L.paragraph(`${sorted.length - cap} further detections omitted.`, { size: 8.5, color: MUTED })
  }

  // ---- disclaimers ----------------------------------------------------------
  L.heading('Limitations and disclaimers')
  L.bullets([
    'Confidence is not probability. Scores have not been calibrated against ground truth for shelf images.',
    GENERIC_TAXONOMY_CAVEAT,
    'No SKU recognition is performed; product identity is unsupported.',
    'Shelf gaps are never inferred from missing detections. Occlusion, angle and lighting all cause misses.',
    'The heatmap and zone figures describe where detections were found, not customer attention, foot traffic or sales.',
    'Box diagnostics describe what the model output, not why; no causal or saliency explanation is given.',
    ...(isDemo ? ['This report was produced from a recorded demo fixture, not a live inference.'] : []),
  ], 8.5)

  // ---- footers --------------------------------------------------------------
  const total = doc.pages.length
  doc.pages.forEach((page, i) => {
    page.line(MARGIN, A4.height - 36, MARGIN + CONTENT, A4.height - 36, { color: RULE, width: 0.5 })
    page.text(MARGIN, A4.height - 22, fitText(`VisionIQ - scan ${record.analysis_id}`, CONTENT - 80, 7.5), {
      size: 7.5,
      color: MUTED,
    })
    const label = `Page ${i + 1} of ${total}`
    page.text(MARGIN + CONTENT - textWidth(label, 7.5), A4.height - 22, label, { size: 7.5, color: MUTED })
  })

  return doc.toBytes()
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

function outcomeText(outcome: ReturnType<typeof scanOutcome>): string {
  switch (outcome) {
    case 'analyzed':
      return 'analysed'
    case 'empty':
      return 'model ran, nothing above threshold'
    case 'unavailable':
      return 'no model ran'
    case 'failed':
      return 'failed'
    default:
      return 'in progress'
  }
}

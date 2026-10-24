import { describe, expect, it } from 'vitest'
import { compareRecords } from '../analytics'
import { DEFAULT_ZONES } from '../zones'
import { makeDetection, makeRecord } from '../../test/fixtures'
import { buildColorMap } from '../../utils/colors'
import { fitText, textWidth, toWinAnsi, wrapText } from './fonts'
import { buildInspectionReport, reportFilename, type ReportInput } from './report'
import { escapePdfString, PdfDocument } from './writer'

const latin1 = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes)

/** Structural validation a PDF reader would perform on open. */
function validate(bytes: Uint8Array) {
  const text = latin1(bytes)
  expect(text.startsWith('%PDF-1.4\n')).toBe(true)
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true)

  const startxref = Number(/startxref\n(\d+)\n%%EOF\s*$/.exec(text)![1])
  expect(text.slice(startxref, startxref + 4)).toBe('xref')

  const size = Number(/\/Size (\d+)/.exec(text)![1])
  const entries = text.slice(startxref).split('\n').slice(3, 3 + size - 1)
  expect(entries).toHaveLength(size - 1)
  entries.forEach((entry, i) => {
    const offset = Number(entry.slice(0, 10))
    // Every xref offset must land exactly on its object header.
    expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`)
  })

  // Every stream's /Length must match its actual byte length.
  const streamRe = /\/Length (\d+)[^>]*>>\nstream\n/g
  let m: RegExpExecArray | null
  let streams = 0
  while ((m = streamRe.exec(text))) {
    const start = m.index + m[0].length
    const end = start + Number(m[1])
    expect(text.slice(end, end + 10)).toBe('\nendstream')
    streams++
  }
  const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)![1])
  expect((text.match(/\/Type \/Page /g) ?? []).length).toBe(pages)
  return { text, pages, streams }
}

const dets = [
  makeDetection(0, 'bottle', 0.92, [0, 0, 40, 40]),
  makeDetection(1, 'bottle', 0.81, [100, 120, 140, 160]),
  makeDetection(2, 'cup', 0.33, [200, 250, 240, 290]),
]

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    record: makeRecord(dets),
    threshold: 0.25,
    zones: DEFAULT_ZONES,
    colors: buildColorMap(['bottle', 'cup']),
    generatedAt: new Date(2026, 9, 23, 14, 5),
    ...overrides,
  }
}

// Smallest structurally valid baseline JPEG marker sequence for embedding tests.
const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])

describe('PDF writer', () => {
  it('produces a structurally valid empty document', () => {
    const { pages } = validate(new PdfDocument().toBytes())
    expect(pages).toBe(1)
  })

  it('writes document metadata under the spec-defined keys', () => {
    const { text } = validate(new PdfDocument({ title: 'T (1)', author: 'VisionIQ' }).toBytes())
    expect(text).toContain('/Title (T \\(1\\))')
    expect(text).toContain('/Author (VisionIQ)')
  })

  it('escapes PDF string delimiters', () => {
    expect(escapePdfString('a (b) \\ c')).toBe('a \\(b\\) \\\\ c')
  })

  it('embeds JPEG bytes unchanged with DCTDecode', () => {
    const doc = new PdfDocument()
    const img = doc.addJpeg(FAKE_JPEG, 10, 8)
    doc.addPage().image(img, 0, 0, 10, 8)
    const bytes = doc.toBytes()
    const { text } = validate(bytes)
    expect(text).toContain('/Filter /DCTDecode')
    expect(text).toContain(`/Length ${FAKE_JPEG.length}`)
    expect(text).toContain('/XObject << /Im1')
    const at = text.indexOf('\xff\xd8\xff\xe0')
    expect(Array.from(bytes.slice(at, at + FAKE_JPEG.length))).toEqual(Array.from(FAKE_JPEG))
  })
})

describe('fonts', () => {
  it('maps typographic characters to WinAnsi and replaces the rest', () => {
    expect(toWinAnsi('a – b • c ≥ d')).toBe('a \x96 b \x95 c >= d')
    expect(toWinAnsi('棚 shelf')).toBe('? shelf')
    for (const ch of toWinAnsi('“quotes” → 💡')) expect(ch.charCodeAt(0)).toBeLessThan(256)
  })

  it('wraps without any line exceeding the width, even for unbroken words', () => {
    const lines = wrapText(`short words then ${'x'.repeat(200)} end`, 120, 10)
    for (const l of lines) expect(textWidth(l, 10)).toBeLessThanOrEqual(120)
    expect(lines.join('')).toContain('end')
  })

  it('is idempotent, so truncated text keeps its ellipsis in the PDF (BUG-12 regression)', () => {
    const once = toWinAnsi('a – b … c × d')
    expect(toWinAnsi(once)).toBe(once)
    const doc = new PdfDocument()
    doc.addPage().text(10, 10, fitText('a very long filename that will not fit.jpg', 60, 10))
    const out = latin1(doc.toBytes())
    // The test decoder is windows-1252, which shows byte 0x85 as U+2026.
    expect(out).toContain('…) Tj')
    expect(out).not.toContain('?) Tj')
  })

  it('truncates with an ellipsis', () => {
    const t = fitText('a very long filename that will not fit.jpg', 60, 10)
    expect(textWidth(t, 10)).toBeLessThanOrEqual(60)
    expect(t.endsWith('\x85')).toBe(true)
  })
})

describe('inspection report', () => {
  it('is a valid PDF with the scan, model, categories, zones and disclaimers', () => {
    const { text, pages } = validate(buildInspectionReport(input()))
    expect(pages).toBeGreaterThanOrEqual(2)
    for (const s of [
      'VisionIQ',
      'AI Shelf Inspection Report',
      '(shelf.png)',
      'yolov8n.pt',
      'Detection summary',
      'Categories',
      'Confidence distribution',
      'Shelf zones',
      'Top shelf',
      'Warnings',
      'Limitations and disclaimers',
      `Page 1 of ${pages}`,
      `Page ${pages} of ${pages}`,
    ]) {
      expect(text).toContain(s)
    }
    // Counts come from the record: 3 detections, 1 below 50%.
    expect(text).toContain('(3 of 3 reported by the model)')
    expect(text).toMatch(/1 detection is below 50% confidence/)
  })

  it('draws every text run and image inside the page margins', () => {
    const many = Array.from({ length: 80 }, (_, i) => makeDetection(i, `label-${i % 9}`, 0.26 + (i % 74) / 100))
    const { text } = validate(
      buildInspectionReport(
        input({
          record: makeRecord(many, { image: { ...makeRecord().image, filename: `${'very-long-name-'.repeat(12)}.jpg` } }),
          image: { jpeg: FAKE_JPEG, width: 4000, height: 1000 },
        }),
      ),
    )
    const runs = [...text.matchAll(/Tf [\d. ]+ rg ([\d.]+) ([\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj/g)]
    expect(runs.length).toBeGreaterThan(100)
    for (const [, x, y] of runs) {
      expect(Number(x)).toBeGreaterThanOrEqual(0)
      expect(Number(x)).toBeLessThan(595.28)
      expect(Number(y)).toBeGreaterThan(0)
      expect(Number(y)).toBeLessThan(841.89)
    }
    // Images: "w 0 0 h x y cm" must fit inside the 48pt margins.
    for (const [, w, h, x, y] of text.matchAll(/q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(48 - 0.01)
      expect(Number(x) + Number(w)).toBeLessThanOrEqual(595.28 - 48 + 0.01)
      expect(Number(y)).toBeGreaterThan(0)
      expect(Number(y) + Number(h)).toBeLessThan(841.89)
    }
  })

  it('states each warning topic once (BUG-05 regression)', () => {
    const base = makeRecord(dets)
    const record = {
      ...base,
      detection: { ...base.detection!, warnings: ['Generic COCO-80 model: labels are object categories, not retail SKUs.'] },
      retail: { ...base.retail!, caveats: ['Labels come from a generic COCO-80 taxonomy, not a retail product catalogue.', '1 detection(s) fall below 50% confidence and warrant human review.'] },
    }
    const { text } = validate(buildInspectionReport(input({ record })))
    const section = text.slice(text.indexOf('(Warnings)'), text.indexOf('(Limitations and disclaimers)'))
    expect((section.match(/below 50%/g) ?? []).length).toBe(1)
    expect((section.match(/COCO-80/g) ?? []).length).toBe(1)
  })

  it('uses the confidence filter for every figure', () => {
    const { text } = validate(buildInspectionReport(input({ threshold: 0.5 })))
    expect(text).toContain('(2 of 3 reported by the model)')
    expect(text).not.toMatch(/below 50% confidence; verify/)
  })

  it('states when the image is missing instead of leaving a blank space', () => {
    const { text } = validate(buildInspectionReport(input({ imageNote: 'Image not available here.' })))
    expect(text).toContain('Image not available here.')
    expect(text).not.toContain('/DCTDecode')
  })

  it('embeds the annotated image when provided', () => {
    const { text } = validate(buildInspectionReport(input({ image: { jpeg: FAKE_JPEG, width: 400, height: 300 } })))
    expect(text).toContain('/DCTDecode')
    expect(text).toContain('/Im1 Do')
  })

  it('never shows counts for a scan where no model ran', () => {
    const record = makeRecord([], {
      detection: { ...makeRecord([]).detection!, status: 'unavailable' },
    })
    const { text } = validate(buildInspectionReport(input({ record })))
    expect(text).toContain('Detection did not run')
    expect(text).toContain('NOT evidence of an empty shelf')
    expect(text).not.toContain('Shelf zones')
  })

  it('adds a comparison section framed as detections, not stock', () => {
    const base = makeRecord([dets[0]], { analysis_id: 'base1', image: { ...makeRecord().image, filename: 'before.png' } })
    const record = makeRecord(dets)
    const { text } = validate(
      buildInspectionReport(input({ record, comparison: { base, result: compareRecords(base, record) } })),
    )
    expect(text).toContain('Comparison with an earlier scan')
    expect(text).toContain('before.png')
    expect(text).toContain('(1 -> 3 \\(+2\\))')
    expect(text).toContain('not verified stock movement')
  })

  it('flows long detection lists onto further pages', () => {
    const many = Array.from({ length: 160 }, (_, i) => makeDetection(i, i % 2 ? 'bottle' : 'cup', 0.3 + (i % 70) / 100))
    const { pages, text } = validate(buildInspectionReport(input({ record: makeRecord(many) })))
    expect(pages).toBeGreaterThanOrEqual(5)
    expect(text).toContain(`Page ${pages} of ${pages}`)
  })

  it('marks recorded demo fixtures', () => {
    const { text } = validate(buildInspectionReport(input({ record: makeRecord(dets, { execution_mode: 'demo' }) })))
    expect(text).toContain('recorded demo fixture')
  })

  it('escapes hostile filenames', () => {
    const record = makeRecord(dets, { image: { ...makeRecord().image, filename: 'x) Tj (evil' } })
    const { text } = validate(buildInspectionReport(input({ record })))
    expect(text).toContain('(x\\) Tj \\(evil)')
  })
})

describe('reportFilename', () => {
  it('is safe, descriptive and dated', () => {
    const record = makeRecord(dets, {
      analysis_id: 'AbC-123-def-456',
      image: { ...makeRecord().image, filename: '../Shelf A (aisle 3).JPG' },
    })
    expect(reportFilename(record, new Date(2026, 9, 23))).toBe('visioniq-report-shelf-a-aisle-3-2026-10-23-abc123de.pdf')
  })

  it('marks comparison reports and survives empty names', () => {
    const record = makeRecord(dets, { image: { ...makeRecord().image, filename: '棚.png' } })
    const name = reportFilename(record, new Date(2026, 0, 2), makeRecord())
    expect(name).toMatch(/^visioniq-report-scan-comparison-2026-01-02-[a-z0-9]+\.pdf$/)
  })
})

/**
 * A minimal PDF 1.4 writer.
 *
 * Why hand-written: the CSP forbids 'unsafe-eval' and the project adds no
 * heavy dependencies, and a report needs only text, filled rectangles, lines
 * and JPEG images. Each of those maps directly onto a PDF operator.
 *
 * Coordinates in this API are in points with the origin at the TOP-LEFT of
 * the page (like the screen); they are flipped to PDF's bottom-left origin
 * when written. Streams are uncompressed, which keeps the file inspectable
 * and the writer small; reports stay well under a megabyte without images.
 */

import { toWinAnsi, type FontName } from './fonts'

export const A4 = { width: 595.28, height: 841.89 }

export type Rgb = readonly [number, number, number]

/** '#rrggbb' -> 0..1 components. Falls back to black on bad input. */
export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const num = (n: number) => (Math.round(n * 100) / 100).toString()
const rgb = (c: Rgb) => c.map((v) => num(Math.min(1, Math.max(0, v)))).join(' ')

/** Escape a WinAnsi string for a PDF literal string. */
export function escapePdfString(text: string): string {
  return text.replace(/[\\()]/g, (m) => `\\${m}`)
}

export interface PdfImage {
  name: string
  width: number
  height: number
  bytes: Uint8Array
}

export class PdfPage {
  readonly width: number
  readonly height: number
  private readonly ops: string[] = []
  readonly images = new Set<string>()

  constructor(width = A4.width, height = A4.height) {
    this.width = width
    this.height = height
  }

  private y(top: number): number {
    return this.height - top
  }

  /** Draw text whose BASELINE is at `top`. Text must already be WinAnsi-safe or will be converted. */
  text(
    x: number,
    top: number,
    text: string,
    opts: { size?: number; font?: FontName; color?: Rgb } = {},
  ): void {
    const size = opts.size ?? 10
    const font = opts.font === 'bold' ? 'F2' : 'F1'
    const safe = escapePdfString(toWinAnsi(text))
    this.ops.push(
      `BT /${font} ${num(size)} Tf ${rgb(opts.color ?? [0, 0, 0])} rg ${num(x)} ${num(this.y(top))} Td (${safe}) Tj ET`,
    )
  }

  rect(
    x: number,
    top: number,
    w: number,
    h: number,
    opts: { fill?: Rgb; stroke?: Rgb; lineWidth?: number } = {},
  ): void {
    if (w <= 0 || h <= 0) return
    const parts = ['q']
    if (opts.fill) parts.push(`${rgb(opts.fill)} rg`)
    if (opts.stroke) parts.push(`${rgb(opts.stroke)} RG ${num(opts.lineWidth ?? 1)} w`)
    parts.push(`${num(x)} ${num(this.y(top + h))} ${num(w)} ${num(h)} re`)
    parts.push(opts.fill && opts.stroke ? 'B' : opts.fill ? 'f' : 'S')
    parts.push('Q')
    this.ops.push(parts.join(' '))
  }

  line(x1: number, top1: number, x2: number, top2: number, opts: { color?: Rgb; width?: number } = {}): void {
    this.ops.push(
      `q ${rgb(opts.color ?? [0, 0, 0])} RG ${num(opts.width ?? 0.5)} w ${num(x1)} ${num(this.y(top1))} m ${num(x2)} ${num(this.y(top2))} l S Q`,
    )
  }

  image(image: PdfImage, x: number, top: number, w: number, h: number): void {
    this.images.add(image.name)
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.y(top + h))} cm /${image.name} Do Q`)
  }

  content(): string {
    return this.ops.join('\n')
  }
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

export class PdfDocument {
  readonly pages: PdfPage[] = []
  private readonly images: PdfImage[] = []
  private readonly info: Record<string, string>

  constructor(info: { title?: string; author?: string; subject?: string } = {}) {
    // Info dictionary keys are capitalised in the PDF spec (/Title, /Author).
    this.info = Object.fromEntries(
      Object.entries(info)
        .filter((e): e is [string, string] => typeof e[1] === 'string')
        .map(([k, v]) => [k.charAt(0).toUpperCase() + k.slice(1), v]),
    )
  }

  addPage(): PdfPage {
    const page = new PdfPage()
    this.pages.push(page)
    return page
  }

  /** Register a baseline JPEG. Bytes are embedded unchanged (DCTDecode). */
  addJpeg(bytes: Uint8Array, width: number, height: number): PdfImage {
    const image = { name: `Im${this.images.length + 1}`, width, height, bytes }
    this.images.push(image)
    return image
  }

  toBytes(): Uint8Array {
    if (this.pages.length === 0) this.addPage()

    // Object numbering: 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then images,
    // then for each page a page object and its content stream.
    const chunks: Uint8Array[] = []
    const offsets: number[] = []
    let length = 0
    const write = (data: string | Uint8Array) => {
      const bytes = typeof data === 'string' ? latin1(data) : data
      chunks.push(bytes)
      length += bytes.length
    }
    const begin = (id: number) => {
      offsets[id] = length
      write(`${id} 0 obj\n`)
    }

    const imageBase = 6
    const pageBase = imageBase + this.images.length
    const pageIds = this.pages.map((_, i) => pageBase + i * 2)
    const imageId = new Map(this.images.map((img, i) => [img.name, imageBase + i]))

    // Header with a binary comment line, as the spec recommends.
    write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')

    begin(1)
    write('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
    begin(2)
    write(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${this.pages.length} >>\nendobj\n`)
    begin(3)
    write('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n')
    begin(4)
    write('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n')
    begin(5)
    const infoEntries = Object.entries({ Producer: 'VisionIQ', ...this.info })
      .map(([k, v]) => `/${k} (${escapePdfString(toWinAnsi(v))})`)
      .join(' ')
    write(`<< ${infoEntries} >>\nendobj\n`)

    this.images.forEach((img, i) => {
      begin(imageBase + i)
      write(
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
      )
      write(img.bytes)
      write('\nendstream\nendobj\n')
    })

    this.pages.forEach((page, i) => {
      const pageId = pageIds[i]
      const contentId = pageId + 1
      const xobjects = [...page.images]
        .map((name) => `/${name} ${imageId.get(name)} 0 R`)
        .join(' ')
      begin(pageId)
      write(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> ` +
          `/Contents ${contentId} 0 R >>\nendobj\n`,
      )
      const content = latin1(page.content())
      begin(contentId)
      write(`<< /Length ${content.length} >>\nstream\n`)
      write(content)
      write('\nendstream\nendobj\n')
    })

    const size = pageBase + this.pages.length * 2
    const xref = length
    let table = `xref\n0 ${size}\n0000000000 65535 f \n`
    for (let id = 1; id < size; id++) {
      table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
    }
    write(table)
    write(`trailer\n<< /Size ${size} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

    const out = new Uint8Array(length)
    let pos = 0
    for (const c of chunks) {
      out.set(c, pos)
      pos += c.length
    }
    return out
  }
}

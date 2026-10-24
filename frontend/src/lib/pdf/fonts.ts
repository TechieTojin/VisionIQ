/**
 * Glyph widths for the two standard PDF fonts the report uses.
 *
 * Helvetica and Helvetica-Bold are among the 14 fonts every PDF reader must
 * provide, so nothing is embedded. Their widths (in 1/1000 em, from Adobe's
 * published AFM files) are needed only to measure text for wrapping and
 * right-alignment.
 *
 * Text is written in WinAnsiEncoding. `toWinAnsi` maps the few non-ASCII
 * characters the UI uses and replaces anything else, so a filename with,
 * say, CJK characters cannot corrupt the content stream.
 */

export type FontName = 'regular' | 'bold'

// Widths for codes 32..126.
// prettier-ignore
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]
// prettier-ignore
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
]

/** WinAnsi code points above 126 that the report may emit, with widths. */
const EXTRA: Record<number, number> = {
  0x85: 1000, // …
  0x95: 350, // •
  0x96: 556, // –
  0x97: 1000, // —
  0xb7: 278, // ·
  0xd7: 584, // ×
}

const UNICODE_TO_WINANSI: Record<string, string> = {
  '…': '\x85',
  '•': '\x95',
  '–': '\x96',
  '—': '\x97',
  '·': '\xb7',
  '×': '\xd7',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '≥': '>=',
  '≤': '<=',
  '→': '->',
  '←': '<-',
  '−': '-',
  ' ': ' ',
}

/** Convert arbitrary text to a string whose every char code is valid WinAnsi. */
export function toWinAnsi(text: string): string {
  let out = ''
  for (const ch of text) {
    const mapped = UNICODE_TO_WINANSI[ch]
    if (mapped !== undefined) {
      out += mapped
      continue
    }
    const code = ch.codePointAt(0) ?? 63
    if (code === 9 || code === 10 || code === 13) out += ' '
    else if (code >= 32 && code <= 126) out += ch
    // Already-converted WinAnsi characters pass through unchanged, so that
    // converting twice (e.g. fitText output drawn by PdfPage.text) is safe.
    else if (EXTRA[code] !== undefined) out += ch
    else out += '?'
  }
  return out
}

function glyphWidth(code: number, font: FontName): number {
  if (code >= 32 && code <= 126) return (font === 'bold' ? BOLD : REGULAR)[code - 32]
  return EXTRA[code] ?? 556
}

/** Width in points of already-WinAnsi text at the given size. */
export function textWidth(text: string, size: number, font: FontName = 'regular'): number {
  let units = 0
  for (let i = 0; i < text.length; i++) units += glyphWidth(text.charCodeAt(i), font)
  return (units * size) / 1000
}

/**
 * Greedy word wrap. Words longer than a line (long ids, filenames) are
 * broken by character so no line ever overflows the margin.
 */
export function wrapText(text: string, maxWidth: number, size: number, font: FontName = 'regular'): string[] {
  const words = toWinAnsi(text).split(/ +/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  const push = (w: string) => {
    const candidate = line ? `${line} ${w}` : w
    if (textWidth(candidate, size, font) <= maxWidth) {
      line = candidate
      return
    }
    if (line) lines.push(line)
    line = ''
    if (textWidth(w, size, font) <= maxWidth) {
      line = w
      return
    }
    let chunk = ''
    for (const ch of w) {
      if (textWidth(chunk + ch, size, font) > maxWidth && chunk) {
        lines.push(chunk)
        chunk = ''
      }
      chunk += ch
    }
    line = chunk
  }
  for (const w of words) push(w)
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

/** Truncate to fit, with an ellipsis. */
export function fitText(text: string, maxWidth: number, size: number, font: FontName = 'regular'): string {
  const t = toWinAnsi(text)
  if (textWidth(t, size, font) <= maxWidth) return t
  let out = t
  while (out.length > 1 && textWidth(`${out}\x85`, size, font) > maxWidth) out = out.slice(0, -1)
  return `${out}\x85`
}

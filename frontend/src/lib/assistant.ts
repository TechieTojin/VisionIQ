/**
 * Ask VisionIQ — a deterministic question-answering engine over scan data.
 *
 * NOT a language model. A question is matched against a fixed set of
 * intents with keyword rules; parameters (date range, category, confidence,
 * scan names) are extracted with patterns; the answer is COMPUTED from the
 * stored records by the same `lib/analytics` functions the dashboard uses.
 *
 * Consequences, by design:
 *   * Nothing is generated or guessed. An unknown question gets an
 *     "unsupported" answer listing what can be asked.
 *   * There is no query language and nothing is executed: user text is
 *     only ever compared against patterns, so "prompt injection" has
 *     nothing to inject into.
 *   * Questions the data cannot answer (stock, sales, SKUs, causes) are
 *     declined with the reason, never approximated.
 */

import type { AnalysisRecord } from '../types'
import {
  compareRecords,
  inspectionAlerts,
  isSuccessfulAnalysis,
  LOW_CONFIDENCE,
  scanOutcome,
  sortNewestFirst,
  summarizeDetections,
} from './analytics'
import { href } from './router'
import { zoneStats, type Zone } from './zones'

export const MAX_QUESTION_LENGTH = 300

export type IntentName =
  | 'count_detections'
  | 'count_scans'
  | 'top_category'
  | 'low_confidence'
  | 'compare'
  | 'scans_with'
  | 'zones'
  | 'avg_confidence'
  | 'summary'
  | 'review'
  | 'failed'

export interface Evidence {
  label: string
  href: string
}

export interface Answer {
  kind: 'answer' | 'clarify' | 'unsupported'
  intent: IntentName | null
  title: string
  text: string
  details?: string[]
  bars?: { label: string; value: number; detail?: string }[]
  table?: { columns: string[]; rows: (string | number)[][] }
  evidence: Evidence[]
  scope: { range: string; scans: number; source: string; note?: string }
  suggestions?: string[]
}

export interface AssistantContext {
  records: readonly AnalysisRecord[]
  now: Date
  zones: readonly Zone[]
  source: string
  truncated?: boolean
}

export const SUGGESTED_QUESTIONS = [
  'How many objects were detected today?',
  'Which category appears most frequently?',
  'Which scans have low-confidence detections?',
  'What changed between the last two scans?',
  'Show scans containing bottles',
  'Which shelf zones contain the most detections?',
  'What is the average confidence for the latest scan?',
  'Summarize the last 7 days',
  'Which scans should be reviewed?',
]

// -- parsing ----------------------------------------------------------------

export interface DateWindow {
  label: string
  start: Date | null
  end: Date
  /** Timeline `range` param when one matches exactly. */
  rangeParam?: string
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, ninety: 90,
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function normalize(question: string): string {
  return question
    .slice(0, MAX_QUESTION_LENGTH)
    .toLowerCase()
    .replace(/[“”"'`]/g, '')
    .replace(/[^a-z0-9%.\s_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseWindow(q: string, now: Date): DateWindow | null {
  const today = startOfDay(now)
  if (/\btoday\b/.test(q)) return { label: 'today', start: today, end: now }
  if (/\byesterday\b/.test(q)) {
    const start = new Date(today.getTime() - 86_400_000)
    return { label: 'yesterday', start, end: today }
  }
  if (/\b(last|past) 24 hours\b/.test(q)) {
    return { label: 'the last 24 hours', start: new Date(now.getTime() - 86_400_000), end: now, rangeParam: '24h' }
  }
  if (/\bthis week\b/.test(q)) {
    const start = new Date(today.getTime() - ((today.getDay() + 6) % 7) * 86_400_000)
    return { label: 'this week', start, end: now }
  }
  if (/\bthis month\b/.test(q)) return { label: 'this month', start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }
  const m = /\b(?:last|past|previous|recent) (\d{1,3}|[a-z]+) (day|days|week|weeks|month|months)\b/.exec(q)
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]]
    if (n && n > 0) {
      const unit = m[2].startsWith('day') ? 1 : m[2].startsWith('week') ? 7 : 30
      const days = n * unit
      const rangeParam = days === 7 ? '7d' : days === 30 ? '30d' : undefined
      return { label: `the last ${n} ${m[2]}`, start: new Date(now.getTime() - days * 86_400_000), end: now, rangeParam }
    }
  }
  if (/\b(last|past) (week)\b/.test(q)) {
    return { label: 'the last 7 days', start: new Date(now.getTime() - 7 * 86_400_000), end: now, rangeParam: '7d' }
  }
  if (/\b(last|past) month\b/.test(q)) {
    return { label: 'the last 30 days', start: new Date(now.getTime() - 30 * 86_400_000), end: now, rangeParam: '30d' }
  }
  if (/\b(all time|ever|overall|in total|all scans)\b/.test(q)) return { label: 'all time', start: null, end: now, rangeParam: 'all' }
  return null
}

/** COCO-80 labels, so a category that exists in the taxonomy but not in the data gets an honest zero. */
const COCO = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
  'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard',
  'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase',
  'scissors', 'teddy bear', 'hair drier', 'toothbrush',
]

function variants(label: string): string[] {
  const out = [label]
  if (label.endsWith('y')) out.push(`${label.slice(0, -1)}ies`)
  if (/(s|sh|ch|x)$/.test(label)) out.push(`${label}es`)
  else out.push(`${label}s`)
  if (label === 'knife') out.push('knives')
  if (label === 'person') out.push('people', 'persons')
  return out
}

/** The category a question mentions: present in the data first, then COCO. */
export function parseCategory(q: string, known: readonly string[]): { label: string; inData: boolean } | null {
  const pool = [...new Set([...known, ...COCO])].sort((a, b) => b.length - a.length)
  for (const label of pool) {
    for (const v of variants(label)) {
      if (new RegExp(`(^|\\s)${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s|\\?)`).test(q)) {
        return { label, inData: known.includes(label) }
      }
    }
  }
  return null
}

export function parseThreshold(q: string): number | null {
  const pct = /(\d{1,2}(?:\.\d+)?)\s*%/.exec(q)
  if (pct) return Number(pct[1]) / 100
  const frac = /\b(?:below|under|less than)\s+(0?\.\d+)\b/.exec(q)
  return frac ? Number(frac[1]) : null
}

function findScansByName(q: string, records: readonly AnalysisRecord[]): AnalysisRecord[] {
  const hits: { r: AnalysisRecord; at: number }[] = []
  for (const r of records) {
    const name = r.image.filename.toLowerCase()
    const stem = name.replace(/\.[a-z0-9]+$/, '')
    const at = q.indexOf(name) >= 0 ? q.indexOf(name) : stem.length >= 3 ? q.search(new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)) : -1
    if (at >= 0) hits.push({ r, at })
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.r)
}

// -- intent rules --------------------------------------------------------------

const UNSUPPORTED: [RegExp, string][] = [
  [/\b(stock|inventory|out of stock|stockout|replenish|restock|on hand)\b/, 'VisionIQ counts objects the model detected in photos. It cannot know stock levels: hidden, stacked or occluded items are never counted, and a detection is not a verified product.'],
  [/\b(sales|revenue|profit|price|pricing|margin|sell)\b/, 'Scan data contains no sales or price information.'],
  [/\b(sku|brand|product name|upc|barcode)\b/, 'The model is a generic COCO detector: it sees “bottle”, not a product. SKU recognition is not supported.'],
  [/\b(planogram|compliance)\b/, 'There is no planogram on record to check compliance against.'],
  [/\b(forecast|predict|will .* next|tomorrow)\b/, 'Forecasting is not supported; answers describe stored scans only.'],
  [/^why\b|\bwhy (did|is|are|was|were)\b/, 'Causes cannot be determined from detection data alone — lighting, angle, occlusion and real changes all move the numbers.'],
]

export function detectIntent(q: string): IntentName | null {
  if (/\b(compare|changed|change between|difference|differ|versus|vs)\b/.test(q)) return 'compare'
  if (/\b(review|reviewed|reviewing|attention|look at|problems?|issues?|flagged)\b/.test(q)) return 'review'
  if (/\b(fail|failed|failure|errors?|unavailable|did not run)\b/.test(q)) return 'failed'
  if (/\b(low[- ]?confidence|uncertain|unsure|below \d|under \d|less than \d)/.test(q)) return 'low_confidence'
  if (/\b(zones?|top shelf|middle shelf|bottom shelf|which shelf)\b/.test(q)) return 'zones'
  if (/\b(average|mean|avg)\b/.test(q) && /\bconfiden/.test(q)) return 'avg_confidence'
  if (/\b(most (frequent|common|detected|often)|top categor|which categor|appears most|most of)\b/.test(q)) return 'top_category'
  if (/\b(summar|overview|recap|what happened)/.test(q)) return 'summary'
  if (/\b(show|find|list|which scans|scans (with|containing|that contain))\b/.test(q)) return 'scans_with'
  if (/\b(how many|count|number of|total)\b/.test(q)) {
    return /\b(scans?|photos?|images?|analyses)\b/.test(q) && !/\b(objects?|detections?|items?|things)\b/.test(q)
      ? 'count_scans'
      : 'count_detections'
  }
  return null
}

// -- execution ---------------------------------------------------------------------

const pct = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)}%`)
const plural = (n: number, s: string, p = `${s}s`) => `${n.toLocaleString()} ${n === 1 ? s : p}`

function inWindow(r: AnalysisRecord, w: DateWindow): boolean {
  const t = new Date(r.created_at).getTime()
  return (w.start === null || t >= w.start.getTime()) && t <= w.end.getTime() + 60_000
}

function timelineHref(w: DateWindow, extra: Record<string, string> = {}): string {
  const params: Record<string, string> = { ...extra }
  if (w.rangeParam) params.range = w.rangeParam
  else if (w.start) {
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    params.from = key(w.start)
    params.to = key(w.end)
  }
  return href('timeline', { params })
}

function scanLinks(records: readonly AnalysisRecord[], max = 6): Evidence[] {
  return records.slice(0, max).map((r) => ({ label: r.image.filename, href: href('analyze', { id: r.analysis_id }) }))
}

export function answer(question: string, ctx: AssistantContext): Answer {
  const q = normalize(question)
  const all = sortNewestFirst(ctx.records)
  const window = parseWindow(q, ctx.now)
  const w: DateWindow = window ?? { label: 'all time', start: null, end: ctx.now, rangeParam: 'all' }
  const scoped = all.filter((r) => inWindow(r, w))
  const ok = scoped.filter(isSuccessfulAnalysis)
  const known = [...new Set(all.flatMap((r) => r.detection?.detections.map((d) => d.label) ?? []))]
  const scope = {
    range: w.label,
    scans: scoped.length,
    source: ctx.source,
    note: ctx.truncated ? 'Only the most recent 500 scans are loaded.' : undefined,
  }
  const base = { scope, evidence: [] as Evidence[] }

  if (!q) {
    return { ...base, kind: 'clarify', intent: null, title: 'Ask a question', text: 'Type a question about your scans.', suggestions: SUGGESTED_QUESTIONS.slice(0, 4) }
  }
  for (const [re, reason] of UNSUPPORTED) {
    if (re.test(q)) {
      return {
        ...base, kind: 'unsupported', intent: null, title: 'Not something the scan data can answer',
        text: reason, suggestions: SUGGESTED_QUESTIONS.slice(0, 4),
      }
    }
  }

  const intent = detectIntent(q)
  if (!intent) {
    return {
      ...base, kind: 'unsupported', intent: null, title: 'I don’t recognise that question',
      text: 'Ask VisionIQ answers a fixed set of questions about detections, categories, confidence, zones, comparisons and scan health. It is a rule-based query engine, not a chatbot.',
      suggestions: SUGGESTED_QUESTIONS,
    }
  }
  if (all.length === 0) {
    return { ...base, kind: 'answer', intent, title: 'No scans yet', text: 'There are no stored scans to answer from. Analyze a shelf photo first.', evidence: [{ label: 'Analyze a photo', href: href('analyze') }] }
  }

  const category = parseCategory(q, known)
  const threshold = parseThreshold(q)

  switch (intent) {
    case 'count_scans': {
      const failed = scoped.filter((r) => ['failed', 'unavailable'].includes(scanOutcome(r))).length
      return {
        ...base, kind: 'answer', intent, title: plural(scoped.length, 'scan'),
        text: `${plural(scoped.length, 'scan')} in ${w.label}: ${ok.length} analysed successfully${failed ? `, ${failed} failed or ran without a model` : ''}.`,
        evidence: [{ label: `Timeline · ${w.label}`, href: timelineHref(w) }],
      }
    }

    case 'count_detections': {
      if (category && !category.inData) {
        return {
          ...base, kind: 'answer', intent, title: `0 '${category.label}' detections`,
          text: `No stored scan contains a '${category.label}' detection in ${w.label}.`,
          details: known.length ? [`Categories that do appear: ${known.join(', ')}.`] : undefined,
          evidence: [{ label: `Timeline · ${w.label}`, href: timelineHref(w) }],
        }
      }
      const dets = ok.flatMap((r) => r.detection?.detections ?? []).filter((d) => !category || d.label === category.label)
      const scansWith = ok.filter((r) => r.detection?.detections.some((d) => !category || d.label === category.label))
      const what = category ? `'${category.label}' detections` : 'object detections'
      return {
        ...base, kind: 'answer', intent, title: `${dets.length.toLocaleString()} ${what}`,
        text: `The model made ${plural(dets.length, category ? `'${category.label}' detection` : 'detection')} across ${plural(ok.length, 'successful scan')} in ${w.label}${category ? ` (${scansWith.length} containing it)` : ''}.`,
        details: ['Counts are model detections, not verified inventory.'],
        evidence: [{ label: `Timeline · ${w.label}${category ? ` · ${category.label}` : ''}`, href: timelineHref(w, category ? { category: category.label } : {}) }, ...scanLinks(scansWith, 4)],
      }
    }

    case 'top_category': {
      const s = summarizeDetections(ok.flatMap((r) => r.detection?.detections ?? []))
      if (!s.categories.length) {
        return { ...base, kind: 'answer', intent, title: 'No detections', text: `No objects were detected in ${w.label}.`, evidence: [{ label: 'Timeline', href: timelineHref(w) }] }
      }
      const top = s.categories[0]
      return {
        ...base, kind: 'answer', intent, title: `'${top.label}' — ${plural(top.count, 'detection')}`,
        text: `'${top.label}' is the most frequently detected category in ${w.label}: ${plural(top.count, 'detection')}, ${pct(top.share)} of all ${s.count.toLocaleString()}.`,
        bars: s.categories.slice(0, 8).map((c) => ({ label: c.label, value: c.count, detail: pct(c.share) })),
        evidence: [{ label: `Timeline · ${top.label}`, href: timelineHref(w, { category: top.label }) }, { label: 'Dashboard categories', href: href('dashboard', { params: { range: w.rangeParam ?? 'all' } }) }],
      }
    }

    case 'low_confidence': {
      const t = threshold ?? LOW_CONFIDENCE
      const rows = ok
        .map((r) => ({ r, low: (r.detection?.detections ?? []).filter((d) => d.confidence < t) }))
        .filter((x) => x.low.length > 0)
      return {
        ...base, kind: 'answer', intent,
        title: rows.length ? plural(rows.length, 'scan') : 'None',
        text: rows.length
          ? `${plural(rows.length, 'scan')} in ${w.label} ${rows.length === 1 ? 'has' : 'have'} detections below ${pct(t)} confidence (${rows.reduce((n, x) => n + x.low.length, 0)} detections in total).`
          : `No successful scan in ${w.label} has a detection below ${pct(t)} confidence.`,
        table: rows.length ? {
          columns: ['Scan', `Below ${pct(t)}`, 'Lowest'],
          rows: rows.slice(0, 20).map(({ r, low }) => [r.image.filename, low.length, pct(Math.min(...low.map((d) => d.confidence)), 1)]),
        } : undefined,
        details: ['Confidence is the model’s own score, not a calibrated probability.'],
        evidence: [{ label: 'Timeline · needs review', href: timelineHref(w, { outcome: 'review' }) }, ...scanLinks(rows.map((x) => x.r), 5)],
      }
    }

    case 'compare': {
      let pair: AnalysisRecord[] = findScansByName(q, all).filter(isSuccessfulAnalysis)
      if (pair.length < 2 && /\b(last two|latest two|two most recent|these two|last 2|latest 2|recent two)\b/.test(q)) {
        pair = all.filter(isSuccessfulAnalysis).slice(0, 2).reverse()
      } else if (pair.length === 1 && /\b(previous|prior|before it|last one)\b/.test(q)) {
        const ordered = all.filter(isSuccessfulAnalysis)
        const i = ordered.findIndex((r) => r.analysis_id === pair[0].analysis_id)
        if (ordered[i + 1]) pair = [ordered[i + 1], pair[0]]
      }
      if (pair.length < 2) {
        const names = all.filter(isSuccessfulAnalysis).slice(0, 3).map((r) => r.image.filename)
        return {
          ...base, kind: 'clarify', intent, title: 'Which two scans?',
          text: 'Name two scans, or ask about “the last two scans”.',
          suggestions: [
            'What changed between the last two scans?',
            ...(names.length >= 2 ? [`Compare ${names[1]} and ${names[0]}`] : []),
          ],
        }
      }
      const [before, after] = pair.length > 2 ? [pair[0], pair[1]] : pair
      const c = compareRecords(before, after)
      return {
        ...base, scope: { ...scope, range: 'two scans', scans: 2 }, kind: 'answer', intent,
        title: `${c.total_before} → ${c.total_after} detections (${c.total_delta > 0 ? '+' : ''}${c.total_delta})`,
        text: `Between ${before.image.filename} and ${after.image.filename}, detections went from ${c.total_before} to ${c.total_after}. These are changes in what the model detected, not verified stock movement.`,
        table: c.categories.length ? { columns: ['Category', 'Before', 'After', 'Change'], rows: c.categories.slice(0, 12).map((d) => [d.label, d.before, d.after, d.delta > 0 ? `+${d.delta}` : String(d.delta)]) } : undefined,
        details: c.caveats,
        evidence: [{ label: 'Open comparison', href: href('compare', { params: { a: before.analysis_id, b: after.analysis_id } }) }, ...scanLinks([before, after])],
      }
    }

    case 'scans_with': {
      if (!category) {
        return {
          ...base, kind: 'clarify', intent, title: 'Which category?',
          text: 'Say which category to look for.',
          suggestions: known.slice(0, 4).map((k) => `Show scans containing ${k}`),
        }
      }
      const hits = ok.filter((r) => r.detection?.detections.some((d) => d.label === category.label))
      return {
        ...base, kind: 'answer', intent, title: plural(hits.length, 'scan'),
        text: hits.length
          ? `${plural(hits.length, 'scan')} in ${w.label} contain at least one '${category.label}' detection.`
          : `No scan in ${w.label} contains a '${category.label}' detection.`,
        table: hits.length ? {
          columns: ['Scan', `'${category.label}'`, 'All detections'],
          rows: hits.slice(0, 20).map((r) => [r.image.filename, r.detection!.detections.filter((d) => d.label === category.label).length, r.detection!.detections.length]),
        } : undefined,
        evidence: [{ label: `Timeline · ${category.label}`, href: timelineHref(w, { category: category.label }) }, ...scanLinks(hits, 5)],
      }
    }

    case 'zones': {
      const totals = new Map<string, number>()
      for (const r of ok) {
        const d = r.detection!
        for (const z of zoneStats(d.detections, ctx.zones, d.image_width, d.image_height)) {
          totals.set(z.name, (totals.get(z.name) ?? 0) + z.summary.count)
        }
      }
      const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1])
      const sum = ranked.reduce((n, [, v]) => n + v, 0)
      if (!sum) {
        return { ...base, kind: 'answer', intent, title: 'No detections', text: `No detections in ${w.label} to place in zones.`, evidence: [] }
      }
      return {
        ...base, kind: 'answer', intent, title: `${ranked[0][0]} — ${plural(ranked[0][1], 'detection')}`,
        text: `Across ${plural(ok.length, 'scan')} in ${w.label}, '${ranked[0][0]}' holds the most detections (${pct(ranked[0][1] / sum)}). Each detection counts once, in the first zone containing its box centre.`,
        bars: ranked.map(([name, v]) => ({ label: name, value: v, detail: pct(v / sum) })),
        details: ['Zones are your saved zone layout (Analyze → Zones), applied to every scan.'],
        evidence: ok[0] ? [{ label: `Zones on ${ok[0].image.filename}`, href: href('analyze', { id: ok[0].analysis_id }) }] : [],
      }
    }

    case 'avg_confidence': {
      const latest = /\b(latest|last scan|most recent|newest|last image|last photo)\b/.test(q)
      const named = findScansByName(q, all)
      const target = named[0] ?? (latest ? all.find(isSuccessfulAnalysis) : undefined)
      if (target) {
        const s = summarizeDetections(target.detection?.detections ?? [])
        return {
          ...base, scope: { ...scope, range: target.image.filename, scans: 1 }, kind: 'answer', intent,
          title: pct(s.meanConfidence, 1),
          text: s.count
            ? `Mean confidence for ${target.image.filename} is ${pct(s.meanConfidence, 1)} over ${plural(s.count, 'detection')} (range ${pct(s.minConfidence)}–${pct(s.maxConfidence)}).`
            : `${target.image.filename} has no detections, so there is no confidence to average.`,
          details: ['Confidence is the model’s own score, not accuracy.'],
          evidence: scanLinks([target]),
        }
      }
      const dets = ok.flatMap((r) => r.detection?.detections ?? []).filter((d) => !category || d.label === category.label)
      const s = summarizeDetections(dets)
      return {
        ...base, kind: 'answer', intent, title: pct(s.meanConfidence, 1),
        text: s.count
          ? `Mean confidence${category ? ` for '${category.label}'` : ''} in ${w.label} is ${pct(s.meanConfidence, 1)} over ${plural(s.count, 'detection')}.`
          : `No ${category ? `'${category.label}' ` : ''}detections in ${w.label}.`,
        details: ['Confidence is the model’s own score, not accuracy.'],
        evidence: [{ label: `Timeline · ${w.label}`, href: timelineHref(w, category ? { category: category.label } : {}) }],
      }
    }

    case 'summary': {
      const s = summarizeDetections(ok.flatMap((r) => r.detection?.detections ?? []))
      const problems = scoped.filter((r) => ['failed', 'unavailable'].includes(scanOutcome(r)))
      const alerts = inspectionAlerts(scoped)
      const details = [
        `${plural(scoped.length, 'scan')}: ${ok.length} successful, ${problems.length} failed or without a model.`,
        `${s.count.toLocaleString()} detections across ${plural(s.categories.length, 'category', 'categories')}${s.categories[0] ? `; most common '${s.categories[0].label}' (${pct(s.categories[0].share)})` : ''}.`,
        `Mean confidence ${pct(s.meanConfidence, 1)}; ${plural(s.lowConfidenceCount, 'detection')} below 50%.`,
        `${plural(alerts.length, 'derived alert')}${alerts.filter((a) => a.severity === 'critical').length ? `, ${alerts.filter((a) => a.severity === 'critical').length} critical` : ''}.`,
      ]
      return {
        ...base, kind: 'answer', intent, title: `Summary · ${w.label}`,
        text: scoped.length ? `Here is what the stored scans show for ${w.label}.` : `No scans in ${w.label}.`,
        details: scoped.length ? details : undefined,
        bars: s.categories.slice(0, 6).map((c) => ({ label: c.label, value: c.count, detail: pct(c.share) })),
        evidence: [{ label: `Timeline · ${w.label}`, href: timelineHref(w) }, { label: 'Dashboard', href: href('dashboard', { params: { range: w.rangeParam ?? 'all' } }) }],
      }
    }

    case 'review':
    case 'failed': {
      const alerts = inspectionAlerts(scoped).filter((a) => intent === 'review' || a.kind === 'failed' || a.kind === 'unavailable')
      const ids = [...new Set(alerts.map((a) => a.analysisId))]
      const recs = ids.map((id) => scoped.find((r) => r.analysis_id === id)!).filter(Boolean)
      return {
        ...base, kind: 'answer', intent,
        title: recs.length ? plural(recs.length, 'scan') : 'Nothing to review',
        text: recs.length
          ? intent === 'review'
            ? `${plural(recs.length, 'scan')} in ${w.label} ${recs.length === 1 ? 'needs' : 'need'} a look: failed or model-less runs first, then low-confidence detections.`
            : `${plural(recs.length, 'scan')} in ${w.label} failed or ran without a model. None of them is evidence of an empty shelf.`
          : intent === 'review'
            ? `No failed, model-less or low-confidence scans in ${w.label}.`
            : `No failed or model-less scans in ${w.label}.`,
        table: alerts.length ? { columns: ['Scan', 'Why', 'Severity'], rows: alerts.slice(0, 20).map((a) => [a.filename, a.title, a.severity]) } : undefined,
        evidence: [{ label: 'Timeline · flagged', href: timelineHref(w, { outcome: intent === 'review' ? 'review' : 'problem' }) }, ...scanLinks(recs, 5)],
      }
    }
  }
}

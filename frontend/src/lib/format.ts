/**
 * Display formatting. One place so every screen shows times and numbers the
 * same way.
 *
 * TIMEZONE: the backend stores UTC (ISO 8601 with an offset). Everything is
 * displayed in the viewer's local timezone, and screens that group by day
 * state which timezone that is — a scan at 23:30 UTC belongs to a different
 * calendar day in Mumbai than in London.
 */

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'
  } catch {
    return 'local time'
  }
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const dateOnly = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
})

const dayHeading = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
})

const timeOnly = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'Unknown time' : dateTime.format(d)
}

export function formatDate(date: Date): string {
  return dateOnly.format(date)
}

export function formatDayHeading(date: Date): string {
  return dayHeading.format(date)
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : timeOnly.format(d)
}

export function formatRelative(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'unknown'
  const seconds = Math.round((now.getTime() - t) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`
  const days = Math.floor(seconds / 86_400)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

export function isRecent(iso: string, now: Date = new Date(), withinMs = 24 * 3600_000): boolean {
  const t = new Date(iso).getTime()
  return !Number.isNaN(t) && now.getTime() - t <= withinMs && now.getTime() >= t - 60_000
}

/** 0.873 -> "87%". Null renders as a dash, never as 0%. */
export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

export function formatSignedPercentPoints(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return '—'
  const pp = delta * 100
  if (Math.abs(pp) < 0.05) return '±0 pp'
  return `${pp > 0 ? '+' : '−'}${Math.abs(pp).toFixed(1)} pp`
}

export function formatSigned(n: number): string {
  if (n === 0) return '±0'
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n)
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return 'Not available'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Not available'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : plural}`
}

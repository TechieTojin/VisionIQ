/**
 * Small, dependency-free charts.
 *
 * Built from HTML rather than a canvas or a chart library so they are
 * responsive with no resize logic, crisp at any zoom, reachable by keyboard
 * and legible to screen readers. Each chart takes already-computed values
 * from `lib/analytics` — none of them aggregate or invent data themselves.
 */

import { formatPercent } from '../../lib/format'
import type { HistogramBin } from '../../lib/analytics'

// ---------------------------------------------------------------------------
// BarList — horizontal ranked bars (categories, zones, sizes)
// ---------------------------------------------------------------------------

export interface BarItem {
  key: string
  label: string
  value: number
  /** Optional secondary text, e.g. a mean confidence. */
  detail?: string
  color?: string
  /** Makes the row a link to the data behind it. */
  href?: string
  onSelect?: () => void
  active?: boolean
}

export function BarList({
  items,
  label,
  formatValue = (v) => String(v),
  max,
  emptyText = 'Nothing to show.',
}: {
  items: readonly BarItem[]
  label: string
  formatValue?: (v: number) => string
  max?: number
  emptyText?: string
}) {
  if (items.length === 0) return <p className="chart-empty">{emptyText}</p>
  const top = max ?? Math.max(1, ...items.map((i) => i.value))

  return (
    <ul className="barlist" aria-label={label}>
      {items.map((item) => {
        const width = top > 0 ? Math.max(item.value > 0 ? 2 : 0, (item.value / top) * 100) : 0
        const inner = (
          <>
            <span className="barlist__row">
              <span className="barlist__label">
                {item.color && (
                  <span
                    className="barlist__swatch"
                    style={{ background: item.color }}
                    aria-hidden="true"
                  />
                )}
                {item.label}
              </span>
              <span className="barlist__value">
                {formatValue(item.value)}
                {item.detail && <span className="barlist__detail"> · {item.detail}</span>}
              </span>
            </span>
            <span className="barlist__track" aria-hidden="true">
              <span
                className="barlist__fill"
                style={{ width: `${width}%`, background: item.color }}
              />
            </span>
          </>
        )
        const cls = `barlist__item${item.active ? ' is-active' : ''}`
        return (
          <li key={item.key}>
            {item.href ? (
              <a className={cls} href={item.href}>
                {inner}
              </a>
            ) : item.onSelect ? (
              <button
                type="button"
                className={cls}
                onClick={item.onSelect}
                aria-pressed={item.active}
              >
                {inner}
              </button>
            ) : (
              <div className={cls}>{inner}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Histogram — confidence distribution, synced to the threshold
// ---------------------------------------------------------------------------

export function Histogram({
  bins,
  label,
  threshold,
  onSelectBin,
  height = 120,
  lowBelow,
}: {
  bins: readonly HistogramBin[]
  label: string
  /** Bins entirely below this are drawn dimmed; a marker shows the cut. */
  threshold?: number
  onSelectBin?: (bin: HistogramBin) => void
  height?: number
  /** Bins below this get a "low confidence" tint. */
  lowBelow?: number
}) {
  const peak = Math.max(1, ...bins.map((b) => b.count))
  const first = bins[0]?.start ?? 0
  const last = bins.at(-1)?.end ?? 1
  const span = last - first || 1
  const markerLeft =
    threshold !== undefined ? Math.min(100, Math.max(0, ((threshold - first) / span) * 100)) : null
  const total = bins.reduce((s, b) => s + b.count, 0)

  return (
    <figure className="histogram" aria-label={label}>
      <div className="histogram__plot" style={{ height }}>
        {bins.map((bin) => {
          const filtered = threshold !== undefined && bin.end <= threshold + 1e-9
          const low = lowBelow !== undefined && bin.end <= lowBelow + 1e-9
          const desc = `${formatPercent(bin.start)}–${formatPercent(bin.end)}: ${bin.count} detection${
            bin.count === 1 ? '' : 's'
          }${filtered ? ' (hidden by the current threshold)' : ''}`
          const barStyle = { height: `${(bin.count / peak) * 100}%` }
          const cls = `histogram__bar${filtered ? ' is-filtered' : ''}${low ? ' is-low' : ''}${
            bin.count === 0 ? ' is-zero' : ''
          }`
          return onSelectBin ? (
            <button
              key={bin.start}
              type="button"
              className="histogram__col"
              onClick={() => onSelectBin(bin)}
              aria-label={`${desc}. Set threshold to ${formatPercent(bin.start)}.`}
              title={desc}
            >
              <span className={cls} style={barStyle} />
            </button>
          ) : (
            <span key={bin.start} className="histogram__col" title={desc}>
              <span className={cls} style={barStyle} />
            </span>
          )
        })}
        {markerLeft !== null && (
          <span
            className="histogram__marker"
            style={{ left: `${markerLeft}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      <figcaption className="histogram__axis">
        <span>{formatPercent(first)}</span>
        <span className="histogram__axis-mid">confidence</span>
        <span>{formatPercent(last)}</span>
      </figcaption>
      <p className="sr-only">
        {label}. {total} detections across {bins.length} bins from {formatPercent(first)} to{' '}
        {formatPercent(last)}.
      </p>
    </figure>
  )
}

// ---------------------------------------------------------------------------
// ColumnChart — values over time
// ---------------------------------------------------------------------------

export interface Column {
  key: string
  label: string
  value: number
  /** Accessible / tooltip description. */
  description: string
  href?: string
}

export function ColumnChart({
  columns,
  label,
  height = 160,
  emptyText = 'No data in this range.',
}: {
  columns: readonly Column[]
  label: string
  height?: number
  emptyText?: string
}) {
  if (columns.length === 0) return <p className="chart-empty">{emptyText}</p>
  const peak = Math.max(1, ...columns.map((c) => c.value))
  // Thin axis labels so they never overlap on narrow screens.
  const every = Math.max(1, Math.ceil(columns.length / 8))

  return (
    <figure className="columns" aria-label={label}>
      <div className="columns__scale" aria-hidden="true">
        <span>{peak}</span>
        <span>0</span>
      </div>
      <div className="columns__plot" style={{ height }}>
        {columns.map((col) => {
          const bar = (
            <span
              className={`columns__bar${col.value === 0 ? ' is-zero' : ''}`}
              style={{ height: `${(col.value / peak) * 100}%` }}
            />
          )
          return col.href ? (
            <a
              key={col.key}
              className="columns__col"
              href={col.href}
              aria-label={col.description}
              title={col.description}
            >
              {bar}
            </a>
          ) : (
            <span key={col.key} className="columns__col" title={col.description}>
              {bar}
            </span>
          )
        })}
      </div>
      <div className="columns__labels" aria-hidden="true">
        {columns.map((col, i) => (
          <span key={col.key}>{i % every === 0 || i === columns.length - 1 ? col.label : ''}</span>
        ))}
      </div>
    </figure>
  )
}

// ---------------------------------------------------------------------------
// Stat — a compact label/value pair
// ---------------------------------------------------------------------------

export function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: React.ReactNode
  hint?: string
}) {
  return (
    <div className="stat" title={hint}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
    </div>
  )
}

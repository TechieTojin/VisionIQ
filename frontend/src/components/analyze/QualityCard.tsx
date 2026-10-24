import type { QualityLevel, QualityReport } from '../../api/workbench'
import { Pill } from '../ui/Page'

const TONE: Record<QualityLevel, 'ok' | 'warn' | 'error'> = { good: 'ok', warn: 'warn', poor: 'error' }
const WORD: Record<QualityLevel, string> = { good: 'Good', warn: 'Check', poor: 'Poor' }

export function QualityBadge({ level }: { level: QualityLevel }) {
  return <Pill tone={TONE[level]}>{WORD[level]}</Pill>
}

function fmt(key: string, value: number): string {
  if (key.endsWith('_clip')) return `${(value * 100).toFixed(1)}%`
  if (key === 'resolution') return `${Math.round(value)} px`
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

/** A quality report: per-metric values with their levels, issues and advice. */
export function QualityCard({ report, compact = false }: { report: QualityReport; compact?: boolean }) {
  return (
    <div className="quality">
      <div className="quality__head">
        <QualityBadge level={report.overall} />
        <span className="quality__summary">
          {report.issues.length === 0
            ? 'No capture problems detected.'
            : `${report.issues.length} capture ${report.issues.length === 1 ? 'issue' : 'issues'} — analysis still ran.`}
        </span>
        <span className="muted">
          {report.width}×{report.height} · {report.format} · {report.megapixels} MP
        </span>
      </div>
      <dl className="quality__metrics">
        {report.metrics.map((m) => (
          <div key={m.key} className={`quality__metric quality__metric--${m.level}`} title={m.detail}>
            <dt>{m.label}</dt>
            <dd>
              <span className="quality__value">{fmt(m.key, m.value)}</span>
              <span className={`quality__dot quality__dot--${m.level}`} aria-label={WORD[m.level]} />
            </dd>
            {!compact && <span className="quality__unit">{m.unit}</span>}
          </div>
        ))}
      </dl>
      {report.issues.length > 0 && (
        <ul className="quality__issues">
          {report.issues.map((i) => (
            <li key={i.key}>
              <strong>{i.message}</strong> <span className="muted">{i.suggestion}</span>
            </li>
          ))}
        </ul>
      )}
      {!compact && <p className="fineprint">{report.disclaimer}</p>}
    </div>
  )
}

import type { RuleOp, RuleParams, RuleType } from '../api/workbench'

export const RULE_TYPES: { value: RuleType; label: string; help: string }[] = [
  { value: 'scan_status', label: 'Scan failed / no model', help: 'A scan failed, ran without a model, or exceeded its time budget.' },
  { value: 'low_confidence', label: 'Low-confidence detections', help: 'At least N detections score below a confidence threshold.' },
  { value: 'category_count', label: 'Category count', help: 'The number of detections of one category compared with a value.' },
  { value: 'count_change', label: 'Count change vs previous scan', help: 'Detections changed by a percentage compared with the previous successful scan.' },
  { value: 'zone_count', label: 'Zone count', help: 'Detections whose box centre falls inside a rectangle of the image.' },
  { value: 'quality', label: 'Image quality', help: 'The image-quality inspector rated a metric warn or poor.' },
  { value: 'drift', label: 'Distribution drift', help: 'Recent scans differ statistically from a baseline window.' },
]

export const OPS: { value: RuleOp; label: string }[] = [
  { value: 'lt', label: 'fewer than' },
  { value: 'lte', label: 'at most' },
  { value: 'gt', label: 'more than' },
  { value: 'gte', label: 'at least' },
  { value: 'eq', label: 'exactly' },
]

export function defaultParams(type: RuleType): RuleParams {
  switch (type) {
    case 'scan_status':
      return { type, statuses: ['failed', 'unavailable', 'timeout'] }
    case 'low_confidence':
      return { type, threshold: 0.5, min_count: 3 }
    case 'category_count':
      return { type, label: 'bottle', op: 'lt', value: 5, min_confidence: 0 }
    case 'count_change':
      return { type, direction: 'drop', percent: 30, min_previous: 5, label: null }
    case 'zone_count':
      return { type, zone: { name: 'Bottom shelf', x0: 0, y0: 0.67, x1: 1, y1: 1 }, op: 'lt', value: 1, label: null }
    case 'quality':
      return { type, level: 'poor', metrics: ['sharpness', 'brightness', 'contrast', 'resolution'] }
    case 'drift':
      return { type, metric: 'category', comparison_days: 7, baseline_days: 30 }
  }
}

export function describeRule(p: RuleParams): string {
  switch (p.type) {
    case 'scan_status':
      return `Scan is ${p.statuses.join(', ')}`
    case 'low_confidence':
      return `${p.min_count}+ detections below ${Math.round(p.threshold * 100)}%`
    case 'category_count':
      return `'${p.label}' detections ${OPS.find((o) => o.value === p.op)?.label} ${p.value}`
    case 'count_change':
      return `${p.label ? `'${p.label}' ` : ''}detections ${p.direction === 'either' ? 'change' : p.direction} ≥ ${p.percent}% vs previous (min ${p.min_previous})`
    case 'zone_count':
      return `Zone '${p.zone.name}': ${p.label ? `'${p.label}' ` : ''}detections ${OPS.find((o) => o.value === p.op)?.label} ${p.value}`
    case 'quality':
      return `${p.metrics.join(', ')} rated ${p.level}${p.level === 'warn' ? ' or worse' : ''}`
    case 'drift':
      return `${p.metric} drift: last ${p.comparison_days}d vs previous ${p.baseline_days}d`
  }
}


import { useMemo, useState } from 'react'
import { ApiError } from '../api/client'
import {
  alerts as alertsApi,
  type AlertEvent,
  type AlertRule,
  type AlertStatus,
  type RuleInput,
  type RuleParams,
  type RuleType,
  type Severity,
} from '../api/workbench'
import { Segmented, Tabs, Toggle } from '../components/ui/Controls'
import { ConfirmDialog, LocalOnly, PageHead, Pill } from '../components/ui/Page'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/States'
import { useAsync } from '../hooks/useAsync'
import { useWorkbenchAvailable } from '../hooks/useWorkbench'
import { formatDateTime, formatRelative, pluralize } from '../lib/format'
import { href } from '../lib/router'
import { defaultParams, describeRule, OPS, RULE_TYPES } from '../lib/alertRules'

const SEV_TONE: Record<Severity, 'error' | 'warn' | 'info'> = { critical: 'error', warning: 'warn', info: 'info' }

type Tab = 'alerts' | 'rules'
type StatusFilter = 'open' | 'acknowledged' | 'resolved' | 'all'

export function AlertsPage() {
  const available = useWorkbenchAvailable()
  const [tab, setTab] = useState<Tab>('alerts')
  const list = useAsync(() => (available ? alertsApi.list() : Promise.resolve(null)), [available])
  const rules = useAsync(() => (available ? alertsApi.rules() : Promise.resolve([])), [available])
  const [evaluating, setEvaluating] = useState(false)
  const [lastEval, setLastEval] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!available) {
    return (
      <div className="page">
        <PageHead eyebrow="Alerts" title="Smart inspection alerts" />
        <LocalOnly feature="Smart inspection alerts" />
      </div>
    )
  }

  const evaluate = () => {
    setEvaluating(true)
    setError(null)
    alertsApi
      .evaluate()
      .then((r) => {
        setLastEval(
          `Evaluated ${pluralize(r.rules, 'rule')} over ${pluralize(r.scans, 'scan')} · ${r.created} new, ${r.updated} re-checked · quality known for ${r.quality_coverage}/${r.scans}`,
        )
        list.reload()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Evaluation failed.'))
      .finally(() => setEvaluating(false))
  }

  const summary = list.data?.summary

  return (
    <div className="page">
      <PageHead
        eyebrow="Alerts"
        title="Smart inspection alerts"
        subtitle="Rules you define, evaluated against real scans. Alerts describe what the model observed — never verified stock or compliance problems."
        actions={
          <button type="button" className="btn btn--primary" onClick={evaluate} disabled={evaluating}>
            {evaluating ? 'Evaluating…' : 'Evaluate now'}
          </button>
        }
      />
      {lastEval && <p className="fineprint" role="status">{lastEval}</p>}
      {error && <p className="callout callout--error" role="alert">{error}</p>}

      <section className="kpi-grid kpi-grid--compact" aria-label="Alert summary">
        <div className="kpi kpi--error"><span className="kpi__label">Open · critical</span><span className="kpi__value">{summary?.by_severity.critical ?? '—'}</span></div>
        <div className="kpi kpi--warn"><span className="kpi__label">Open · warning</span><span className="kpi__value">{summary?.by_severity.warning ?? '—'}</span></div>
        <div className="kpi"><span className="kpi__label">Open · info</span><span className="kpi__value">{summary?.by_severity.info ?? '—'}</span></div>
        <div className="kpi"><span className="kpi__label">Acknowledged</span><span className="kpi__value">{summary?.acknowledged ?? '—'}</span></div>
        <div className="kpi kpi--ok"><span className="kpi__label">Resolved</span><span className="kpi__value">{summary?.resolved ?? '—'}</span></div>
      </section>

      <section className="card">
        <Tabs<Tab>
          label="Alerts and rules"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'alerts', label: 'Alerts', badge: summary?.open },
            { value: 'rules', label: 'Rules', badge: rules.data?.length },
          ]}
        >
          {tab === 'alerts' ? (
            list.error ? (
              <ErrorState message={list.error} onRetry={list.reload} />
            ) : !list.data ? (
              <LoadingBlock rows={4} />
            ) : (
              <AlertList items={list.data.items} rules={rules.data ?? []} onChanged={list.reload} />
            )
          ) : rules.error ? (
            <ErrorState message={rules.error} onRetry={rules.reload} />
          ) : !rules.data ? (
            <LoadingBlock rows={4} />
          ) : (
            <RuleList
              rules={rules.data}
              onChanged={() => {
                rules.reload()
                list.reload()
              }}
            />
          )}
        </Tabs>
      </section>
    </div>
  )
}

function AlertList({ items, rules, onChanged }: { items: AlertEvent[]; rules: AlertRule[]; onChanged: () => void }) {
  const [status, setStatus] = useState<StatusFilter>('open')
  const [severity, setSeverity] = useState<Severity | 'all'>('all')
  const [rule, setRule] = useState('all')
  const [q, setQ] = useState('')
  const [showSuperseded, setShowSuperseded] = useState(false)

  const filtered = useMemo(
    () =>
      items.filter(
        (a) =>
          (status === 'all' || a.status === status) &&
          (severity === 'all' || a.severity === severity) &&
          (rule === 'all' || a.rule_id === rule) &&
          (showSuperseded || !a.superseded) &&
          (!q || `${a.title} ${a.filename ?? ''} ${a.reason}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [items, status, severity, rule, q, showSuperseded],
  )

  return (
    <div className="stack">
      <div className="filters filters--inline">
        <Segmented<StatusFilter>
          label="Status"
          size="sm"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'acknowledged', label: 'Acknowledged' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'all', label: 'All' },
          ]}
        />
        <label className="field">
          <span>Severity</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity | 'all')}>
            <option value="all">All severities</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label className="field">
          <span>Rule</span>
          <select value={rule} onChange={(e) => setRule(e.target.value)}>
            <option value="all">All rules</option>
            {rules.map((r) => (
              <option key={r.rule_id} value={r.rule_id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--grow">
          <span>Search</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, file or reason" />
        </label>
        <Toggle label="Include superseded" checked={showSuperseded} onChange={setShowSuperseded} />
      </div>

      {filtered.length === 0 ? (
        <EmptyState title={items.length ? 'No alerts match' : 'No alerts yet'} compact icon="✓">
          {items.length
            ? 'Change the filters to see other alerts.'
            : 'Alerts appear when a rule matches a real scan. Run “Evaluate now”, or analyze a photo — new scans are evaluated automatically.'}
        </EmptyState>
      ) : (
        <ul className="alert-list">
          {filtered.map((a) => (
            <AlertRow key={a.alert_id} a={a} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </div>
  )
}

function AlertRow({ a, onChanged }: { a: AlertEvent; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(a.note)
  const [open, setOpen] = useState(false)
  const set = (status: AlertStatus) => {
    setBusy(true)
    alertsApi
      .update(a.alert_id, status, note)
      .then(onChanged)
      .finally(() => setBusy(false))
  }
  return (
    <li className={`alert-item alert-item--${a.severity}${a.status !== 'open' ? ' is-handled' : ''}`}>
      <div className="alert-item__main">
        <div className="alert-item__title">
          <Pill tone={SEV_TONE[a.severity]}>{a.severity}</Pill>
          <strong>{a.title}</strong>
          {a.status !== 'open' && <Pill tone={a.status === 'resolved' ? 'ok' : 'neutral'}>{a.status}</Pill>}
          {a.superseded && <Pill title="The rule was changed after this alert was raised">superseded</Pill>}
          {!a.condition_active && !a.superseded && <Pill title="On the last evaluation this condition no longer matched">no longer matching</Pill>}
          {a.rule_deleted && <Pill>rule deleted</Pill>}
        </div>
        <p className="alert-item__reason">{a.reason}</p>
        <div className="alert-item__meta">
          <span>{a.rule_name}</span>
          {a.analysis_id ? (
            a.scan_missing ? (
              <span className="text-warn">scan {a.filename ?? a.analysis_id} was deleted</span>
            ) : (
              <a className="link" href={href('analyze', { id: a.analysis_id })}>
                {a.filename ?? 'Open scan'} →
              </a>
            )
          ) : (
            <a className="link" href={href('drift')}>Open drift monitor →</a>
          )}
          <span title={formatDateTime(a.first_seen_at)}>first seen {formatRelative(a.first_seen_at)}</span>
        </div>
        {open && (
          <label className="field alert-item__note">
            <span>Review note</span>
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="What you checked" />
          </label>
        )}
      </div>
      <div className="alert-item__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          Note
        </button>
        {a.status !== 'acknowledged' && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => set('acknowledged')}>
            Acknowledge
          </button>
        )}
        {a.status !== 'resolved' && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => set('resolved')}>
            Resolve
          </button>
        )}
        {a.status !== 'open' && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => set('open')}>
            Reopen
          </button>
        )}
      </div>
    </li>
  )
}

function RuleList({ rules, onChanged }: { rules: AlertRule[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<AlertRule | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AlertRule | null>(null)
  const toggle = (r: AlertRule) =>
    alertsApi.updateRule(r.rule_id, { name: r.name, severity: r.severity, enabled: !r.enabled, params: r.params }).then(onChanged)

  return (
    <div className="stack">
      <div className="row-actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing('new')}>
          New rule
        </button>
      </div>
      <ul className="rule-list">
        {rules.map((r) => (
          <li key={r.rule_id} className={`rule-row${r.enabled ? '' : ' is-disabled'}`}>
            <div className="rule-row__main">
              <div className="rule-row__title">
                <Pill tone={SEV_TONE[r.severity]}>{r.severity}</Pill>
                <strong>{r.name}</strong>
                {r.default && <Pill>default</Pill>}
                <span className="muted">rev {r.revision}</span>
              </div>
              <p className="rule-row__desc">{describeRule(r.params)}</p>
            </div>
            <div className="rule-row__actions">
              <Toggle label="Enabled" checked={r.enabled} onChange={() => void toggle(r)} />
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(r)}>
                Edit
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDeleting(r)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {editing && (
        <RuleEditor
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            onChanged()
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete rule?"
        confirmLabel="Delete rule"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) alertsApi.deleteRule(deleting.rule_id).then(() => { setDeleting(null); onChanged() })
        }}
      >
        Alerts it already raised are kept as history and marked “rule deleted”.
      </ConfirmDialog>
    </div>
  )
}

function num(v: string, fallback: number) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function RuleEditor({ rule, onClose, onSaved }: { rule: AlertRule | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(rule?.name ?? 'New rule')
  const [severity, setSeverity] = useState<Severity>(rule?.severity ?? 'warning')
  const [params, setParams] = useState<RuleParams>(rule?.params ?? defaultParams('low_confidence'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const p = params as Record<string, unknown> & RuleParams
  const set = (patch: Record<string, unknown>) => setParams({ ...params, ...patch } as RuleParams)

  const save = () => {
    const body: RuleInput = { name, severity, enabled: rule?.enabled ?? true, params }
    setBusy(true)
    setError(null)
    ;(rule ? alertsApi.updateRule(rule.rule_id, body) : alertsApi.createRule(body))
      .then(onSaved)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not save the rule.'))
      .finally(() => setBusy(false))
  }

  return (
    <ConfirmDialog open title={rule ? 'Edit rule' : 'New alert rule'} confirmLabel="Save rule" busy={busy} onCancel={onClose} onConfirm={save}>
      <div className="form-grid">
        <label className="field field--grow">
          <span>Name</span>
          <input data-autofocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Severity</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label className="field field--grow">
          <span>Condition</span>
          <select value={params.type} onChange={(e) => setParams(defaultParams(e.target.value as RuleType))} disabled={!!rule}>
            {RULE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="fineprint">{RULE_TYPES.find((t) => t.value === params.type)?.help}</p>

      <div className="form-grid">
        {params.type === 'low_confidence' && (
          <>
            <NumberField label="Confidence below (%)" value={Math.round(params.threshold * 100)} min={1} max={99} onChange={(v) => set({ threshold: v / 100 })} />
            <NumberField label="At least N detections" value={params.min_count} min={1} max={1000} onChange={(v) => set({ min_count: v })} />
          </>
        )}
        {(params.type === 'category_count' || params.type === 'zone_count') && (
          <>
            <label className="field">
              <span>Category{params.type === 'zone_count' ? ' (optional)' : ''}</span>
              <input
                value={(p.label as string | null) ?? ''}
                maxLength={40}
                onChange={(e) => set({ label: e.target.value || (params.type === 'zone_count' ? null : '') })}
                placeholder="bottle"
              />
            </label>
            <label className="field">
              <span>Comparison</span>
              <select value={params.op} onChange={(e) => set({ op: e.target.value })}>
                {OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <NumberField label="Value" value={params.value} min={0} max={10000} onChange={(v) => set({ value: v })} />
          </>
        )}
        {params.type === 'zone_count' && (
          <>
            <label className="field">
              <span>Zone name</span>
              <input value={params.zone.name} maxLength={40} onChange={(e) => set({ zone: { ...params.zone, name: e.target.value } })} />
            </label>
            {(['x0', 'y0', 'x1', 'y1'] as const).map((k) => (
              <NumberField
                key={k}
                label={{ x0: 'Left %', y0: 'Top %', x1: 'Right %', y1: 'Bottom %' }[k]}
                value={Math.round(params.zone[k] * 100)}
                min={0}
                max={100}
                onChange={(v) => set({ zone: { ...params.zone, [k]: v / 100 } })}
              />
            ))}
          </>
        )}
        {params.type === 'count_change' && (
          <>
            <label className="field">
              <span>Direction</span>
              <select value={params.direction} onChange={(e) => set({ direction: e.target.value })}>
                <option value="drop">Drop</option>
                <option value="rise">Rise</option>
                <option value="either">Either</option>
              </select>
            </label>
            <NumberField label="By at least (%)" value={params.percent} min={1} max={1000} onChange={(v) => set({ percent: v })} />
            <NumberField label="Previous scan had at least" value={params.min_previous} min={1} max={10000} onChange={(v) => set({ min_previous: v })} />
            <label className="field">
              <span>Category (optional)</span>
              <input value={params.label ?? ''} maxLength={40} onChange={(e) => set({ label: e.target.value || null })} placeholder="all categories" />
            </label>
          </>
        )}
        {params.type === 'quality' && (
          <>
            <label className="field">
              <span>Trigger at</span>
              <select value={params.level} onChange={(e) => set({ level: e.target.value })}>
                <option value="poor">Poor only</option>
                <option value="warn">Warn or poor</option>
              </select>
            </label>
            <fieldset className="field field--grow">
              <legend>Metrics</legend>
              <div className="checks">
                {['sharpness', 'brightness', 'contrast', 'resolution', 'shadow_clip', 'highlight_clip'].map((m) => (
                  <label key={m} className="check">
                    <input
                      type="checkbox"
                      checked={params.metrics.includes(m)}
                      onChange={(e) => set({ metrics: e.target.checked ? [...params.metrics, m] : params.metrics.filter((x) => x !== m) })}
                    />
                    {m.replace('_', ' ')}
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}
        {params.type === 'scan_status' && (
          <fieldset className="field field--grow">
            <legend>Statuses</legend>
            <div className="checks">
              {(['failed', 'unavailable', 'timeout'] as const).map((s) => (
                <label key={s} className="check">
                  <input
                    type="checkbox"
                    checked={params.statuses.includes(s)}
                    onChange={(e) => set({ statuses: e.target.checked ? [...params.statuses, s] : params.statuses.filter((x) => x !== s) })}
                  />
                  {s}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {params.type === 'drift' && (
          <>
            <label className="field">
              <span>Metric</span>
              <select value={params.metric} onChange={(e) => set({ metric: e.target.value })}>
                <option value="category">Category mix</option>
                <option value="confidence">Confidence</option>
                <option value="count">Detections per scan</option>
              </select>
            </label>
            <NumberField label="Recent window (days)" value={params.comparison_days} min={1} max={90} onChange={(v) => set({ comparison_days: v })} />
            <NumberField label="Baseline window (days)" value={params.baseline_days} min={1} max={365} onChange={(v) => set({ baseline_days: v })} />
          </>
        )}
      </div>
      {rule && <p className="fineprint">Changing the condition creates a new revision; alerts raised under the old one are kept and marked superseded.</p>}
      {error && <p className="callout callout--error" role="alert">{error}</p>}
    </ConfirmDialog>
  )
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" value={value} min={min} max={max} onChange={(e) => onChange(num(e.target.value, value))} />
    </label>
  )
}

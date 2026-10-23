import type { AnalysisSummary, ComparisonResult } from '../types'

interface HistoryPanelProps {
  items: AnalysisSummary[]
  loading: boolean
  search: string
  onSearchChange: (value: string) => void
  activeId: string | null
  compareIds: string[]
  comparison: ComparisonResult | null
  hasMore: boolean
  /**
   * Demo mode: there is no backend, so comparison and deletion cannot work.
   * The controls are hidden rather than left to fail — an affordance that
   * does nothing is worse than no affordance.
   */
  readOnly?: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onToggleCompare: (id: string) => void
  onLoadMore: () => void
  onClearComparison: () => void
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export function HistoryPanel({
  items,
  loading,
  search,
  onSearchChange,
  activeId,
  compareIds,
  comparison,
  hasMore,
  readOnly = false,
  onSelect,
  onDelete,
  onToggleCompare,
  onLoadMore,
  onClearComparison,
}: HistoryPanelProps) {
  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Scan history</h2>
        <span className="muted-sm">{items.length} loaded</span>
      </div>

      <input
        className="search"
        type="search"
        placeholder="Search by filename or label…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        aria-label="Search analyses"
      />

      {compareIds.length > 0 && (
        <p className="notice">
          {compareIds.length === 1
            ? 'Select a second scan to compare.'
            : 'Comparing two scans.'}{' '}
          <button className="link-btn" onClick={onClearComparison} type="button">
            Clear
          </button>
        </p>
      )}

      {comparison && (
        <div className="comparison">
          <h3 className="subhead">
            Comparison{' '}
            {!comparison.comparable && (
              <span className="badge badge--warn">different models</span>
            )}
          </h3>
          <p className="summary">
            Total detections {comparison.total_before} → {comparison.total_after}{' '}
            <strong
              className={
                comparison.total_delta > 0
                  ? 'delta delta--up'
                  : comparison.total_delta < 0
                    ? 'delta delta--down'
                    : 'delta'
              }
            >
              ({comparison.total_delta >= 0 ? '+' : ''}
              {comparison.total_delta})
            </strong>
          </p>
          <ul className="bullets">
            {comparison.notable_changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          <p className="disclaimer">{comparison.caveats[0]}</p>
        </div>
      )}

      {loading && items.length === 0 ? (
        <p className="muted">Loading history…</p>
      ) : items.length === 0 ? (
        <p className="muted">
          {search
            ? `No scans match “${search}”.`
            : 'No scans yet. Upload a shelf image to get started.'}
        </p>
      ) : (
        <ul className="history">
          {items.map((item) => (
            <li
              key={item.analysis_id}
              className={item.analysis_id === activeId ? 'is-active' : ''}
            >
              <button
                type="button"
                className="history__main"
                onClick={() => onSelect(item.analysis_id)}
              >
                <span className="history__name" title={item.filename}>
                  {item.filename}
                </span>
                <span className="history__meta">
                  {timeAgo(item.created_at)} · {item.detection_count} detections
                  {item.status !== 'completed' && ` · ${item.status}`}
                </span>
                {item.top_labels.length > 0 && (
                  <span className="history__labels">
                    {item.top_labels.join(', ')}
                  </span>
                )}
              </button>
              {!readOnly && (
                <div className="history__actions">
                  <button
                    type="button"
                    className={`chip${
                      compareIds.includes(item.analysis_id) ? ' chip--on' : ''
                    }`}
                    onClick={() => onToggleCompare(item.analysis_id)}
                    title="Select for comparison"
                    aria-pressed={compareIds.includes(item.analysis_id)}
                  >
                    ⇄
                  </button>
                  <button
                    type="button"
                    className="chip chip--danger"
                    onClick={() => onDelete(item.analysis_id)}
                    title="Delete this analysis"
                    aria-label={`Delete ${item.filename}`}
                  >
                    ×
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {hasMore && (
        <button
          type="button"
          className="btn btn--block"
          onClick={onLoadMore}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}

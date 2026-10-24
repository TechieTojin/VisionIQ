import { useEffect, useMemo, useRef, useState } from 'react'
import { BarList } from '../components/charts/Charts'
import { Pill, PageHead } from '../components/ui/Page'
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/States'
import { useScanData } from '../data/useScanData'
import { answer, MAX_QUESTION_LENGTH, SUGGESTED_QUESTIONS, type Answer } from '../lib/assistant'
import { formatTime } from '../lib/format'
import { loadZones } from '../lib/zones'

interface Turn {
  id: number
  question: string
  askedAt: string
}

const HISTORY_KEY = 'visioniq.ask.history.v1'
const MAX_TURNS = 30

function loadHistory(): Turn[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((t): t is Turn => !!t && typeof t.question === 'string' && typeof t.askedAt === 'string' && typeof t.id === 'number')
      .slice(-MAX_TURNS)
  } catch {
    return []
  }
}

function saveHistory(turns: Turn[]) {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(turns.slice(-MAX_TURNS)))
  } catch {
    // Private mode or full storage: history just isn't kept.
  }
}

/**
 * Ask VisionIQ. Questions are kept in this browser; answers are NEVER stored —
 * they are recomputed from the current scan data every time they are shown,
 * so an old answer can't drift away from the data it describes.
 */
export function AskPage() {
  const data = useScanData()
  const [turns, setTurns] = useState<Turn[]>(() => loadHistory())
  const [draft, setDraft] = useState('')
  const now = useMemo(() => new Date(), [])
  const zones = useMemo(() => loadZones(), [])
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const ctx = useMemo(
    () => ({
      records: data.records,
      now,
      zones,
      source: data.source.mode === 'demo' ? 'Recorded demo scans' : data.source.mode === 'cloud' ? 'Stored scans (cloud API)' : 'Stored scans (local backend)',
      truncated: data.truncated,
    }),
    [data.records, data.source.mode, data.truncated, now, zones],
  )

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' })
  }, [turns.length])

  const ask = (question: string) => {
    const q = question.trim().slice(0, MAX_QUESTION_LENGTH)
    if (!q) return
    const next = [...turns, { id: Date.now(), question: q, askedAt: new Date().toISOString() }].slice(-MAX_TURNS)
    setTurns(next)
    saveHistory(next)
    setDraft('')
    inputRef.current?.focus()
  }

  const clear = () => {
    setTurns([])
    saveHistory([])
  }

  const ready = data.status === 'ready' && !data.recordsLoading

  return (
    <div className="page">
      <PageHead
        eyebrow="Ask VisionIQ"
        title="Ask your scan data"
        subtitle="Answers are computed from stored scans by a rule-based query engine — not a generative model. Every answer shows its scope and links to the evidence."
        badge={<Pill tone="accent">Rule-based · no LLM</Pill>}
        actions={
          turns.length > 0 && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={clear}>
              Clear history
            </button>
          )
        }
      />

      <div className="ask">
        <section className="card ask__chat" aria-label="Conversation">
          {data.status === 'error' ? (
            <ErrorState message={data.error ?? 'Scans could not be loaded.'} onRetry={data.refresh} />
          ) : !ready ? (
            <LoadingBlock rows={3} label="Loading scan data…" />
          ) : turns.length === 0 ? (
            <EmptyState title="Ask about your scans" icon="?">
              Try one of the suggestions — for example “Which category appears most frequently?”. Answers use{' '}
              {data.records.length} stored {data.records.length === 1 ? 'scan' : 'scans'}.
            </EmptyState>
          ) : (
            <ol className="ask__turns" aria-live="polite">
              {turns.map((t) => (
                <li key={t.id} className="ask__turn">
                  <div className="ask__q">
                    <span className="sr-only">You asked: </span>
                    {t.question}
                    <time className="ask__time">{formatTime(t.askedAt)}</time>
                  </div>
                  <AnswerCard a={answer(t.question, ctx)} onAsk={ask} />
                </li>
              ))}
            </ol>
          )}
          <div ref={endRef} />

          <form
            className="ask__composer"
            onSubmit={(e) => {
              e.preventDefault()
              ask(draft)
            }}
          >
            <label htmlFor="ask-input" className="sr-only">
              Question
            </label>
            <textarea
              id="ask-input"
              ref={inputRef}
              rows={1}
              value={draft}
              maxLength={MAX_QUESTION_LENGTH}
              placeholder="e.g. How many bottles were detected in the last 7 days?"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  ask(draft)
                }
              }}
              disabled={!ready}
            />
            <span className="ask__count" aria-hidden="true">
              {draft.length}/{MAX_QUESTION_LENGTH}
            </span>
            <button type="submit" className="btn btn--primary" disabled={!ready || !draft.trim()}>
              Ask
            </button>
          </form>
        </section>

        <aside className="ask__side">
          <section className="card">
            <h2 className="card__title">Suggested questions</h2>
            <ul className="suggestions">
              {SUGGESTED_QUESTIONS.map((s) => (
                <li key={s}>
                  <button type="button" className="suggestion" onClick={() => ask(s)} disabled={!ready}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2 className="card__title">What it can and can’t answer</h2>
            <ul className="bullets">
              <li>Detection counts, categories, confidence, zones, comparisons and scan health — over any date range.</li>
              <li>Not stock, sales, SKUs, planograms, forecasts or causes. Those questions are declined with the reason.</li>
              <li>Your text is only matched against fixed patterns. Nothing is executed and nothing is sent anywhere.</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}

const KIND_LABEL: Record<Answer['kind'], string> = {
  answer: 'Computed answer',
  clarify: 'Needs clarification',
  unsupported: 'Not supported',
}

function AnswerCard({ a, onAsk }: { a: Answer; onAsk: (q: string) => void }) {
  return (
    <article className={`answer answer--${a.kind}`}>
      <header className="answer__head">
        <span className={`answer__kind answer__kind--${a.kind}`}>{KIND_LABEL[a.kind]}</span>
        <h3 className="answer__title">{a.title}</h3>
      </header>
      <p className="answer__text">{a.text}</p>
      {a.bars && a.bars.length > 0 && (
        <BarList label={a.title} items={a.bars.map((b) => ({ key: b.label, label: b.label, value: b.value, detail: b.detail }))} />
      )}
      {a.table && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {a.table.columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {a.table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className={typeof cell === 'number' ? 'num' : undefined}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {a.details && (
        <ul className="bullets bullets--muted">
          {a.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {a.suggestions && (
        <div className="chips">
          {a.suggestions.map((s) => (
            <button key={s} type="button" className="chip-btn" onClick={() => onAsk(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <footer className="answer__foot">
        {a.evidence.length > 0 && (
          <div className="answer__evidence">
            <span className="answer__label">Evidence</span>
            {a.evidence.map((e) => (
              <a key={e.href + e.label} className="evidence-link" href={e.href}>
                {e.label}
              </a>
            ))}
          </div>
        )}
        <p className="answer__scope">
          Scope: {a.scope.range} · {a.scope.scans} {a.scope.scans === 1 ? 'scan' : 'scans'} · {a.scope.source}
          {a.scope.note && ` · ${a.scope.note}`}
        </p>
      </footer>
    </article>
  )
}

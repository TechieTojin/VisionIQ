import { useEffect, useRef, useState } from 'react'
import { jobsApi, TERMINAL_JOB, type WorkbenchJob } from '../../api/workbench'
import { useJob } from '../../hooks/useJob'
import { formatRelative } from '../../lib/format'
import { Pill, ProgressBar } from './Page'

const TONE = {
  running: 'accent',
  cancelling: 'warn',
  completed: 'ok',
  failed: 'error',
  cancelled: 'neutral',
  interrupted: 'warn',
} as const

/** Live status of one heavy job, with honest cancellation wording. */
export function JobPanel({
  jobId,
  onDone,
  cancelNote,
}: {
  jobId: string
  onDone?: (job: WorkbenchJob) => void
  cancelNote: string
}) {
  const job = useJob(jobId)
  const [cancelling, setCancelling] = useState(false)
  const reported = useRef<string | null>(null)

  useEffect(() => {
    if (job && TERMINAL_JOB.has(job.status) && reported.current !== job.job_id) {
      reported.current = job.job_id
      onDone?.(job)
    }
  }, [job, onDone])

  if (!job) return <p className="note">Starting job…</p>
  const terminal = TERMINAL_JOB.has(job.status)
  return (
    <div className={`job job--${job.status}`} role="status" aria-live="polite">
      <div className="job__head">
        <Pill tone={TONE[job.status]}>{job.status}</Pill>
        <span className="job__msg">{job.progress?.message}</span>
        <span className="muted">started {formatRelative(job.created_at)}</span>
      </div>
      {!terminal && <ProgressBar value={job.progress?.done ?? 0} max={job.progress?.total ?? 0} label={`${job.kind} progress`} />}
      {job.cancel_message && <p className="fineprint">{job.cancel_message}</p>}
      {job.error && <p className="callout callout--error">{job.error}</p>}
      {!terminal && (
        <div className="row-actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={cancelling || job.status === 'cancelling'}
            onClick={() => {
              setCancelling(true)
              jobsApi.cancel(job.job_id).finally(() => setCancelling(false))
            }}
          >
            {job.status === 'cancelling' ? 'Cancelling…' : 'Cancel'}
          </button>
          <span className="fineprint">{cancelNote}</span>
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { jobsApi, TERMINAL_JOB, type WorkbenchJob } from '../api/workbench'

/** Poll a workbench job until it reaches a terminal state. */
export function useJob(jobId: string | null, intervalMs = 1000): WorkbenchJob | null {
  const [job, setJob] = useState<WorkbenchJob | null>(null)

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      jobsApi.get(jobId).then(
        (j) => {
          if (cancelled) return
          setJob(j)
          if (!TERMINAL_JOB.has(j.status)) timer = setTimeout(tick, intervalMs)
        },
        () => {
          if (!cancelled) timer = setTimeout(tick, intervalMs * 3)
        },
      )
    }
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [jobId, intervalMs])

  return job && job.job_id === jobId ? job : null
}

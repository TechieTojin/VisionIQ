import { useState } from 'react'
import { createReport, downloadBytes } from '../lib/pdf/export'
import type { Zone } from '../lib/zones'
import type { AnalysisRecord } from '../types'
import { useScanData } from '../data/useScanData'

/**
 * Generates the PDF entirely in the browser — no upload, no server, no cost —
 * and downloads it.
 */
export function ReportButton({
  record,
  imageUrl,
  threshold,
  zones,
  colors,
  base,
  label = 'Export PDF',
  className = 'btn btn--ghost',
}: {
  record: AnalysisRecord
  imageUrl: string | null
  threshold: number
  zones: readonly Zone[]
  colors: Record<string, string>
  base?: AnalysisRecord | null
  label?: string
  className?: string
}) {
  const { source } = useScanData()
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle')

  const run = () => {
    setState('busy')
    createReport({
      record,
      imageUrl,
      imageUnavailableReason:
        source.mode === 'cloud'
          ? 'Images are not served to the dashboard in cloud mode, so none is embedded. All detection data below is complete.'
          : undefined,
      threshold,
      zones,
      colors,
      base,
    })
      .then(({ bytes, filename }) => {
        downloadBytes(bytes, filename)
        setState('idle')
      })
      .catch(() => setState('error'))
  }

  return (
    <>
      <button type="button" className={className} onClick={run} disabled={state === 'busy'} aria-busy={state === 'busy'}>
        {state === 'busy' ? 'Building PDF…' : label}
      </button>
      {state === 'error' && (
        <span className="text-error" role="alert">
          The report could not be generated.
        </span>
      )}
    </>
  )
}

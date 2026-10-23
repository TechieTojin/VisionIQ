import { DEMO_SAMPLES, type DemoSample } from '../demo/demoData'

/**
 * The demo-mode banner.
 *
 * Deliberately prominent and unambiguous. A viewer must not be able to come
 * away believing they watched live inference. It states three things: these
 * are recordings, they came from a real model run, and here is how to get
 * live inference.
 */
export function DemoBanner({ modelName }: { modelName?: string }) {
  return (
    <aside className="demo-banner" role="note">
      <span className="demo-banner__tag">Demo</span>
      <p>
        <strong>These are pre-recorded results, not live inference.</strong>{' '}
        Every box and score below came from a real{' '}
        {modelName ? <code>{modelName}</code> : 'YOLOv8n'} run captured on a
        developer machine — nothing here is invented — but this deployment has
        no model running, so it cannot analyse new images. Run it locally for
        real detection on your own photos — see the README for setup.
      </p>
    </aside>
  )
}

interface SamplePickerProps {
  activeId: string | null
  busy: boolean
  onPick: (sample: DemoSample) => void
}

/**
 * Replaces the upload dropzone in demo mode.
 *
 * There is no file input at all: offering one would imply the app can
 * analyse an arbitrary image, which it cannot without a backend.
 */
export function SamplePicker({ activeId, busy, onPick }: SamplePickerProps) {
  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Sample analyses</h2>
        <span className="muted-sm">{DEMO_SAMPLES.length} recorded</span>
      </div>
      <p className="muted">
        Choose a sample to see what VisionIQ produced for it. Uploading is
        disabled here because no inference backend is deployed.
      </p>
      <ul className="samples">
        {DEMO_SAMPLES.map((sample) => {
          const count = sample.record.retail?.total_detections ?? 0
          return (
            <li key={sample.id}>
              <button
                type="button"
                className={`samples__item${
                  activeId === sample.record.analysis_id ? ' is-active' : ''
                }`}
                onClick={() => onPick(sample)}
                disabled={busy}
              >
                <img src={sample.image_url} alt="" loading="lazy" />
                <span className="samples__meta">
                  <span className="samples__name">{sample.filename}</span>
                  <span className="samples__caption">{sample.caption}</span>
                  <span className="samples__count">
                    {count === 0
                      ? 'No objects above the confidence threshold'
                      : `${count} detection${count === 1 ? '' : 's'}`}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

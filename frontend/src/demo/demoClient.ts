/**
 * Demo transport: replays pre-recorded analyses. No network, no backend.
 *
 * It implements the same `AnalysisClient` interface as the local and cloud
 * clients so the dashboard needs no special-casing — but it deliberately
 * refuses to analyse a user-supplied file. See demoData.ts for why.
 */

import {
  registerDemoClientFactory,
  type AnalysisClient,
  type AnalysisProgress,
} from '../api/analysisClient'
import { ApiError } from '../api/client'
import type { AnalysisRecord } from '../types'
import { DEMO_SAMPLES, getDemoSample } from './demoData'

/** Brief, so the UI transitions feel real without wasting the viewer's time. */
const REPLAY_DELAY_MS = 450

export class DemoAnalysisClient implements AnalysisClient {
  readonly mode = 'demo' as const

  /**
   * Always rejects.
   *
   * There is no model here. Returning a canned result for a file the user
   * chose would read as "we analysed your image", which is false. The UI
   * offers the sample picker instead.
   */
  async analyze(): Promise<AnalysisRecord> {
    throw new ApiError(
      'This is a demo deployment with no inference backend, so your own ' +
        'images cannot be analysed here. Pick one of the sample results ' +
        'below, or run VisionIQ locally for real detection.',
      'demo_mode',
    )
  }

  /** Replay a recorded sample, with a short delay so the UI shows its states. */
  async replay(
    sampleId: string,
    onProgress?: (progress: AnalysisProgress) => void,
  ): Promise<AnalysisRecord> {
    const sample = getDemoSample(sampleId) ?? DEMO_SAMPLES[0]
    if (!sample) {
      throw new ApiError('No demo samples are bundled.', 'demo_mode')
    }

    onProgress?.({ percent: 100, stage: 'processing' })
    await new Promise((resolve) => setTimeout(resolve, REPLAY_DELAY_MS))
    onProgress?.({ percent: 100, stage: 'done', status: sample.record.status })

    return sample.record
  }
}

// Let the shared factory return a real DemoAnalysisClient without importing
// this module (which would pull the fixture into every bundle path).
registerDemoClientFactory(() => new DemoAnalysisClient())

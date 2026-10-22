import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { InsightsPanel } from './InsightsPanel'
import { makeRecord } from '../test/fixtures'

const base = makeRecord()

describe('InsightsPanel', () => {
  it('labels deterministic summaries as such', () => {
    render(<InsightsPanel insights={base.insights!} retail={base.retail!} />)
    expect(screen.getByText('Deterministic')).toBeInTheDocument()
  })

  it('labels LLM output distinctly from deterministic output', () => {
    render(
      <InsightsPanel
        insights={{ ...base.insights!, source: 'bedrock' }}
        retail={base.retail!}
      />,
    )
    expect(screen.getByText('AI generated')).toBeInTheDocument()
  })

  it('warns when the AI narrator degraded to rules', () => {
    render(
      <InsightsPanel
        insights={{ ...base.insights!, degraded: true }}
        retail={base.retail!}
      />,
    )
    expect(screen.getByText(/AI narrator was unavailable/)).toBeInTheDocument()
  })

  it('always shows the "not verified inventory" disclaimer', () => {
    render(<InsightsPanel insights={base.insights!} retail={base.retail!} />)
    expect(screen.getByText(/Not verified inventory data/)).toBeInTheDocument()
  })

  it('surfaces SKU recognition as unsupported rather than hiding it', () => {
    render(<InsightsPanel insights={base.insights!} retail={base.retail!} />)
    expect(screen.getByText('SKU recognition')).toBeInTheDocument()
    // Both SKU and shelf-gap report "unsupported".
    expect(screen.getAllByText('unsupported').length).toBeGreaterThanOrEqual(2)
  })

  it('shows occupancy as unavailable when it could not be estimated', () => {
    render(<InsightsPanel insights={base.insights!} retail={base.retail!} />)
    expect(screen.getByText('not available')).toBeInTheDocument()
  })

  it('shows an occupancy percentage with its reliability tag', () => {
    render(
      <InsightsPanel
        insights={base.insights!}
        retail={{
          ...base.retail!,
          occupancy: {
            reliability: 'estimated',
            covered_fraction: 0.42,
            note: 'heuristic',
          },
        }}
      />,
    )
    expect(screen.getByText(/42%/)).toBeInTheDocument()
    expect(screen.getByText('estimated')).toBeInTheDocument()
  })

  it('lists limitations behind a disclosure', () => {
    render(<InsightsPanel insights={base.insights!} retail={base.retail!} />)
    expect(screen.getByText(/Limitations \(1\)/)).toBeInTheDocument()
  })
})

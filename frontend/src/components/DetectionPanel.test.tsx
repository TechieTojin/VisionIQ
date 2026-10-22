import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DetectionPanel } from './DetectionPanel'
import { makeDetection, makeDetectionResult } from '../test/fixtures'
import { buildColorMap } from '../utils/colors'

const all = [
  makeDetection(0, 'bottle', 0.92),
  makeDetection(1, 'bottle', 0.81),
  makeDetection(2, 'cup', 0.33),
]

const categories = [
  {
    label: 'bottle',
    count: 2,
    mean_confidence: 0.865,
    min_confidence: 0.81,
    max_confidence: 0.92,
  },
  {
    label: 'cup',
    count: 1,
    mean_confidence: 0.33,
    min_confidence: 0.33,
    max_confidence: 0.33,
  },
]

function renderPanel(props: Partial<Parameters<typeof DetectionPanel>[0]> = {}) {
  return render(
    <DetectionPanel
      detection={makeDetectionResult(all)}
      categories={categories}
      visible={all}
      colors={buildColorMap(['bottle', 'cup'])}
      minConfidence={0}
      onMinConfidenceChange={() => {}}
      showBoxes
      onToggleBoxes={() => {}}
      selectedId={null}
      onSelect={() => {}}
      {...props}
    />,
  )
}

describe('DetectionPanel', () => {
  it('lists every visible detection with its confidence', () => {
    renderPanel()
    expect(screen.getByText('92%')).toBeInTheDocument()
    expect(screen.getByText('81%')).toBeInTheDocument()
    expect(screen.getByText('33%')).toBeInTheDocument()
  })

  it('shows the category breakdown with counts', () => {
    const { container } = renderPanel()
    // Scope to the breakdown: labels also appear in the detection rows below.
    const rows = container.querySelectorAll('.categories li')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('bottle')
    expect(rows[0]).toHaveTextContent('2')
    expect(rows[1]).toHaveTextContent('cup')
  })

  it('marks low-confidence detections visually', () => {
    const { container } = renderPanel()
    // 0.33 is below the 50% review threshold.
    expect(container.querySelectorAll('.conf--low')).toHaveLength(1)
  })

  it('reports how many detections the filter is hiding', () => {
    renderPanel({ visible: all.slice(0, 2), minConfidence: 0.5 })
    expect(screen.getByText(/2 shown/)).toBeInTheDocument()
    expect(screen.getByText(/1 filtered/)).toBeInTheDocument()
  })

  it('explains an empty filtered result rather than looking broken', () => {
    renderPanel({ visible: [], minConfidence: 0.99 })
    expect(screen.getByText(/Lower the threshold/)).toBeInTheDocument()
  })

  it('distinguishes "no objects detected" from "all filtered out"', () => {
    renderPanel({
      detection: makeDetectionResult([]),
      visible: [],
      categories: [],
    })
    expect(screen.getByText(/No objects were detected/)).toBeInTheDocument()
  })

  it('emits confidence changes from the slider', async () => {
    const onChange = vi.fn()
    renderPanel({ onMinConfidenceChange: onChange })

    // A range input is not editable by typing; drive it with a change event.
    const slider = screen.getByLabelText('Minimum confidence filter')
    fireEvent.change(slider, { target: { value: '60' } })

    expect(onChange).toHaveBeenCalledWith(0.6)
  })

  it('toggles bounding boxes', async () => {
    const onToggle = vi.fn()
    renderPanel({ onToggleBoxes: onToggle })

    await userEvent.click(screen.getByRole('checkbox'))
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it('selects a detection when its row is clicked', async () => {
    const onSelect = vi.fn()
    renderPanel({ onSelect })

    await userEvent.click(screen.getAllByRole('button')[0])
    expect(onSelect).toHaveBeenCalledWith(0)
  })
})

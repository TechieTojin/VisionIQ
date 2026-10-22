import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AnnotatedImage } from './AnnotatedImage'
import { makeDetection } from '../test/fixtures'
import { buildColorMap } from '../utils/colors'

const detections = [
  makeDetection(0, 'bottle', 0.92, [10, 20, 60, 90]),
  makeDetection(1, 'cup', 0.44, [100, 30, 150, 110]),
]

function renderOverlay(props: Partial<Parameters<typeof AnnotatedImage>[0]> = {}) {
  return render(
    <AnnotatedImage
      src="blob:test"
      imageWidth={400}
      imageHeight={300}
      detections={detections}
      colors={buildColorMap(['bottle', 'cup'])}
      showBoxes
      selectedId={null}
      onSelect={() => {}}
      {...props}
    />,
  )
}

describe('AnnotatedImage', () => {
  it('renders the image', () => {
    renderOverlay()
    expect(screen.getByAltText('Analyzed shelf')).toBeInTheDocument()
  })

  it('uses the original image dimensions as the SVG viewBox so boxes scale', () => {
    const { container } = renderOverlay()
    const svg = container.querySelector('svg')
    // This is what makes responsive resizing correct without JS measurement.
    expect(svg).toHaveAttribute('viewBox', '0 0 400 300')
    expect(svg).toHaveAttribute('preserveAspectRatio', 'xMidYMid meet')
  })

  it('draws one box group per detection with correct coordinates', () => {
    const { container } = renderOverlay()
    const groups = container.querySelectorAll('g.box')
    expect(groups).toHaveLength(2)

    const firstRect = groups[0].querySelector('rect')
    expect(firstRect).toHaveAttribute('x', '10')
    expect(firstRect).toHaveAttribute('y', '20')
    expect(firstRect).toHaveAttribute('width', '50')
    expect(firstRect).toHaveAttribute('height', '70')
  })

  it('shows the label and rounded confidence', () => {
    renderOverlay()
    expect(screen.getByText('bottle 92%')).toBeInTheDocument()
    expect(screen.getByText('cup 44%')).toBeInTheDocument()
  })

  it('hides the overlay when boxes are toggled off', () => {
    const { container } = renderOverlay({ showBoxes: false })
    expect(container.querySelector('svg')).toBeNull()
    // The image itself must remain visible.
    expect(screen.getByAltText('Analyzed shelf')).toBeInTheDocument()
  })

  it('renders nothing but the image when there are no detections', () => {
    const { container } = renderOverlay({ detections: [] })
    expect(container.querySelectorAll('g.box')).toHaveLength(0)
    expect(screen.getByAltText('Analyzed shelf')).toBeInTheDocument()
  })

  it('calls onSelect with the detection id when a box is clicked', async () => {
    const onSelect = vi.fn()
    const { container } = renderOverlay({ onSelect })

    await userEvent.click(container.querySelectorAll('g.box')[1])
    expect(onSelect).toHaveBeenCalledWith(1)
  })

  it('deselects when the already-selected box is clicked again', async () => {
    const onSelect = vi.fn()
    const { container } = renderOverlay({ onSelect, selectedId: 0 })

    await userEvent.click(container.querySelectorAll('g.box')[0])
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('dims unselected boxes when one is selected', () => {
    const { container } = renderOverlay({ selectedId: 0 })
    const groups = container.querySelectorAll('g.box')
    expect(groups[0].classList.contains('box--dim')).toBe(false)
    expect(groups[1].classList.contains('box--dim')).toBe(true)
  })

  it('exposes an accessible label per detection', () => {
    renderOverlay()
    expect(
      screen.getByLabelText('bottle, 92% confidence'),
    ).toBeInTheDocument()
  })

  it('skips the overlay when image dimensions are unknown', () => {
    const { container } = renderOverlay({ imageWidth: 0, imageHeight: 0 })
    expect(container.querySelector('svg')).toBeNull()
  })
})

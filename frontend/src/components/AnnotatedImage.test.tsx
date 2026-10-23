import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AnnotatedImage } from './AnnotatedImage'
import { makeDetection } from '../test/fixtures'
import { buildColorMap } from '../utils/colors'

const detections = [
  makeDetection(0, 'bottle', 0.92, [10, 20, 60, 90]),
  makeDetection(1, 'cup', 0.44, [100, 30, 150, 110]),
]

/** A dense shelf, like the real 36-bottle image that motivated this design. */
function denseShelf(count = 36) {
  return Array.from({ length: count }, (_, i) => {
    const col = i % 12
    const row = Math.floor(i / 12)
    const x = 10 + col * 32
    const y = 10 + row * 95
    return makeDetection(i, 'bottle', 0.5 + (i % 40) / 100, [x, y, x + 28, y + 85])
  })
}

function renderOverlay(
  props: Partial<Parameters<typeof AnnotatedImage>[0]> = {},
) {
  return render(
    <AnnotatedImage
      src="blob:test"
      imageWidth={400}
      imageHeight={300}
      detections={detections}
      colors={buildColorMap(['bottle', 'cup'])}
      showBoxes
      showLabels={false}
      selectedId={null}
      onSelect={() => {}}
      {...props}
    />,
  )
}

const boxes = (c: HTMLElement) => c.querySelectorAll('g.box')

/**
 * Find a box by its accessible label.
 *
 * Boxes render sorted by area (largest first) so small ones stay clickable,
 * so DOM index does NOT match detection order. Always select by label.
 */
const boxFor = (c: HTMLElement, label: string): SVGGElement => {
  const match = [...boxes(c)].find((g) =>
    (g.getAttribute('aria-label') ?? '').startsWith(label),
  )
  if (!match) throw new Error(`no box labelled "${label}"`)
  return match as unknown as SVGGElement
}
const labels = (c: HTMLElement) => c.querySelectorAll('g.box__label')

describe('AnnotatedImage — rendering', () => {
  it('renders the image', () => {
    renderOverlay()
    expect(screen.getByAltText('Analyzed shelf')).toBeInTheDocument()
  })

  it('uses the original image dimensions as the viewBox so boxes scale', () => {
    const { container } = renderOverlay()
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('viewBox', '0 0 400 300')
    expect(svg).toHaveAttribute('preserveAspectRatio', 'xMidYMid meet')
  })

  it('draws one box per detection with exact coordinates', () => {
    const { container } = renderOverlay()
    expect(boxes(container)).toHaveLength(2)

    // Coordinates must survive the redesign untouched.
    const rect = boxFor(container, 'bottle').querySelector('rect')
    expect(rect).toHaveAttribute('x', '10')
    expect(rect).toHaveAttribute('y', '20')
    expect(rect).toHaveAttribute('width', '50')
    expect(rect).toHaveAttribute('height', '70')
  })

  it('hides the overlay when boxes are toggled off', () => {
    const { container } = renderOverlay({ showBoxes: false })
    expect(container.querySelector('svg')).toBeNull()
    expect(screen.getByAltText('Analyzed shelf')).toBeInTheDocument()
  })

  it('skips the overlay when image dimensions are unknown', () => {
    const { container } = renderOverlay({ imageWidth: 0, imageHeight: 0 })
    expect(container.querySelector('svg')).toBeNull()
  })

  it('handles an empty detection set', () => {
    const { container } = renderOverlay({ detections: [] })
    expect(boxes(container)).toHaveLength(0)
    expect(labels(container)).toHaveLength(0)
  })
})

describe('AnnotatedImage — label density', () => {
  it('shows NO labels by default', () => {
    // The whole point: 36 permanent chips made the image unreadable.
    const { container } = renderOverlay()
    expect(labels(container)).toHaveLength(0)
  })

  it('keeps a dense image clean — boxes but no labels', () => {
    const { container } = renderOverlay({ detections: denseShelf(36) })
    expect(boxes(container)).toHaveLength(36)
    expect(labels(container)).toHaveLength(0)
  })

  it('reveals a label on hover', async () => {
    const { container } = renderOverlay()
    await userEvent.hover(boxFor(container, 'bottle'))

    expect(labels(container)).toHaveLength(1)
    expect(screen.getByText(/92%/)).toBeInTheDocument()
  })

  it('hides the label again on unhover', async () => {
    const { container } = renderOverlay()
    const box = boxFor(container, 'bottle')
    await userEvent.hover(box)
    expect(labels(container)).toHaveLength(1)

    await userEvent.unhover(box)
    fireEvent.mouseLeave(container.querySelector('svg')!)
    expect(labels(container)).toHaveLength(0)
  })

  it('keeps the selected label pinned without hover', () => {
    const { container } = renderOverlay({ selectedId: 1 })
    expect(labels(container)).toHaveLength(1)
    expect(screen.getByText(/cup 44%/)).toBeInTheDocument()
  })

  it('shows every label when the toggle is on', () => {
    const { container } = renderOverlay({ showLabels: true })
    expect(labels(container)).toHaveLength(2)
  })

  it('does not duplicate the active label when all labels are shown', () => {
    // The active one renders last, on top; it must not render twice.
    const { container } = renderOverlay({ showLabels: true, selectedId: 0 })
    expect(labels(container)).toHaveLength(2)
  })

  it('renders every label on a dense image when asked', () => {
    const { container } = renderOverlay({
      detections: denseShelf(36),
      showLabels: true,
    })
    expect(labels(container)).toHaveLength(36)
  })

  it('paints labels after boxes so they are never occluded', () => {
    const { container } = renderOverlay({ showLabels: true })
    const groups = [...container.querySelectorAll('g.box, g.box__label')]
    const lastBox = groups.findLastIndex((g) => g.classList.contains('box'))
    const firstLabel = groups.findIndex((g) =>
      g.classList.contains('box__label'),
    )
    expect(firstLabel).toBeGreaterThan(lastBox)
  })

  it('clamps a label so it cannot run off the right edge', () => {
    const wide = [makeDetection(0, 'bottle', 0.9, [380, 20, 399, 90])]
    const { container } = renderOverlay({ detections: wide, showLabels: true })

    const rect = container.querySelector('g.box__label rect')!
    const x = Number(rect.getAttribute('x'))
    const width = Number(rect.getAttribute('width'))
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x + width).toBeLessThanOrEqual(400)
  })

  it('drops the label inside the box when it hugs the top edge', () => {
    const topEdge = [makeDetection(0, 'bottle', 0.9, [10, 0, 60, 70])]
    const { container } = renderOverlay({ detections: topEdge, showLabels: true })

    const y = Number(container.querySelector('g.box__label rect')!.getAttribute('y'))
    expect(y).toBeGreaterThanOrEqual(0)
  })
})

describe('AnnotatedImage — selection', () => {
  it('selects on click', async () => {
    const onSelect = vi.fn()
    const { container } = renderOverlay({ onSelect })
    await userEvent.click(boxFor(container, 'bottle'))
    expect(onSelect).toHaveBeenCalledWith(0)
  })

  it('deselects when the pinned box is clicked again', async () => {
    const onSelect = vi.fn()
    const { container } = renderOverlay({ onSelect, selectedId: 0 })
    await userEvent.click(boxFor(container, 'bottle'))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('dims the others when one is selected', () => {
    const { container } = renderOverlay({ selectedId: 0 })
    const all = [...boxes(container)]
    const selected = all.find((g) => g.getAttribute('aria-selected') === 'true')!
    const other = all.find((g) => g.getAttribute('aria-selected') === 'false')!

    expect(selected.classList.contains('box--dim')).toBe(false)
    expect(other.classList.contains('box--dim')).toBe(true)
  })

  it('paints small boxes last so they stay clickable inside larger ones', () => {
    // A crate containing bottles would otherwise swallow their clicks.
    const nested = [
      makeDetection(0, 'bottle', 0.9, [0, 0, 200, 200]), // large
      makeDetection(1, 'cup', 0.8, [20, 20, 50, 50]), // small, inside it
    ]
    const { container } = renderOverlay({ detections: nested })
    const order = [...boxes(container)].map((g) => g.getAttribute('aria-label'))

    expect(order[0]).toMatch(/bottle/) // largest painted first (behind)
    expect(order[1]).toMatch(/cup/) // smallest last (on top)
  })
})

describe('AnnotatedImage — keyboard accessibility', () => {
  it('exposes the overlay as a listbox of options', () => {
    const { container } = renderOverlay()
    expect(container.querySelector('svg')).toHaveAttribute('role', 'listbox')
    for (const box of boxes(container)) {
      expect(box).toHaveAttribute('role', 'option')
      expect(box).toHaveAttribute('aria-selected')
    }
  })

  it('takes ONE tab stop, not one per detection', () => {
    // 36 tab stops before the next control would be its own a11y problem.
    const { container } = renderOverlay({ detections: denseShelf(36) })
    const tabbable = [...boxes(container)].filter(
      (g) => g.getAttribute('tabindex') === '0',
    )
    expect(tabbable).toHaveLength(1)
  })

  it('labels each box for screen readers', () => {
    renderOverlay()
    expect(screen.getByLabelText('bottle, 92% confidence')).toBeInTheDocument()
  })

  it('moves between boxes with arrow keys', () => {
    const { container } = renderOverlay()
    const first = boxes(container)[0] as SVGGElement

    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })

    expect(boxes(container)[1].getAttribute('tabindex')).toBe('0')
    expect(boxes(container)[0].getAttribute('tabindex')).toBe('-1')
  })

  it('wraps around at the ends', () => {
    const { container } = renderOverlay()
    const first = boxes(container)[0] as SVGGElement

    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(boxes(container)[1].getAttribute('tabindex')).toBe('0')
  })

  it('jumps to first and last with Home and End', () => {
    const { container } = renderOverlay({ detections: denseShelf(10) })
    const first = boxes(container)[0] as SVGGElement

    first.focus()
    fireEvent.keyDown(first, { key: 'End' })
    expect(boxes(container)[9].getAttribute('tabindex')).toBe('0')

    fireEvent.keyDown(boxes(container)[9], { key: 'Home' })
    expect(boxes(container)[0].getAttribute('tabindex')).toBe('0')
  })

  it.each(['Enter', ' '])('selects with %s', (key) => {
    const onSelect = vi.fn()
    const { container } = renderOverlay({ onSelect })
    fireEvent.keyDown(boxFor(container, 'bottle'), { key })
    expect(onSelect).toHaveBeenCalledWith(0)
  })

  it('clears the selection with Escape', () => {
    const onSelect = vi.fn()
    const { container } = renderOverlay({ onSelect, selectedId: 0 })
    fireEvent.keyDown(boxFor(container, 'bottle'), { key: 'Escape' })
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('ignores Escape when nothing is selected', () => {
    const onSelect = vi.fn()
    const { container } = renderOverlay({ onSelect })
    fireEvent.keyDown(boxes(container)[0], { key: 'Escape' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('reveals the label on keyboard focus, not just hover', () => {
    const { container } = renderOverlay()
    fireEvent.focus(boxFor(container, 'bottle'))
    expect(labels(container)).toHaveLength(1)
  })
})

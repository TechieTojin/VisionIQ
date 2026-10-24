import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ZONES, type Zone } from '../../lib/zones'
import { makeDetection, makeRecord } from '../../test/fixtures'
import { buildColorMap } from '../../utils/colors'
import { ConfidenceExplorer } from './ConfidenceExplorer'
import { ExplainabilityPanel } from './Explainability'
import { HeatmapControls, HeatmapLayer } from './Heatmap'
import { ViewerToolbar, type ViewerLayers } from './ViewerToolbar'
import { ZoneLayer, ZonePanel } from './Zones'

const colors = buildColorMap(['bottle', 'cup'])
const dets = [
  makeDetection(0, 'bottle', 0.92, [0, 0, 40, 40]),
  makeDetection(1, 'bottle', 0.81, [100, 120, 140, 160]),
  makeDetection(2, 'cup', 0.33, [200, 250, 240, 290]),
]

const checkbox = (label: string) => screen.getByText(label).closest('label')!.querySelector('input')!

// ---------------------------------------------------------------------------

describe('ViewerToolbar', () => {
  const layers: ViewerLayers = { boxes: true, labels: false, heatmap: false, zones: false }

  it('offers an all-labels toggle, off by default', () => {
    render(<ViewerToolbar layers={layers} onChange={() => {}} />)
    expect(checkbox('All labels')).not.toBeChecked()
  })

  it('emits label toggle changes without touching other layers', async () => {
    const onChange = vi.fn()
    render(<ViewerToolbar layers={layers} onChange={onChange} />)
    await userEvent.click(checkbox('All labels'))
    expect(onChange).toHaveBeenCalledWith({ ...layers, labels: true })
  })

  it('disables the label toggle when boxes are hidden', () => {
    // Labels without boxes would be meaningless floating chips.
    render(<ViewerToolbar layers={{ ...layers, boxes: false }} onChange={() => {}} />)
    expect(checkbox('All labels')).toBeDisabled()
  })

  it('toggles bounding boxes', async () => {
    const onChange = vi.fn()
    render(<ViewerToolbar layers={layers} onChange={onChange} />)
    await userEvent.click(checkbox('Bounding boxes'))
    expect(onChange).toHaveBeenCalledWith({ ...layers, boxes: false })
  })

  it('lets boxes and heatmap be on together', async () => {
    const onChange = vi.fn()
    render(<ViewerToolbar layers={layers} onChange={onChange} />)
    await userEvent.click(checkbox('Heatmap'))
    expect(onChange).toHaveBeenCalledWith({ ...layers, heatmap: true })
  })

  it('disables every layer when the model did not run', () => {
    render(<ViewerToolbar layers={layers} onChange={() => {}} disabled />)
    for (const l of ['Bounding boxes', 'All labels', 'Heatmap', 'Zones']) expect(checkbox(l)).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------

function Explorer({ onChange = () => {}, detections = dets }: { onChange?: (t: number) => void; detections?: typeof dets }) {
  const [t, setT] = useState(0.25)
  return (
    <ConfidenceExplorer
      detections={detections}
      inferenceThreshold={0.25}
      threshold={t}
      onChange={(v) => {
        setT(v)
        onChange(v)
      }}
      colors={colors}
    />
  )
}

describe('ConfidenceExplorer', () => {
  it('floors the slider at the inference threshold, never 0', () => {
    render(<Explorer />)
    const slider = screen.getByRole('slider')
    // Anything below 25% was discarded by the model; the slider must not imply otherwise.
    expect(slider).toHaveAttribute('min', '25')
    expect(slider).toHaveAttribute('max', '100')
  })

  it('emits confidence changes from the slider and updates the visible count', () => {
    const onChange = vi.fn()
    render(<Explorer onChange={onChange} />)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '60' } })
    expect(onChange).toHaveBeenCalledWith(0.6)
    expect(screen.getByText(/of 3 shown/)).toHaveTextContent('1 hidden')
  })

  it('resets to the inference floor', async () => {
    const onChange = vi.fn()
    render(<Explorer onChange={onChange} />)
    const reset = screen.getByRole('button', { name: 'Reset to 25%' })
    expect(reset).toBeDisabled()
    fireEvent.change(screen.getByRole('slider'), { target: { value: '90' } })
    await userEvent.click(reset)
    expect(onChange).toHaveBeenLastCalledWith(0.25)
  })

  it('sets the threshold from a histogram bar', async () => {
    const onChange = vi.fn()
    render(<Explorer onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: /^80%–85%.*Set threshold to 80%/ }))
    expect(onChange).toHaveBeenCalledWith(0.8)
  })

  it('explains a scan with no detections instead of offering a useless filter', () => {
    render(<Explorer detections={[]} />)
    expect(screen.getByText(/Lowering this slider cannot reveal objects/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------

describe('Heatmap', () => {
  it('renders nothing on the image when there are no detections', () => {
    const { container } = render(
      <svg>
        <HeatmapLayer detections={[]} imageWidth={400} imageHeight={300} opacity={0.6} />
      </svg>,
    )
    expect(container.querySelector('image')).toBeNull()
  })

  it('labels itself as detection concentration, not attention or traffic', () => {
    render(<HeatmapControls enabled opacity={0.6} onOpacity={() => {}} detectionCount={3} onReset={() => {}} />)
    expect(screen.getByText(/Detected-object concentration/)).toBeInTheDocument()
    expect(screen.getByText(/Not customer attention/)).toBeInTheDocument()
  })

  it('adjusts opacity and resets', async () => {
    const onOpacity = vi.fn()
    const onReset = vi.fn()
    render(<HeatmapControls enabled opacity={0.6} onOpacity={onOpacity} detectionCount={3} onReset={onReset} />)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '30' } })
    expect(onOpacity).toHaveBeenCalledWith(0.3)
    await userEvent.click(screen.getByRole('button', { name: /Reset heatmap/ }))
    expect(onReset).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------

function Zones({ detections = dets, onZones = () => {} }: { detections?: typeof dets; onZones?: (z: Zone[]) => void }) {
  const [zones, setZones] = useState<Zone[]>(DEFAULT_ZONES.map((z) => ({ ...z })))
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <ZonePanel
      zones={zones}
      onZonesChange={(z) => {
        setZones(z)
        onZones(z)
      }}
      detections={detections}
      imageWidth={400}
      imageHeight={300}
      selectedId={selected}
      onSelect={setSelected}
      drawing={false}
      onDrawingChange={() => {}}
      threshold={0.25}
    />
  )
}

describe('ZoneLayer', () => {
  it('stacks labels of zones that share a corner (BUG-02 regression)', () => {
    const zones: Zone[] = [
      { id: 'a', name: 'Top shelf', x0: 0, y0: 0, x1: 1, y1: 0.33 },
      { id: 'b', name: 'Whole', x0: 0, y0: 0, x1: 1, y1: 1 },
    ]
    const { container } = render(<svg><ZoneLayer zones={zones} imageWidth={400} imageHeight={300} selectedId={null} /></svg>)
    const ys = [...container.querySelectorAll('text')].map((t) => Number(t.getAttribute('y')))
    expect(ys[1]).toBeGreaterThan(ys[0])
  })
})

describe('ZonePanel', () => {
  it('assigns each detection to exactly one default zone by box centre', () => {
    render(<Zones />)
    // Centres: (20,20) top, (120,140) middle, (220,270) bottom.
    for (const name of ['Top shelf', 'Middle shelf', 'Bottom shelf']) {
      const row = screen.getByText(name).closest('li')!
      expect(row.querySelector('.zone-row__count')).toHaveTextContent(/^1 ·/)
    }
  })

  it('respects the confidence filter it is given', () => {
    render(<Zones detections={dets.filter((d) => d.confidence >= 0.5)} />)
    const bottom = screen.getByText('Bottom shelf').closest('li')!
    expect(bottom.querySelector('.zone-row__count')).toHaveTextContent(/^0 ·/)
    expect(within(bottom).getByText('no detections')).toBeInTheDocument()
  })

  it('adds a zone from the keyboard-accessible button', async () => {
    const onZones = vi.fn()
    render(<Zones onZones={onZones} />)
    await userEvent.click(screen.getByRole('button', { name: /Edit zones/ }))
    await userEvent.click(screen.getByRole('button', { name: /Add zone/ }))
    expect(onZones.mock.lastCall![0]).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------

describe('ExplainabilityPanel', () => {
  const record = makeRecord(dets)
  const renderPanel = () =>
    render(
      <ExplainabilityPanel
        record={record}
        visible={dets}
        threshold={0.25}
        inferenceThreshold={0.25}
        onThreshold={() => {}}
        colors={colors}
        selectedId={null}
        onSelect={() => {}}
      />,
    )

  it('shows the model and its measured inference time', () => {
    renderPanel()
    expect(screen.getByText('yolov8n.pt')).toBeInTheDocument()
    expect(screen.getByText('120 ms')).toBeInTheDocument()
  })

  it('reports an unknown inference time as not available', () => {
    render(
      <ExplainabilityPanel
        record={makeRecord(dets, { detection: { ...record.detection!, processing_ms: 0 } })}
        visible={dets}
        threshold={0.25}
        inferenceThreshold={0.25}
        onThreshold={() => {}}
        colors={colors}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByText('Not available')).toBeInTheDocument()
  })

  it('flags low-confidence detections and lets you select them', async () => {
    const onSelect = vi.fn()
    render(
      <ExplainabilityPanel
        record={record}
        visible={dets}
        threshold={0.25}
        inferenceThreshold={0.25}
        onThreshold={() => {}}
        colors={colors}
        selectedId={null}
        onSelect={onSelect}
      />,
    )
    expect(screen.getByText(/1 low-confidence detection/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'cup 33%' }))
    expect(onSelect).toHaveBeenCalledWith(2)
  })

  it('states that confidence is not calibrated and this is not a causal explanation', () => {
    renderPanel()
    expect(screen.getByText(/Confidence is not probability/)).toBeInTheDocument()
    expect(screen.getByText(/This is diagnostics, not explanation/)).toBeInTheDocument()
  })
})

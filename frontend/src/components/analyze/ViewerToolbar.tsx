import { Toggle } from '../ui/Controls'

export interface ViewerLayers {
  boxes: boolean
  labels: boolean
  heatmap: boolean
  zones: boolean
}

/**
 * Layer switches for the annotated image. Boxes, heatmap and zones are
 * independent, so "boxes + heatmap" is simply both switched on.
 */
export function ViewerToolbar({
  layers,
  onChange,
  disabled = false,
}: {
  layers: ViewerLayers
  onChange: (layers: ViewerLayers) => void
  disabled?: boolean
}) {
  const set = (patch: Partial<ViewerLayers>) => onChange({ ...layers, ...patch })
  return (
    <div className="viewer-toolbar" role="group" aria-label="Image layers">
      <Toggle
        label="Bounding boxes"
        checked={layers.boxes}
        disabled={disabled}
        onChange={(boxes) => set({ boxes })}
      />
      <Toggle
        label="All labels"
        checked={layers.labels}
        disabled={disabled || !layers.boxes}
        hint="Off by default: on a dense shelf, dozens of labels obscure the image. Hover, focus or click a box to read its label."
        onChange={(labels) => set({ labels })}
      />
      <Toggle
        label="Heatmap"
        checked={layers.heatmap}
        disabled={disabled}
        onChange={(heatmap) => set({ heatmap })}
      />
      <Toggle
        label="Zones"
        checked={layers.zones}
        disabled={disabled}
        onChange={(zones) => set({ zones })}
      />
    </div>
  )
}

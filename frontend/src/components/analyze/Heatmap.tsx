import { useMemo } from 'react'
import { densityGrid, legendGradient, renderHeatmap } from '../../lib/heatmap'
import type { Detection } from '../../types'

/**
 * The heatmap as an SVG `<image>` drawn inside AnnotatedImage's SVG.
 *
 * It spans exactly 0..width × 0..height in original-image coordinates, so it
 * shares the boxes' viewBox and letterboxing and stays aligned at any size.
 * The density raster is recomputed only when the detection set changes;
 * opacity is just an attribute.
 */
export function HeatmapLayer({
  detections,
  imageWidth,
  imageHeight,
  opacity,
}: {
  detections: readonly Detection[]
  imageWidth: number
  imageHeight: number
  opacity: number
}) {
  const url = useMemo(
    () => renderHeatmap(densityGrid(detections, imageWidth, imageHeight)),
    [detections, imageWidth, imageHeight],
  )
  if (!url) return null
  return (
    <image
      className="heatmap-layer"
      href={url}
      x={0}
      y={0}
      width={imageWidth}
      height={imageHeight}
      preserveAspectRatio="none"
      opacity={opacity}
      pointerEvents="none"
      aria-hidden="true"
    />
  )
}

/** Controls and legend. Lives beside the image, not on top of it. */
export function HeatmapControls({
  enabled,
  opacity,
  onOpacity,
  detectionCount,
  onReset,
}: {
  enabled: boolean
  opacity: number
  onOpacity: (v: number) => void
  detectionCount: number
  onReset: () => void
}) {
  if (!enabled) return null
  return (
    <div className="heatmap-controls">
      <div className="heatmap-legend">
        <span className="heatmap-legend__label">Lower</span>
        <span
          className="heatmap-legend__bar"
          style={{ background: legendGradient() }}
          aria-hidden="true"
        />
        <span className="heatmap-legend__label">Higher</span>
      </div>
      <p className="heatmap-controls__caption">
        {detectionCount === 0 ? (
          <>No detections at this threshold — there is nothing to map.</>
        ) : (
          <>
            <strong>Detected-object concentration</strong>, relative within this image, from{' '}
            {detectionCount} visible detection{detectionCount === 1 ? '' : 's'}. Not customer
            attention, foot traffic or sales activity.
          </>
        )}
      </p>
      <label className="heatmap-controls__opacity">
        Opacity <output>{Math.round(opacity * 100)}%</output>
        <input
          type="range"
          className="range range--sm"
          min={10}
          max={100}
          step={5}
          value={Math.round(opacity * 100)}
          onChange={(e) => onOpacity(Number(e.target.value) / 100)}
          aria-label="Heatmap opacity"
        />
      </label>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onReset}>
        Reset heatmap
      </button>
    </div>
  )
}

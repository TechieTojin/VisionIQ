import { useMemo } from 'react'
import type { Detection } from '../types'
import { colorFor } from '../utils/colors'

interface AnnotatedImageProps {
  src: string
  imageWidth: number
  imageHeight: number
  detections: Detection[]
  colors: Record<string, string>
  showBoxes: boolean
  selectedId: number | null
  onSelect: (id: number | null) => void
}

/**
 * Renders the image with an SVG bounding-box overlay.
 *
 * The SVG uses the ORIGINAL image dimensions as its viewBox and is stretched
 * to the rendered image size, so absolute pixel coordinates from the backend
 * scale automatically on resize with no JS measurement and no aspect-ratio
 * drift.
 */
export function AnnotatedImage({
  src,
  imageWidth,
  imageHeight,
  detections,
  colors,
  showBoxes,
  selectedId,
  onSelect,
}: AnnotatedImageProps) {
  // Keep label text readable regardless of image resolution.
  const fontSize = useMemo(
    () => Math.max(11, Math.round(Math.max(imageWidth, imageHeight) / 55)),
    [imageWidth, imageHeight],
  )
  const strokeWidth = useMemo(
    () => Math.max(1.5, Math.max(imageWidth, imageHeight) / 400),
    [imageWidth, imageHeight],
  )

  return (
    <div className="annotated">
      <img src={src} alt="Analyzed shelf" className="annotated__img" />

      {showBoxes && imageWidth > 0 && imageHeight > 0 && (
        <svg
          className="annotated__svg"
          viewBox={`0 0 ${imageWidth} ${imageHeight}`}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label={`${detections.length} detected objects`}
        >
          {detections.map((det) => {
            const color = colorFor(colors, det.label)
            const isSelected = selectedId === det.id
            const dim = selectedId !== null && !isSelected
            const label = `${det.label} ${Math.round(det.confidence * 100)}%`
            const labelW = label.length * fontSize * 0.58 + fontSize * 0.6
            // Flip the label inside the image when the box hugs the top edge.
            const labelAbove = det.box.y1 > fontSize * 1.6
            const labelY = labelAbove
              ? det.box.y1 - fontSize * 1.5
              : det.box.y1 + 2

            return (
              <g
                key={det.id}
                className={`box${dim ? ' box--dim' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(isSelected ? null : det.id)
                }}
                role="button"
                tabIndex={0}
                aria-label={`${det.label}, ${Math.round(det.confidence * 100)}% confidence`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(isSelected ? null : det.id)
                  }
                }}
              >
                <rect
                  x={det.box.x1}
                  y={det.box.y1}
                  width={det.box.width}
                  height={det.box.height}
                  fill={isSelected ? color : 'transparent'}
                  fillOpacity={isSelected ? 0.18 : 0}
                  stroke={color}
                  strokeWidth={isSelected ? strokeWidth * 2 : strokeWidth}
                  rx={2}
                />
                <rect
                  x={det.box.x1}
                  y={labelY}
                  width={labelW}
                  height={fontSize * 1.45}
                  fill={color}
                  rx={2}
                />
                <text
                  x={det.box.x1 + fontSize * 0.3}
                  y={labelY + fontSize * 1.08}
                  fontSize={fontSize}
                  fill="#0b0f1a"
                  fontWeight="600"
                >
                  {label}
                </text>
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

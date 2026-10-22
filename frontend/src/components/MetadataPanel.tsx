import type { ImageMetadata } from '../types'

interface MetadataPanelProps {
  metadata: ImageMetadata
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** Renders validated image metadata returned by the backend. */
export function MetadataPanel({ metadata }: MetadataPanelProps) {
  const rows: Array<[string, string]> = [
    ['Filename', metadata.filename],
    ['Format', metadata.format],
    ['Detected type', metadata.content_type],
    ['Dimensions', `${metadata.width} × ${metadata.height} px`],
    ['Aspect ratio', metadata.aspect_ratio.toFixed(3)],
    ['Megapixels', `${metadata.megapixels} MP`],
    ['Color mode', metadata.mode],
    ['File size', formatBytes(metadata.size_bytes)],
  ]

  return (
    <div className="panel">
      <div className="panel__header">
        <span className="badge badge--ok">Validated</span>
        <h2>Image metadata</h2>
      </div>
      <dl className="metadata-grid">
        {rows.map(([label, value]) => (
          <div className="metadata-grid__item" key={label}>
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

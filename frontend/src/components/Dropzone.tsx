import { useCallback, useRef, useState } from 'react'

interface DropzoneProps {
  disabled?: boolean
  onFileSelected: (file: File) => void
}

const ACCEPT = 'image/jpeg,image/png,image/webp'

/** Drag-and-drop + click-to-browse image picker. */
export function Dropzone({ disabled, onFileSelected }: DropzoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (files && files.length > 0) onFileSelected(files[0])
    },
    [onFileSelected],
  )

  return (
    <div
      className={`dropzone${isDragging ? ' dropzone--active' : ''}${
        disabled ? ' dropzone--disabled' : ''
      }`}
      role="button"
      tabIndex={0}
      aria-label="Upload a shelf image"
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          inputRef.current?.click()
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setIsDragging(true)
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setIsDragging(false)
        if (!disabled) handleFiles(e.dataTransfer.files)
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
      <div className="dropzone__icon" aria-hidden="true">
        &#8682;
      </div>
      <p className="dropzone__title">
        Drag &amp; drop a shelf image, or <span>browse</span>
      </p>
      <p className="dropzone__hint">JPEG, PNG or WebP &middot; up to 10 MB</p>
    </div>
  )
}

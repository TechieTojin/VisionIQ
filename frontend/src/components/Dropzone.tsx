import { useCallback, useRef, useState } from 'react'

interface DropzoneProps {
  disabled?: boolean
  onFileSelected?: (file: File) => void
  /** Accept several files at once (batch mode). */
  multiple?: boolean
  onFilesSelected?: (files: File[]) => void
}

const ACCEPT = 'image/jpeg,image/png,image/webp'

/** Drag-and-drop + click-to-browse image picker. */
export function Dropzone({ disabled, onFileSelected, multiple = false, onFilesSelected }: DropzoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      if (multiple && onFilesSelected) onFilesSelected(Array.from(files))
      else onFileSelected?.(files[0])
    },
    [multiple, onFileSelected, onFilesSelected],
  )

  return (
    <div
      className={`dropzone${isDragging ? ' dropzone--active' : ''}${
        disabled ? ' dropzone--disabled' : ''
      }`}
      role="button"
      tabIndex={0}
      aria-label={multiple ? 'Add shelf images to the batch' : 'Upload a shelf image'}
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
        multiple={multiple}
        hidden
        onChange={(e) => {
          handleFiles(e.target.files)
          // Allow choosing the same file(s) again later.
          e.target.value = ''
        }}
      />
      <div className="dropzone__icon" aria-hidden="true">
        &#8682;
      </div>
      <p className="dropzone__title">
        Drag &amp; drop {multiple ? 'shelf images' : 'a shelf image'}, or <span>browse</span>
      </p>
      <p className="dropzone__hint">
        JPEG, PNG or WebP &middot; up to 10 MB{multiple ? ' each · up to 50 per batch' : ''}
      </p>
    </div>
  )
}

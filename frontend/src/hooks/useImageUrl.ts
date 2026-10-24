import { useEffect, useState } from 'react'
import { requestBlob } from '../api/client'

/** Object URL for an authenticated image endpoint; revoked on change/unmount. */
export function useImageUrl(path: string | null): string | null {
  const [state, setState] = useState<{ path: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!path) return
    let cancelled = false
    let url: string | null = null
    requestBlob(path).then(
      (blob) => {
        if (cancelled || !blob) return
        url = URL.createObjectURL(blob)
        setState({ path, url })
      },
      () => {},
    )
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [path])
  return state && state.path === path ? state.url : null
}

import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api/client'

export interface AsyncState<T> {
  data: T | undefined
  error: string | null
  /** The server's machine error code (e.g. `not_annotated`), when known. */
  reason: string | null
  loading: boolean
  reload: () => void
}

/**
 * Load data with a promise. State is only ever set from promise callbacks,
 * never synchronously in the effect body, and stale responses are dropped.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ token: number; data?: T; error: string | null; reason: string | null; done: boolean }>(
    { token: -1, error: null, reason: null, done: false },
  )
  const [token, setToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    fn().then(
      (data) => {
        if (!cancelled) setState({ token, data, error: null, reason: null, done: true })
      },
      (err: unknown) => {
        if (!cancelled)
          setState({
            token,
            error: err instanceof Error ? err.message : 'Request failed.',
            reason: err instanceof ApiError ? err.reason : null,
            done: true,
          })
      },
    )
    return () => {
      cancelled = true
    }
    // fn is recreated each render; callers list its real inputs in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, token])

  const reload = useCallback(() => setToken((t) => t + 1), [])
  const current = state.token === token && state.done
  return {
    // Keep showing the last data while reloading, so the page doesn't flash.
    data: state.data,
    error: current ? state.error : null,
    reason: current ? state.reason : null,
    loading: !current,
    reload,
  }
}

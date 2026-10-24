import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})

// jsdom has no canvas implementation and logs "Not implemented" on every
// getContext call. Return null instead — exactly what the app's canvas code
// already treats as "canvas unavailable". Tests that need a context install
// their own mock.
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  writable: true,
  value: () => null,
})

// jsdom does not implement scrolling; the shell scrolls to top on navigation.
Object.defineProperty(window, 'scrollTo', {
  configurable: true,
  writable: true,
  value: () => {},
})

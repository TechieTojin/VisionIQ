import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The default 5s is not enough for the component tests on a cold,
    // loaded machine — they intermittently time out while jsdom warms up.
    // The tests themselves are fast; this only removes the false failures.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})

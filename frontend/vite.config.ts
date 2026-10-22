import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
// The `.js` extension is required by the node16 module resolution that
// tsconfig.node.json applies to this file; TypeScript maps it to csp.ts.
import { buildCsp, securityHeaders } from './src/security/csp.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')

  // The dev server serves a policy equivalent to production's, relaxed only
  // where Vite's HMR requires it. Production headers come from CloudFront
  // (infrastructure/terraform/modules/frontend) — a static origin cannot set
  // response headers itself.
  const devCsp = buildCsp(
    {
      cognitoHostedUi: env.VITE_COGNITO_DOMAIN
        ? `https://${env.VITE_COGNITO_DOMAIN.replace(/^https?:\/\//, '')}`
        : undefined,
      cognitoIdp: env.VITE_COGNITO_ISSUER
        ? new URL(env.VITE_COGNITO_ISSUER).origin
        : undefined,
    },
    true,
  )

  return {
    plugins: [react()],
    server: {
      port: 5175,
      headers: securityHeaders(devCsp, true),
      proxy: {
        // Forward API calls to the FastAPI backend during development.
        '/api': {
          target: 'http://127.0.0.1:8080',
          changeOrigin: true,
        },
      },
    },
    preview: {
      port: 4175,
      // `vite preview` serves the production bundle, so it gets the strict
      // policy — a useful local check that the real CSP does not break the app.
      headers: securityHeaders(buildCsp({}), false),
    },
  }
})

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from './auth/AuthProvider'
import { AuthenticatedApp } from './AuthenticatedApp'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  </StrictMode>,
)

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { getSystemStatus } from './api/client'
import { resolveApiConfig } from './api/config'
import { ScanDataProvider } from './data/ScanDataProvider'
// Registers the demo analysis client with the API layer (side effect).
import './demo/demoClient'
import { ROUTE_GROUPS, ROUTES, href, useRoute, type RouteGroup, type RouteName } from './lib/router'
import { AnalyzePage } from './pages/AnalyzePage'
import { DashboardPage } from './pages/DashboardPage'
import { TimelinePage } from './pages/TimelinePage'
import { LoadingBlock } from './components/ui/States'
import type { SystemStatus } from './types'

// Less-used screens load on demand, keeping the first download small.
const AlertsPage = lazy(() => import('./pages/AlertsPage').then((m) => ({ default: m.AlertsPage })))
const AnnotatePage = lazy(() => import('./pages/AnnotatePage').then((m) => ({ default: m.AnnotatePage })))
const AskPage = lazy(() => import('./pages/AskPage').then((m) => ({ default: m.AskPage })))
const BatchPage = lazy(() => import('./pages/BatchPage').then((m) => ({ default: m.BatchPage })))
const BenchmarkPage = lazy(() => import('./pages/BenchmarkPage').then((m) => ({ default: m.BenchmarkPage })))
const ComparePage = lazy(() => import('./pages/ComparePage').then((m) => ({ default: m.ComparePage })))
const DatasetsPage = lazy(() => import('./pages/DatasetsPage').then((m) => ({ default: m.DatasetsPage })))
const DriftPage = lazy(() => import('./pages/DriftPage').then((m) => ({ default: m.DriftPage })))
const EvaluationPage = lazy(() => import('./pages/EvaluationPage').then((m) => ({ default: m.EvaluationPage })))
const QualityPage = lazy(() => import('./pages/QualityPage').then((m) => ({ default: m.QualityPage })))
const ReportsPage = lazy(() => import('./pages/ReportsPage').then((m) => ({ default: m.ReportsPage })))
const TrainingPage = lazy(() => import('./pages/TrainingPage').then((m) => ({ default: m.TrainingPage })))
import './App.css'
import './shell.css'
import './workbench.css'

interface DashboardProps {
  user?: { subject: string; email: string | null } | null
  mode?: 'local' | 'cognito' | 'misconfigured'
  onLogout?: () => void
}

const NAV_ICONS: Record<RouteName, string> = {
  dashboard: '◫',
  analyze: '◎',
  batch: '▦',
  compare: '⇄',
  timeline: '☰',
  alerts: '⚑',
  reports: '▤',
  ask: '?',
  annotate: '⬚',
  datasets: '▥',
  quality: '◐',
  benchmark: '⏱',
  evaluation: '⚖',
  drift: '∿',
  training: '⚙',
}

/** Shown in the phone bottom bar; everything else lives under "More". */
const PRIMARY_MOBILE: RouteName[] = ['dashboard', 'analyze', 'timeline', 'ask']
const GROUP_KEY = 'visioniq.nav.collapsed.v1'

function loadCollapsed(): RouteGroup[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(GROUP_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((g): g is RouteGroup => ['intel', 'cv', 'ml'].includes(g)) : []
  } catch {
    return []
  }
}

/**
 * The application shell: navigation, system status and account, around
 * whichever page the hash route selects. All pages share one
 * ScanDataProvider, so scan history is fetched once per session.
 */
function App({ user, mode, onLogout }: DashboardProps = {}) {
  const apiConfig = useMemo(() => resolveApiConfig(), [])
  const isDemo = apiConfig.mode === 'demo'
  const route = useRoute()
  const [system, setSystem] = useState<SystemStatus | null>(null)
  const [collapsed, setCollapsed] = useState<RouteGroup[]>(() => loadCollapsed())
  const [moreOpen, setMoreOpen] = useState(false)
  const toggleGroup = (g: RouteGroup) => {
    const next = collapsed.includes(g) ? collapsed.filter((x) => x !== g) : [...collapsed, g]
    setCollapsed(next)
    try {
      window.localStorage.setItem(GROUP_KEY, JSON.stringify(next))
    } catch {
      // Not persisted; the toggle still works for this visit.
    }
  }

  useEffect(() => {
    // Demo mode has no backend to ask; the banner states the model instead.
    if (isDemo) return
    getSystemStatus()
      .then(setSystem)
      .catch(() => setSystem(null))
  }, [isDemo])

  // Move focus to the page region on in-app navigation, for screen readers.
  // Not on the first render: on page load the keyboard user must start at
  // the top (skip link, navigation), not inside the content.
  // Compared by route key (not a "first run" flag) so React StrictMode's
  // double-invoked effects in development behave like production.
  const routeKey = `${route.name}/${route.id ?? ''}`
  const lastRouteKey = useRef(routeKey)
  useEffect(() => {
    if (lastRouteKey.current === routeKey) return
    lastRouteKey.current = routeKey
    document.getElementById('main')?.focus({ preventScroll: true })
    window.scrollTo?.({ top: 0 })
  }, [routeKey])

  // Navigating from the mobile sheet closes it.
  const [lastRoute, setLastRoute] = useState(route.name)
  if (lastRoute !== route.name) {
    setLastRoute(route.name)
    setMoreOpen(false)
  }

  const paramKey = route.params.toString()
  let page: React.ReactNode
  switch (route.name) {
    case 'analyze':
      page = <AnalyzePage scanId={route.id} />
      break
    case 'compare':
      page = <ComparePage params={route.params} />
      break
    case 'timeline':
      // Keyed by the query so a dashboard link re-seeds the filters.
      page = <TimelinePage key={paramKey} params={route.params} />
      break
    case 'reports':
      page = <ReportsPage params={route.params} />
      break
    case 'batch':
      page = <BatchPage />
      break
    case 'alerts':
      page = <AlertsPage />
      break
    case 'ask':
      page = <AskPage />
      break
    case 'annotate':
      page = <AnnotatePage scanId={route.id} />
      break
    case 'datasets':
      page = <DatasetsPage datasetId={route.id} />
      break
    case 'quality':
      page = <QualityPage />
      break
    case 'benchmark':
      page = <BenchmarkPage runId={route.id} />
      break
    case 'evaluation':
      page = <EvaluationPage key={paramKey} runId={route.id} params={route.params} />
      break
    case 'drift':
      page = <DriftPage />
      break
    case 'training':
      page = <TrainingPage runId={route.id} />
      break
    default:
      page = <DashboardPage params={route.params} />
  }

  return (
    <ScanDataProvider>
      <div className="shell">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <aside className="sidebar">
          <a className="brand" href={href('dashboard')}>
            <span className="brand__mark" aria-hidden="true">
              ◆
            </span>
            <span className="brand__text">
              <span className="brand__name">VisionIQ</span>
              <span className="brand__tag">Retail Shelf Intelligence</span>
            </span>
          </a>
          <nav className={`nav${moreOpen ? ' is-open' : ''}`} aria-label="Main" id="main-nav">
            {ROUTE_GROUPS.map((g) => {
              const isCollapsed = collapsed.includes(g.id) && !ROUTES.some((r) => r.group === g.id && r.name === route.name)
              const groupId = `nav-group-${g.id}`
              return (
                <div key={g.id} className="nav__group">
                  <button
                    type="button"
                    className="nav__group-toggle"
                    aria-expanded={!isCollapsed}
                    aria-controls={groupId}
                    onClick={() => toggleGroup(g.id)}
                  >
                    <span>{g.label}</span>
                    <span className="nav__chev" aria-hidden="true">
                      {isCollapsed ? '▸' : '▾'}
                    </span>
                  </button>
                  <div id={groupId} className="nav__items" hidden={isCollapsed}>
                    {ROUTES.filter((r) => r.group === g.id).map((r) => (
                      <a
                        key={r.name}
                        className={`nav__link${route.name === r.name ? ' is-active' : ''}`}
                        href={href(r.name)}
                        aria-current={route.name === r.name ? 'page' : undefined}
                        title={r.description}
                      >
                        <span className="nav__icon" aria-hidden="true">
                          {NAV_ICONS[r.name]}
                        </span>
                        <span className="nav__label">{r.label}</span>
                        {r.localOnly && isDemo && <span className="nav__tag">local</span>}
                      </a>
                    ))}
                  </div>
                </div>
              )
            })}
          </nav>
          <nav className="mobile-bar" aria-label="Quick navigation">
            {PRIMARY_MOBILE.map((name) => {
              const r = ROUTES.find((x) => x.name === name)!
              return (
                <a
                  key={name}
                  className={`mobile-bar__link${route.name === name ? ' is-active' : ''}`}
                  href={href(name)}
                  aria-current={route.name === name ? 'page' : undefined}
                >
                  <span aria-hidden="true">{NAV_ICONS[name]}</span>
                  <span>{r.label}</span>
                </a>
              )
            })}
            <button
              type="button"
              className={`mobile-bar__link${moreOpen || !PRIMARY_MOBILE.includes(route.name) ? ' is-active' : ''}`}
              aria-expanded={moreOpen}
              aria-controls="main-nav"
              onClick={() => setMoreOpen((v) => !v)}
            >
              <span aria-hidden="true">⋯</span>
              <span>More</span>
            </button>
          </nav>
          <div className="sidebar__foot">
            {isDemo && <span className="pill pill--accent">demo · recorded results</span>}
            {system && (
              <span
                className={`pill ${system.model_available ? 'pill--ok' : 'pill--warn'}`}
                title={system.model_unavailable_reason ?? 'Model loaded'}
              >
                {system.model_available ? system.model.name : 'model unavailable'}
              </span>
            )}
            {system && <span className="pill">{system.execution_mode}</span>}
            {mode === 'local' && (
              <span
                className="pill pill--warn"
                title="VITE_AUTH_MODE=local — no authentication. Never used in a production build."
              >
                auth off (local)
              </span>
            )}
            {mode === 'cognito' && onLogout && (
              <div className="account">
                <span className="account__name" title={user?.subject ?? ''}>
                  {user?.email ?? user?.subject ?? 'Signed in'}
                </span>
                <button type="button" className="btn btn--ghost btn--sm" onClick={onLogout}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </aside>

        <main id="main" className="main" tabIndex={-1}>
          {system && !system.model_available && (
            <p className="callout callout--warn" role="note">
              <strong>No detection model is loaded.</strong> {system.model_unavailable_reason} Images will
              still be validated, but no objects can be detected.
            </p>
          )}
          <Suspense fallback={<LoadingBlock rows={6} label="Loading page…" />}>{page}</Suspense>
        </main>
      </div>
    </ScanDataProvider>
  )
}

export default App

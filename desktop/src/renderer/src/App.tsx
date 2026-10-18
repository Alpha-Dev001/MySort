import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MonitoringState } from '../../shared/types'
import { api } from './api'
import Sidebar, { defaultNavGroups } from './components/Sidebar'

import { ConfirmProvider } from './components/Dialog'
import { ToastProvider, useToast } from './components/Toast'
import TopBar from './components/TopBar'
import { useMediaQuery } from './lib/hooks'
import {
  DEFAULT_ROUTE,
  onHashChange,
  readLocation,
  ROUTE_TITLES,
  writeLocation,
  type Location,
  type Route,
} from './routes'
import Overview from './screens/Overview'
import { RulesScreen } from './screens/Rules'
import RuleDetail from './screens/RuleDetail'
import HistoryScreen from './screens/History'
import SettingsScreen from './screens/Settings'
import { SetupScreen } from './screens/Setup'
import styles from './App.module.css'
import './styles.css'

export type { Route }

/**
 * The application shell: one persistent sidebar, one scrollable content
 * column. There is no top navigation row — the sidebar is the only way
 * between sections, so there is nothing duplicated and nothing to keep in sync.
 */
const Shell = (): React.ReactElement => {
  const toast = useToast()
  const narrow = useMediaQuery('(max-width: 1080px)')
  const mainRef = useRef<HTMLElement>(null)

  const [location, setLocation] = useState<Location>(() => readLocation() ?? { route: DEFAULT_ROUTE, ruleId: null })
  const route: Route = location.route
  const ruleId = location.ruleId
  // The rule's detail page names itself in the top bar, streamed up from the
  // screen; everything else uses the static route titles.
  const [ruleName, setRuleName] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [attention, setAttention] = useState(0)
  const [monitoringState, setMonitoringState] = useState<MonitoringState>('stopped')
  const [folderCount, setFolderCount] = useState(0)
  const [monitorBusy, setMonitorBusy] = useState(false)
  const [version, setVersion] = useState('')

  // -- routing ------------------------------------------------------------
  useEffect(() => {
    writeLocation(location)
  }, [location])

  useEffect(
    () =>
      onHashChange((next) => {
        if (next) {
          setLocation(next)
          setRuleName(null)
        }
      }),
    [],
  )

  const nav = useCallback((next: Route) => {
    setLocation({ route: next, ruleId: null })
    setRuleName(null)
    setDrawerOpen(false)
  }, [])

  // Opening a rule is document navigation: its own address, top-bar name.
  const openRule = useCallback((id: string, name: string) => {
    setRuleName(name)
    setLocation({ route: 'rules', ruleId: id })
  }, [])

  // A new screen must start at the top; otherwise the content column keeps
  // whatever offset the previous route was scrolled to.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [location])

  // -- global data the shell itself renders (sidebar + badges) --------------
  const refreshShell = useCallback(async () => {
    const [stats, folders] = await Promise.all([api.overview.get(), api.folders.list()])
    if (stats.ok) {
      setAttention(stats.data.needsAttention)
      setMonitoringState(stats.data.monitoring.state)
    }
    if (folders.ok) setFolderCount(folders.data.length)
  }, [])

  useEffect(() => {
    void refreshShell()
    // The version is static for the lifetime of the window, so fetch once.
    void api.app.getInfo().then((info) => {
      if (info.ok) setVersion(info.data.version)
    })
    const unsubs = [
      api.onMonitoringStatus((s) => setMonitoringState(s.state)),
      api.onRulesChanged(() => void refreshShell()),
      api.onOperationUpdated(() => void refreshShell()),
    ]
    return () => unsubs.forEach((u) => u())
  }, [refreshShell])

  const toggleMonitoring = useCallback(async () => {
    setMonitorBusy(true)
    try {
      const running = monitoringState === 'running'
      const result = running ? await api.monitoring.pause() : await api.monitoring.start()
      if (result.ok) {
        setMonitoringState(result.data.state)
        toast.push({
          kind: 'success',
          title: running ? 'Monitoring paused' : 'Monitoring resumed',
          description: running
            ? 'New files will wait in your folder until you resume.'
            : 'MySort is watching for finished downloads again.',
        })
      } else {
        toast.push({ kind: 'error', title: 'Could not change monitoring', description: result.error.message })
      }
    } finally {
      setMonitorBusy(false)
    }
  }, [monitoringState, toast])

  const groups = useMemo(() => defaultNavGroups(attention), [attention])

  const monitoring = useMemo(
    () => ({ state: monitoringState, folderCount }),
    [monitoringState, folderCount],
  )

  // -- render -------------------------------------------------------------
  const screen = (() => {
    switch (route) {
      case 'onboarding':
        return <SetupScreen onDone={() => nav('overview')} onSkip={() => nav('overview')} />
      case 'overview':
        return <Overview onNavigate={nav} />
      case 'rules':
        return ruleId ? (
          <RuleDetail ruleId={ruleId} onBack={() => nav('rules')} onName={setRuleName} />
        ) : (
          <RulesScreen onOpenRule={openRule} />
        )
      case 'history':
        return <HistoryScreen onNavigate={nav} />
      case 'settings':
        return <SettingsScreen />
      default:
        return <Overview onNavigate={nav} />
    }
  })()

  return (
    <div className={[styles.root, narrow ? styles.narrow : ''].filter(Boolean).join(' ')}>
      <a className="skipLink" href="#main-content">
        Skip to content
      </a>

      <Sidebar
        route={route}
        onNavigate={nav}
        groups={groups}
        monitoring={monitoring}
        busy={monitorBusy}
        onToggleMonitoring={() => void toggleMonitoring()}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
        githubUrl="https://github.com/alphamnzr/mysort"
        version={version || '0.1.0'}
      />

      <div className={styles.content}>
        {/* Static furniture above the scrolling column: the page title and the
            theme switch never move, the bar strip is the window drag region. */}
        <TopBar
          title={route === 'rules' && ruleId && ruleName ? ruleName : ROUTE_TITLES[route]}
          narrow={narrow}
          drawerOpen={drawerOpen}
          onOpenDrawer={() => setDrawerOpen(true)}
        />

        <main id="main-content" className={styles.main} tabIndex={-1} ref={mainRef}>
          <div className={styles.mainInner}>
            <div key={ruleId ? `${route}-${ruleId}` : route} className={styles.screen}>
              {screen}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

const App: React.FC = () => (
  <ToastProvider>
    <ConfirmProvider>
      <Shell />
    </ConfirmProvider>
  </ToastProvider>
)

export default App
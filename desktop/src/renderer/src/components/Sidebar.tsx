import React from 'react'
import {
  FolderOpen,
  LayoutDashboard,
  ListChecks,
  Pause,
  Play,
  Scale,
  Settings as SettingsIcon,
  Star,
  History as HistoryIcon,
} from 'lucide-react'
import GithubMark from './GithubMark'
import type { Route } from '../routes'
import type { MonitoringState } from '../../../shared/types'
import { monitoringLabel, monitoringTone } from '../lib/format'
import { useEscape } from '../lib/hooks'
import styles from './Sidebar.module.css'

export interface NavEntry {
  route: Route
  label: string
  icon: React.ComponentType<{ size?: number | string; strokeWidth?: number }>
  /** Optional count badge, e.g. items needing review. */
  badge?: number
  description: string
}

export interface SidebarProps {
  route: Route
  onNavigate: (route: Route) => void
  groups: { label: string; items: NavEntry[] }[]
  monitoring: { state: MonitoringState; folderCount: number } | null
  busy: boolean
  onToggleMonitoring: () => void
  drawerOpen: boolean
  onCloseDrawer: () => void
  githubUrl: string
  version: string
}

/**
 * The application's one navigation surface.
 *
 * It is mounted once by the shell and never re-created on a route change, so
 * its width, offsets and layout are identical on every page. The active
 * indicator is derived from `route` on each render — it can never point at a
 * page the user is not on.
 */
const Sidebar: React.FC<SidebarProps> = ({
  route,
  onNavigate,
  groups,
  monitoring,
  busy,
  onToggleMonitoring,
  drawerOpen,
  onCloseDrawer,
  githubUrl,
  version,
}) => {
  const navigate = (next: Route): void => {
    onNavigate(next)
    onCloseDrawer()
  }

  const state = monitoring?.state ?? 'stopped'
  const active = state === 'running'
  const tone = monitoringTone(state)
  const folderWord = monitoring?.folderCount === 1 ? 'folder' : 'folders'

  // The drawer behaves like a modal sheet in the compact tier, so Escape must
  // dismiss it. On wide windows `drawerOpen` is always false, so this is inert.
  useEscape(drawerOpen, onCloseDrawer)

  return (
    <>
      <div
        className={[styles.scrim, drawerOpen ? styles.scrimVisible : ''].filter(Boolean).join(' ')}
        onClick={onCloseDrawer}
        aria-hidden="true"
      />
      <nav
        id="primary-nav"
        className={[styles.sidebar, drawerOpen ? styles.drawerOpen : ''].filter(Boolean).join(' ')}
        aria-label="Primary"
      >
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">
            <svg viewBox="0 0 32 32" width="18" height="18">
              <path
                d="M6 9.5A2.5 2.5 0 0 1 8.5 7h4.2c.6 0 1.2.23 1.64.63L15.8 9.5h7.7A2.5 2.5 0 0 1 26 12v10.5a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 6 22.5z"
                fill="currentColor"
              />
              <rect x="11" y="14.5" width="10" height="7" rx="1.6" fill="var(--brand-cut)" />
            </svg>
          </span>
          <span className={styles.brandName}>MySort</span>
        </div>

        <div className={styles.nav}>
          {groups.map((group) => (
            <div key={group.label} className={styles.group}>
              <p className={styles.groupLabel}>{group.label}</p>
              <ul className={styles.groupList}>
                {group.items.map((item) => {
                  const Icon = item.icon
                  const isActive = route === item.route
                  return (
                    <li key={item.route}>
                      <button
                        type="button"
                        className={[styles.item, isActive ? styles.itemActive : ''].filter(Boolean).join(' ')}
                        aria-current={isActive ? 'page' : undefined}
                        title={item.description}
                        onClick={() => navigate(item.route)}
                      >
                        <span className={styles.itemIcon} aria-hidden="true">
                          <Icon size={17} strokeWidth={1.9} />
                        </span>
                        <span className={styles.itemLabel}>{item.label}</span>
                        {item.badge !== undefined && item.badge > 0 && (
                          <span className={styles.badge} aria-label={`${item.badge} need attention`}>
                            {item.badge > 99 ? '99+' : item.badge}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className={styles.footer}>
          <div className={styles.statusRow}>
            <div className={[styles.status, styles[`status_${tone}`]].join(' ')}>
              <span className={styles.statusDot} aria-hidden="true" />
              <div className={styles.statusText}>
                <span className={styles.statusLabel}>{monitoringLabel(state)}</span>
                {monitoring && (
                  <span className={styles.statusMeta}>
                    {monitoring.folderCount} {folderWord}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              className={styles.monitorBtn}
              onClick={onToggleMonitoring}
              disabled={busy || !monitoring}
              aria-label={active ? 'Pause monitoring' : 'Resume monitoring'}
              title={active ? 'Pause monitoring' : 'Resume monitoring'}
            >
              {active ? <Pause size={15} /> : <Play size={15} />}
            </button>
          </div>

          <div className={styles.utilRow}>
            <button
              type="button"
              className={[styles.utilBtn, route === 'onboarding' ? styles.utilBtnActive : ''].filter(Boolean).join(' ')}
              onClick={() => navigate('onboarding')}
              title="Set up the folder MySort watches"
            >
              <FolderOpen size={15} />
              <span>Setup</span>
            </button>
          </div>

          <div className={styles.osRow}>
            <a
              className={styles.osLink}
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`View the source code on GitHub — ${githubUrl}`}
              aria-label="View MySort on GitHub"
            >
              <GithubMark size={13} />
              <span>GitHub</span>
              <Star size={11} className={styles.osStar} />
            </a>
            <span className={styles.osSep} aria-hidden="true">·</span>
            <span className={styles.osItem} title="MIT License">
              <Scale size={12} />
              <span>MIT</span>
            </span>
            <span className={styles.osSep} aria-hidden="true">·</span>
            <span className={styles.osItem} title={`Version ${version}`}>
              v{version}
            </span>
          </div>
        </div>
      </nav>
    </>
  )
}

export default Sidebar

/**
 * Default navigation model. Grouping gives the sidebar a readable rhythm.
 *
 * Only the four modules that are useful on their own live here: Overview,
 * Rules, History and Settings. The Review (approve pending moves) and Recovery
 * (finish interrupted moves) screens are not places you visit for their own
 * sake — they only have something to show when the work exists — so they are
 * surfaced as contextual entry points from Overview instead of as permanent nav
 * items. That keeps the rail short and stops those two screens from reading as
 * "empty" on a quiet day.
 */
export function defaultNavGroups(attentionCount: number): { label: string; items: NavEntry[] }[] {
  return [
    {
      label: 'Organize',
      items: [
        { route: 'overview', label: 'Overview', icon: LayoutDashboard, description: 'What MySort has been doing' },
        { route: 'rules', label: 'Rules', icon: ListChecks, description: 'Which files go where' },
        { route: 'history', label: 'History', icon: HistoryIcon, description: 'Past moves, undo and retry', badge: attentionCount },
      ],
    },
    {
      label: 'App',
      items: [
        { route: 'settings', label: 'Settings', icon: SettingsIcon, description: 'Folders, notifications and diagnostics' },
      ],
    },
  ]
}

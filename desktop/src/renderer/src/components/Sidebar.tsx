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
  Inbox as InboxIcon,
  Lightbulb,
  Search as SearchIcon,
  CopyCheck,
  Layers,
} from 'lucide-react'
import GithubMark from './GithubMark'
import Logo from './Logo'
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
            <Logo size={36} />
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
 * "Organize" holds the screens you use to decide where files go. "Discover"
 * holds the ones that look at what you already have: local search, exact
 * duplicate detection and collections. Suggestions sit next to Rules because
 * a suggestion is a proposed rule.
 */
export function defaultNavGroups(attentionCount: number): { label: string; items: NavEntry[] }[] {
  return [
    {
      label: 'Organize',
      items: [
        { route: 'overview', label: 'Overview', icon: LayoutDashboard, description: 'What MySort has been doing' },
        { route: 'inbox', label: 'Inbox', icon: InboxIcon, description: 'Review what MySort would do next' },
        { route: 'rules', label: 'Rules', icon: ListChecks, description: 'Which files go where' },
        { route: 'suggestions', label: 'Suggestions', icon: Lightbulb, description: 'Rules MySort noticed in your moves' },
        { route: 'history', label: 'History', icon: HistoryIcon, description: 'Past moves, undo and retry', badge: attentionCount },
      ],
    },
    {
      label: 'Discover',
      items: [
        { route: 'search', label: 'Search', icon: SearchIcon, description: 'Find files on this computer' },
        { route: 'duplicates', label: 'Duplicates', icon: CopyCheck, description: 'Files with identical contents' },
        { route: 'collections', label: 'Collections', icon: Layers, description: 'Group files without moving them' },
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

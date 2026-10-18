import React from 'react'
import {
  Clock,
  FolderOpen,
  Monitor,
  RotateCcw,
  ShieldCheck,
  Bell,
} from 'lucide-react'
import type { SettingsTab } from '../routes'
import styles from './SettingsNav.module.css'

export const SETTINGS_TAB_ITEMS: readonly {
  id: SettingsTab
  label: string
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>
}[] = [
  { id: 'folders', label: 'Folders', icon: FolderOpen },
  { id: 'behaviour', label: 'Behaviour', icon: Clock },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'startup', label: 'Windows & startup', icon: Monitor },
  { id: 'diagnostics', label: 'Diagnostics', icon: ShieldCheck },
  { id: 'reset', label: 'Reset', icon: RotateCcw },
]

/**
 * The Settings screen's own tab bar: one short page per concern instead of a
 * single long scroll. It renders as a row of sibling buttons so the whole
 * section is reachable with plain tab stops.
 */
const SettingsNav: React.FC<{
  tab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
}> = ({ tab, onTabChange }) => {
  return (
    <nav className={styles.tabs} role="tablist" aria-label="Settings sections">
      {SETTINGS_TAB_ITEMS.map((item) => {
        const Icon = item.icon
        const active = tab === item.id
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`settings-tab-${item.id}`}
            aria-selected={active}
            aria-controls="settings-tabpanel"
            className={[styles.tab, active ? styles.tabActive : ''].filter(Boolean).join(' ')}
            onClick={() => onTabChange(item.id)}
          >
            <Icon size={14} strokeWidth={1.9} />
            {item.label}
          </button>
        )
      })}
    </nav>
  )
}

export default SettingsNav

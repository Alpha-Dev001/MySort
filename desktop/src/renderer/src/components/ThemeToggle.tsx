import React, { useCallback, useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { isSystem, resolve, setPreference, subscribe, type ResolvedTheme } from '../lib/theme'
import styles from './ThemeToggle.module.css'

/**
 * Light / dark switch.
 *
 * The icon shows what you would switch *to* (sun while dark, moon while
 * light), the accessible name says the same thing, and the glyph cross-fades
 * and rotates on change so the switch reads as deliberate without being slow.
 */
const ThemeToggle: React.FC = () => {
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolve())

  useEffect(() => {
    // The store is initialised in main.tsx before first paint; here we only
    // mirror later changes (including an OS switch while on "system").
    setTheme(resolve())
    return subscribe(setTheme)
  }, [])

  const toggle = useCallback(() => {
    setPreference(theme === 'dark' ? 'light' : 'dark')
  }, [theme])

  const goingTo = theme === 'dark' ? 'light' : 'dark'
  const label = goingTo === 'dark' ? 'Dark mode' : 'Light mode'

  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={toggle}
      aria-label={`Switch to ${goingTo} mode`}
      title={isSystem() ? `${label} (currently following the system)` : label}
      data-state={theme}
    >
      <span className={styles.iconWrap} aria-hidden="true">
        <Sun size={15} className={[styles.icon, styles.sun].join(' ')} />
        <Moon size={15} className={[styles.icon, styles.moon].join(' ')} />
      </span>
      <span className={styles.label}>{label}</span>
    </button>
  )
}

export default ThemeToggle
import React from 'react'
import { Menu } from 'lucide-react'
import Logo from './Logo'
import ThemeToggle from './ThemeToggle'
import styles from './TopBar.module.css'

export interface TopBarProps {
  /** Page title for the current route; rendered as the document's single h1. */
  title: string
  /** Compact tier: the off-canvas drawer needs its own opener in the bar. */
  narrow: boolean
  drawerOpen: boolean
  onOpenDrawer: () => void
}

/**
 * Static content-area top bar. It is mounted once by the shell above the
 * scrolling column, so the page title and the theme switch never scroll away
 * and there is exactly one h1 on screen. The strip doubles as the window's
 * drag region — the whole app is frameless — and its interactive children
 * opt out explicitly. `--window-controls-w` reserves the corner where the
 * native min/max/close overlay lives.
 */
const TopBar: React.FC<TopBarProps> = ({ title, narrow, drawerOpen, onOpenDrawer }) => {
  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        {/* The sidebar carries the logo, but it is off-canvas at this tier —
            so the bar shows it instead, or the window would have no identity
            of its own. */}
        {narrow && <Logo size={28} className={styles.logo} />}
        {narrow && (
          <button
            type="button"
            className={styles.drawerBtn}
            onClick={onOpenDrawer}
            aria-label="Open navigation menu"
            aria-expanded={drawerOpen}
            aria-controls="primary-nav"
          >
            <Menu size={17} />
            <span>Menu</span>
          </button>
        )}
        <h1 className={styles.title}>{title}</h1>
      </div>

      <div className={styles.right}>
        <ThemeToggle />
      </div>
    </div>
  )
}

export default TopBar

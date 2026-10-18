import React from 'react'
import type { Tone } from '../lib/format'
import styles from './StatusPill.module.css'

export interface StatusPillProps {
  tone?: Tone
  children: React.ReactNode
  /** Renders a leading dot; useful for live states. */
  dot?: boolean
  size?: 'sm' | 'md'
  title?: string
  className?: string
}

/**
 * A small tonal badge. Colour is never the only signal — every pill carries a
 * text label, so status stays legible for colour-blind users and in
 * high-contrast modes.
 */
const StatusPill: React.FC<StatusPillProps> = ({ tone = 'neutral', children, dot, size = 'md', title, className }) => {
  return (
    <span
      title={title}
      className={[styles.pill, styles[tone], size === 'sm' ? styles.sm : '', className].filter(Boolean).join(' ')}
    >
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  )
}

export default StatusPill
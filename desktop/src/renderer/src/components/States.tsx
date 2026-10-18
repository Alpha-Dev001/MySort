import React from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import Button from './Button'
import styles from './States.module.css'

// ---------------------------------------------------------------------------
// Loading — skeletons that match the final layout, so nothing shifts on load
// ---------------------------------------------------------------------------

export function Skeleton({
  width,
  height = 12,
  radius = 'var(--r-xs)',
  className = '',
}: {
  width?: number | string
  height?: number | string
  radius?: string
  className?: string
}): React.ReactElement {
  return <span className={[styles.skeleton, className].filter(Boolean).join(' ')} style={{ width, height, borderRadius: radius }} />
}

export function SkeletonRows({
  rows = 4,
  columns = 3,
}: {
  rows?: number
  columns?: number
}): React.ReactElement {
  return (
    <div className={styles.skeletonTable} aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className={styles.skeletonRow}>
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} height={11} width={c === 0 ? '52%' : c === 1 ? '32%' : '18%'} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function SkeletonCards({ count = 3, height = 92 }: { count?: number; height?: number }): React.ReactElement {
  return (
    <div className={styles.skeletonCards} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} height={height} radius="var(--r-xl)" />
      ))}
    </div>
  )
}

export function LoadingState({ label = 'Loading…', children }: { label?: string; children?: React.ReactNode }): React.ReactElement {
  return (
    <div className={styles.loading} role="status" aria-live="polite">
      <span className="srOnly">{label}</span>
      {children ?? <SkeletonRows />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty — says what is missing and what to do about it
// ---------------------------------------------------------------------------

export type EmptyStateTone = 'neutral' | 'brand' | 'success' | 'info' | 'warning'

export interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  /** Inline variant: tighter, left-aligned, for table bodies and settings rows. */
  compact?: boolean
  /** Tints the icon well. Defaults to `neutral`. */
  tone?: EmptyStateTone
}

export function EmptyState({ icon, title, description, action, compact, tone = 'neutral' }: EmptyStateProps): React.ReactElement {
  return (
    <div className={[styles.empty, compact ? styles.emptyCompact : ''].filter(Boolean).join(' ')}>
      {icon && (
        <div className={[styles.emptyIcon, styles[`emptyIcon_${tone}`]].join(' ')} aria-hidden="true">
          {icon}
        </div>
      )}
      <div className={styles.emptyText}>
        <p className={styles.emptyTitle}>{title}</p>
        {description && <p className={styles.emptyDescription}>{description}</p>}
        {action && <div className={styles.emptyAction}>{action}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Error — always offers the one action that can help
// ---------------------------------------------------------------------------

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  compact,
}: {
  title?: string
  message?: string | null
  onRetry?: () => void
  compact?: boolean
}): React.ReactElement {
  return (
    <div className={[styles.error, compact ? styles.emptyCompact : ''].filter(Boolean).join(' ')} role="alert">
      <div className={styles.errorIcon} aria-hidden="true">
        <AlertTriangle size={17} />
      </div>
      <div className={styles.emptyText}>
        <p className={styles.emptyTitle}>{title}</p>
        {message && <p className={styles.emptyDescription}>{message}</p>}
        {onRetry && (
          <div className={styles.emptyAction}>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              <RotateCcw size={13} /> Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Inline, non-blocking notice used inside panels. */
export function Notice({
  tone = 'info',
  icon,
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success' | 'brand'
  icon?: React.ReactNode
  title?: string
  children?: React.ReactNode
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <div className={[styles.notice, styles[`notice_${tone}`]].join(' ')}>
      {icon && <span className={styles.noticeIcon} aria-hidden="true">{icon}</span>}
      <div className={styles.noticeText}>
        {title && <p className={styles.noticeTitle}>{title}</p>}
        {children && <div className={styles.noticeBody}>{children}</div>}
      </div>
      {action && <div className={styles.noticeAction}>{action}</div>}
    </div>
  )
}
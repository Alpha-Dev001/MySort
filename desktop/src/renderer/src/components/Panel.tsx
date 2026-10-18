import React from 'react'
import { ArrowUpRight } from 'lucide-react'
import styles from './Panel.module.css'

export interface PanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** `plain` = no chrome (use inside an already-chromed surface). */
  tone?: 'raised' | 'sunken' | 'plain'
  /** Optional section heading rendered inside the panel. */
  title?: React.ReactNode
  description?: React.ReactNode
  /** Right-aligned slot in the panel header. */
  actions?: React.ReactNode
  /** Removes body padding — for tables that should bleed to the edges. */
  flush?: boolean
}

const Panel: React.FC<PanelProps> = ({
  tone = 'raised',
  title,
  description,
  actions,
  flush,
  className = '',
  children,
  ...rest
}) => {
  const hasHeader = title !== undefined || actions !== undefined
  return (
    <section
      {...rest}
      className={[styles.panel, styles[tone], flush ? styles.flush : '', className].filter(Boolean).join(' ')}
    >
      {hasHeader && (
        <header className={styles.header}>
          <div className={styles.headerText}>
            {title && <h2 className={styles.title}>{title}</h2>}
            {description && <p className={styles.description}>{description}</p>}
          </div>
          {actions && <div className={styles.headerActions}>{actions}</div>}
        </header>
      )}
      <div className={styles.body}>{children}</div>
    </section>
  )
}

export default Panel

/** A titled group of related settings, using the FieldRow layout. */
export function Section({
  title,
  description,
  actions,
  children,
  className = '',
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <Panel
      tone="raised"
      className={className}
      title={title}
      description={description}
      actions={actions}
    >
      {children}
    </Panel>
  )
}

/** Horizontal group of stat tiles. */
export function StatGrid({ children, className = '' }: { children: React.ReactNode; className?: string }): React.ReactElement {
  return <div className={[styles.statGrid, className].filter(Boolean).join(' ')}>{children}</div>
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
  onClick,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  tone?: 'neutral' | 'brand' | 'warning' | 'danger'
  /** Small leading chip above the value, e.g. a 14px lucide glyph. */
  icon?: React.ReactNode
  onClick?: () => void
}): React.ReactElement {
  const body = (
    <>
      <span className={styles.statHead}>
        {icon && (
          <span className={styles.statIcon} aria-hidden="true">
            {icon}
          </span>
        )}
        <span className={styles.statLabel}>{label}</span>
      </span>
      <span className={[styles.statValue, tone !== 'neutral' ? styles[`statValue_${tone}`] : ''].filter(Boolean).join(' ')}>
        {value}
      </span>
      {hint && <span className={styles.statHint}>{hint}</span>}
    </>
  )
  if (onClick) {
    return (
      <button type="button" className={[styles.stat, styles.statInteractive].join(' ')} onClick={onClick}>
        {body}
        <span className={styles.statGo} aria-hidden="true">
          <ArrowUpRight size={14} />
        </span>
      </button>
    )
  }
  return <div className={styles.stat}>{body}</div>
}
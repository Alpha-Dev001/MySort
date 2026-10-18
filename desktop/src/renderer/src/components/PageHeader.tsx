import React from 'react'
import styles from './PageHeader.module.css'

export interface PageHeaderProps {
  description?: string
  /** Primary action for the page, and any secondary controls. */
  actions?: React.ReactNode
  /** Metadata row rendered under the description. */
  meta?: React.ReactNode
}

/**
 * The page's content-level lead: description, metadata and actions.
 *
 * The page title itself lives in the shell's static top bar (single h1 per
 * document), so this component never repeats it — content starts with the
 * lede and the actual page furniture.
 */
const PageHeader: React.FC<PageHeaderProps> = ({ description, actions, meta }) => {
  if (!description && !meta && !actions) return null
  return (
    <header className={styles.header}>
      {(description || meta) && (
        <div className={styles.text}>
          {description && <p className={styles.description}>{description}</p>}
          {meta && <div className={styles.meta}>{meta}</div>}
        </div>
      )}
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  )
}

export default PageHeader

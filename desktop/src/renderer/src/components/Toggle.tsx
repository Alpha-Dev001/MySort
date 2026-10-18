import React from 'react'
import styles from './Toggle.module.css'

export interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** Required: the switch has no visible text of its own. */
  label: string
  disabled?: boolean
  /** Rendered before the label in a settings row. */
  children?: React.ReactNode
  hint?: string
  className?: string
}

/**
 * A real `<button role="switch">`.
 *
 * The previous markup nested a switch inside a button, which is invalid and
 * produced two competing tab stops. This is one focusable control with a
 * keyboard-operable state, matching the native switch contract.
 */
const Toggle: React.FC<ToggleProps> = ({ checked, onChange, label, disabled, children, hint, className }) => {
  return (
    <div className={[styles.row, className].filter(Boolean).join(' ')}>
      {children !== undefined && (
        <div className={styles.text}>
          <span className={styles.label}>{children}</span>
          {hint && <span className={styles.hint}>{hint}</span>}
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={[styles.switch, checked ? styles.on : ''].filter(Boolean).join(' ')}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.knob} />
      </button>
    </div>
  )
}

export default Toggle
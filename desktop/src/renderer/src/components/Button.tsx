import React from 'react'
import styles from './Button.module.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Swaps the label for a spinner and blocks interaction. */
  loading?: boolean
  /** Square-ish control sized to `size`, for a single icon. */
  iconOnly?: boolean
}

/**
 * The one button in the app. Every variant carries the full interaction set —
 * hover, pressed, focus-visible, disabled and loading — so no screen has to
 * re-implement any of them.
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    iconOnly = false,
    disabled = false,
    className = '',
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[styles.btn, styles[variant], styles[size], iconOnly ? styles.iconOnly : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      {loading ? (
        <>
          <span className={styles.spinner} aria-hidden="true" />
          <span className={styles.spinnerLabel}>{typeof children === 'string' ? children : 'Working'}</span>
        </>
      ) : (
        children
      )}
    </button>
  )
})

export default Button

/** The same visual language as a button, for inline text actions. */
export function LinkButton({
  className = '',
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>): React.ReactElement {
  return (
    <button {...rest} type="button" className={[styles.link, className].filter(Boolean).join(' ')}>
      {children}
    </button>
  )
}
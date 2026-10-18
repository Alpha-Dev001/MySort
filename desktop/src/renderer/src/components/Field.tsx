import React from 'react'
import { Search, X } from 'lucide-react'
import styles from './Field.module.css'

// ---------------------------------------------------------------------------
// Field: label + control + help/error, vertically stacked
// ---------------------------------------------------------------------------

export interface FieldProps {
  label: string
  htmlFor?: string
  help?: string
  error?: string | null
  /** Stretches the control to the full row width. */
  block?: boolean
  children: React.ReactNode
}

export function Field({ label, htmlFor, help, error, block = true, children }: FieldProps): React.ReactElement {
  return (
    <div className={[styles.field, block ? '' : styles.inline].filter(Boolean).join(' ')}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
      </label>
      <div className={styles.control}>{children}</div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : (
        help && <p className={styles.help}>{help}</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row: horizontal label/control pair used by settings
// ---------------------------------------------------------------------------

export interface FieldRowProps {
  label: React.ReactNode
  help?: string
  htmlFor?: string
  /**
   * Transient inline status for the control on this row, e.g. "Saving…".
   * Sits on the label line so appearing and disappearing never shifts layout.
   */
  status?: React.ReactNode
  children: React.ReactNode
}

export function FieldRow({ label, help, htmlFor, status, children }: FieldRowProps): React.ReactElement {
  return (
    <div className={styles.fieldRow}>
      <div className={styles.fieldRowText}>
        <span className={styles.rowLabelLine}>
          <label className={styles.rowLabel} htmlFor={htmlFor}>
            {label}
          </label>
          {status}
        </span>
        {help && <p className={styles.help}>{help}</p>}
      </div>
      <div className={styles.fieldRowControl}>{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TextInput
// ---------------------------------------------------------------------------

export interface TextInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  invalid?: boolean
  monospace?: boolean
  /** Renders a leading adornment, e.g. a search glyph. */
  adornment?: React.ReactNode
}

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid, monospace, adornment, className = '', ...rest },
  ref,
) {
  if (!adornment) {
    return (
      <input
        {...rest}
        ref={ref}
        aria-invalid={invalid || undefined}
        className={[styles.input, monospace ? styles.mono : '', invalid ? styles.invalid : '', className]
          .filter(Boolean)
          .join(' ')}
      />
    )
  }
  return (
    <div className={[styles.adorned, invalid ? styles.invalidWrap : ''].filter(Boolean).join(' ')}>
      <span className={styles.adornment} aria-hidden="true">
        {adornment}
      </span>
      <input
        {...rest}
        ref={ref}
        aria-invalid={invalid || undefined}
        className={[styles.input, styles.inputAdorned, monospace ? styles.mono : '', className]
          .filter(Boolean)
          .join(' ')}
      />
    </div>
  )
})

// ---------------------------------------------------------------------------
// SearchInput — debounced by the caller
// ---------------------------------------------------------------------------

export interface SearchInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  value: string
  onValueChange: (next: string) => void
}

export function SearchInput({
  value,
  onValueChange,
  className = '',
  placeholder = 'Search',
  ...rest
}: SearchInputProps): React.ReactElement {
  return (
    <div className={[styles.search, className].filter(Boolean).join(' ')}>
      <Search size={15} className={styles.searchIcon} aria-hidden="true" />
      <input
        {...rest}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        className={[styles.input, styles.inputAdorned].join(' ')}
      />
      {value && (
        <button type="button" className={styles.clear} onClick={() => onValueChange('')} aria-label="Clear search">
          <X size={13} />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Select — native element, restyled. Native keeps platform behaviour, a11y
// and keyboard support that a custom listbox would have to re-implement.
// ---------------------------------------------------------------------------

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: readonly (string | { value: string; label: string; disabled?: boolean })[]
  selectSize?: 'sm' | 'md'
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, selectSize = 'md', className = '', ...rest },
  ref,
) {
  return (
    <div className={[styles.selectWrap, selectSize === 'sm' ? styles.selectSm : ''].filter(Boolean).join(' ')}>
      <select {...rest} ref={ref} className={[styles.select, className].filter(Boolean).join(' ')}>
        {options.map((o) => {
          const value = typeof o === 'string' ? o : o.value
          const label = typeof o === 'string' ? o : o.label
          const disabled = typeof o === 'string' ? false : o.disabled
          return (
            <option key={value} value={value} disabled={disabled}>
              {label}
            </option>
          )
        })}
      </select>
      <svg className={styles.selectChevron} viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Segmented control — a small set of mutually exclusive options
// ---------------------------------------------------------------------------

export interface SegmentedProps<T extends string> {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (next: T) => void
  ariaLabel: string
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: SegmentedProps<T>): React.ReactElement {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={[styles.segment, value === o.value ? styles.segmentActive : ''].filter(Boolean).join(' ')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
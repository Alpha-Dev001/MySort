import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import Button from './Button'
import { useFocusTrap } from '../lib/hooks'
import styles from './Dialog.module.css'

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
}

interface ConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void
}

const ConfirmContext = React.createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null)

/**
 * Promise-based confirmation dialog.
 *
 * Confirmation used to be a button that did nothing; destructive actions now
 * go through this so the user always knows what is about to happen.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [state, setState] = useState<ConfirmState | null>(null)

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...options, resolve })),
    [],
  )

  const settle = useCallback(
    (value: boolean) => {
      setState((current) => {
        current?.resolve(value)
        return null
      })
    },
    [],
  )

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && <ConfirmDialog options={state} onSettle={settle} />}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = React.useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>')
  return ctx
}

export interface ModalProps {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children: React.ReactNode
  /** Rendered in the dialog's sticky footer (e.g. form action buttons). */
  footer?: React.ReactNode
  /** 'lg' (default) is wide enough for form grids. */
  size?: 'sm' | 'lg'
}

/**
 * Centered modal for form flows (e.g. creating a rule) so the page underneath
 * never reflows. Portalled, focus trapped, Escape-dismissible. The scrim is
 * deliberately NOT click-to-dismiss here: a stray click must not throw away a
 * half-typed form — the header button, Escape or the Cancel action close it.
 */
export function Modal({ open, title, description, onClose, children, footer, size = 'lg' }: ModalProps): React.ReactElement | null {
  const [mounted, setMounted] = useState(false)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => setMounted(true), [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useFocusTrap(mounted && open, panel)

  if (!mounted || !open) return null

  return createPortal(
    <div className={styles.backdrop}>
      <div
        ref={panel}
        tabIndex={-1}
        className={[styles.dialog, size === 'lg' ? styles.modalWide : ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={description ? 'modal-desc' : undefined}
      >
        <header className={styles.modalHead}>
          <div className={styles.modalHeadText}>
            <h2 id="modal-title" className={styles.modalTitle}>
              {title}
            </h2>
            {description && (
              <p id="modal-desc" className={styles.description}>
                {description}
              </p>
            )}
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close dialog">
            <X size={15} />
          </button>
        </header>
        <div className={styles.modalBody}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

function ConfirmDialog({ options, onSettle }: { options: ConfirmState; onSettle: (v: boolean) => void }): React.ReactElement | null {
  const [mounted, setMounted] = useState(false)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => setMounted(true), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onSettle(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSettle])

  useFocusTrap(mounted, panel)

  if (!mounted) return null
  const danger = options.tone === 'danger'

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onSettle(false)}>
      <div
        ref={panel}
        tabIndex={-1}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={options.description ? 'confirm-desc' : undefined}
      >
        <div className={styles.body}>
          <h2 id="confirm-title" className={styles.title}>
            {options.title}
          </h2>
          {options.description && (
            <p id="confirm-desc" className={styles.description}>
              {options.description}
            </p>
          )}
        </div>
        <div className={styles.footer}>
          <Button variant="ghost" onClick={() => onSettle(false)}>
            {options.cancelLabel ?? 'Cancel'}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => onSettle(true)}>
            {options.confirmLabel ?? 'Confirm'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export interface DrawerProps {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}

/**
 * Side sheet used for secondary inspection (operation details). Portalled so
 * it escapes the content scroll container, and dismissible with Escape or a
 * click on the scrim.
 */
export function Drawer({ open, title, description, onClose, children, footer, width = 420 }: DrawerProps): React.ReactElement | null {
  const [mounted, setMounted] = useState(false)
  const panel = useRef<HTMLElement>(null)
  useEffect(() => setMounted(true), [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useFocusTrap(mounted && open, panel)

  if (!mounted || !open) return null

  return createPortal(
    <div className={styles.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        ref={panel}
        tabIndex={-1}
        className={styles.drawer}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className={styles.drawerHead}>
          <div className={styles.drawerHeadText}>
            <h2 className={styles.drawerTitle}>{title}</h2>
            {description && <p className={styles.drawerDescription}>{description}</p>}
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close panel">
            <X size={15} />
          </button>
        </header>
        <div className={styles.drawerBody}>{children}</div>
        {footer && <footer className={styles.drawerFoot}>{footer}</footer>}
      </aside>
    </div>,
    document.body,
  )
}

/** Label/value pair used inside the drawer. */
export function DetailRow({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }): React.ReactElement {
  return (
    <div className={styles.detailRow}>
      <dt className={styles.detailLabel}>{label}</dt>
      <dd className={[styles.detailValue, mono ? styles.detailMono : ''].filter(Boolean).join(' ')}>{children}</dd>
    </div>
  )
}
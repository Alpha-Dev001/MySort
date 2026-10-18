import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import styles from './Toast.module.css'

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  description?: string
}

interface ToastApi {
  push: (toast: Omit<Toast, 'id'>) => number
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const ICONS: Record<ToastKind, React.ReactNode> = {
  info: <Info size={15} />,
  success: <CheckCircle2 size={15} />,
  warning: <AlertTriangle size={15} />,
  error: <XCircle size={15} />,
}

const DURATION: Record<ToastKind, number> = {
  success: 3200,
  info: 4200,
  warning: 6000,
  // Errors stay until dismissed: the user has to actually read them.
  error: 0,
}

/**
 * A single, app-wide toast surface. Every mutation in the app reports its
 * outcome here, so success and failure are always visible somewhere even when
 * the user has scrolled away from the control they pressed.
 */
export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const seq = useRef(0)

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = ++seq.current
      setToasts((list) => [...list.slice(-3), { ...toast, id }])
      const duration = DURATION[toast.kind]
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        )
      }
      return id
    },
    [dismiss],
  )

  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach(clearTimeout)
      map.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}

function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }): React.ReactElement | null {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null

  return createPortal(
    <div className={styles.stack} role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  )
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }): React.ReactElement {
  const [leaving, setLeaving] = useState(false)
  const [paused, setPaused] = useState(false)

  // Errors persist; everything else gets a graceful exit animation.
  useEffect(() => {
    if (toast.kind === 'error' || paused) return
    const delay = DURATION[toast.kind]
    if (delay <= 0) return
    const timer = setTimeout(() => {
      setLeaving(true)
      setTimeout(() => onDismiss(toast.id), 200)
    }, delay)
    return () => clearTimeout(timer)
  }, [toast.id, toast.kind, paused, onDismiss])

  const close = (): void => {
    setLeaving(true)
    setTimeout(() => onDismiss(toast.id), 180)
  }

  const assertive = toast.kind === 'error' || toast.kind === 'warning'

  return (
    <div
      className={[styles.toast, styles[toast.kind], leaving ? styles.leaving : ''].filter(Boolean).join(' ')}
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className={styles.icon} aria-hidden="true">
        {ICONS[toast.kind]}
      </span>
      <div className={styles.body}>
        <p className={styles.title}>{toast.title}</p>
        {toast.description && <p className={styles.description}>{toast.description}</p>}
      </div>
      <button type="button" className={styles.close} onClick={close} aria-label="Dismiss notification">
        <X size={13} />
      </button>
    </div>
  )
}
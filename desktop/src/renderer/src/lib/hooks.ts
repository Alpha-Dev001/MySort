/**
 * Small renderer-side hooks shared by the screens.
 *
 * Nothing here reaches into Electron, the database or the engine — they only
 * deal with React state and the typed `Result` envelope the bridge returns.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Result } from '../api'

/** Keeps `value` from changing more often than `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (value === settled) return
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms, settled])
  return settled
}

export interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** Replace the local value without a round trip (after a mutation). */
  setData: (next: T | null) => void
  reload: () => void
}

/**
 * Loads a `Result`-returning bridge call and tracks loading/error state.
 *
 * Stale responses are discarded, so a slow request can never overwrite a newer
 * one — this is what makes the screens safe to re-run on every focus change.
 */
export function useAsync<T>(
  load: () => Promise<Result<T>>,
  deps: readonly unknown[] = [],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const runId = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    const id = ++runId.current
    let live = true
    setLoading(true)
    void (async () => {
      try {
        const result = await loadRef.current()
        if (!live || id !== runId.current) return
        if (result.ok) {
          setData(result.data)
          setError(null)
        } else {
          setError(result.error.message)
        }
      } catch (e) {
        if (!live || id !== runId.current) return
        setError(e instanceof Error ? e.message : 'Something went wrong.')
      } finally {
        if (live && id === runId.current) setLoading(false)
      }
    })()
    return () => {
      live = false
    }
    // Keyed on the caller's `deps` spread plus `nonce`. The loader is read
    // through a ref precisely so a new closure identity does not re-run it.
  }, [nonce, ...deps])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data, loading, error, setData, reload }
}

/** Tracks a narrow viewport width so the shell can switch to a drawer. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = (): void => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** Runs `handler` on Escape, for panels that behave like dialogs. */
export function useEscape(active: boolean, onEscape: () => void): void {
  const ref = useRef(onEscape)
  ref.current = onEscape
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        ref.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Makes a modal surface behave like one.
 *
 * `aria-modal="true"` is a promise to assistive technology that everything
 * outside the surface is inert. Declaring it while leaving the rest of the app
 * tabbable leaves keyboard users reaching controls hidden behind the overlay,
 * so the attribute and the behaviour have to ship together: this moves focus
 * into the surface, wraps Tab at its edges, marks the app root `inert`, and
 * returns focus to whatever was focused before it opened.
 */
export function useFocusTrap(active: boolean, containerRef: React.RefObject<HTMLElement | null>): void {
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const root = document.getElementById('root') as (HTMLElement & { inert?: boolean }) | null
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex !== -1)

    if (!container.contains(document.activeElement)) container.focus()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) {
        e.preventDefault()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const current = document.activeElement
      if (e.shiftKey && (current === first || current === container)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && current === last) {
        e.preventDefault()
        first.focus()
      }
    }

    if (root) root.inert = true
    container.addEventListener('keydown', onKey)
    return () => {
      container.removeEventListener('keydown', onKey)
      if (root) root.inert = false
      restoreRef.current?.focus()
    }
  }, [active, containerRef])
}
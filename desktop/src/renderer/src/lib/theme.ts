/**
 * Theme preference store.
 *
 * The OS preference is only the default. Once the user picks Light or Dark we
 * resolve the choice in JS and write `data-theme` on <html>, which is what the
 * token sheet keys off. Resolving in JS (rather than letting CSS read
 * `prefers-color-scheme` twice) keeps one source of truth and lets the choice
 * survive a reload.
 */

import { api } from '../api'
import type { ThemePreference } from '../../../shared/types'

const STORAGE_KEY = 'mysort.theme'

export type ResolvedTheme = 'light' | 'dark'

const listeners = new Set<(resolved: ResolvedTheme) => void>()
let preference: ThemePreference = 'system'

const darkQuery =
  typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

function read(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* storage may be unavailable; fall through to the default */
  }
  return 'system'
}

export function systemTheme(): ResolvedTheme {
  return darkQuery?.matches ? 'dark' : 'light'
}

export function getPreference(): ThemePreference {
  return preference
}

export function resolve(): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference
}

function paint(): ResolvedTheme {
  const resolved = resolve()
  document.documentElement.dataset.theme = resolved
  for (const listener of listeners) listener(resolved)
  return resolved
}

let booted = false

/** Reads the stored preference and applies it. Call once, before first paint. */
export function initTheme(): ResolvedTheme {
  preference = read()
  const resolved = paint()
  // Keep the native caption buttons tinted to match (main re-tints the overlay).
  void api.app.setTheme(preference)

  if (!booted) {
    booted = true
    darkQuery?.addEventListener('change', () => {
      if (preference === 'system') paint()
    })
  }
  return resolved
}

export function setPreference(next: ThemePreference): ResolvedTheme {
  preference = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* not fatal: the choice simply will not persist */
  }
  const resolved = paint()
  void api.app.setTheme(next)
  return resolved
}

/** True when following the OS, i.e. the toggle is currently pinned. */
export function isSystem(): boolean {
  return preference === 'system'
}

export function subscribe(listener: (resolved: ResolvedTheme) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
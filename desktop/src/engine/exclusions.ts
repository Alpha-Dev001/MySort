/**
 * Exclusions: what the index is not allowed to look at.
 *
 * These rules are about *reading metadata*, never about moving files. An
 * excluded path is simply not walked and not indexed; MySort still refuses to
 * move anything into or out of the protected system locations regardless of
 * what the index knows.
 *
 * Pure logic — no disk access.
 */

import { isInside, normalizePath, pathsEqual } from './pathSafety'

export interface ExcludeConfig {
  /** Absolute path prefixes that are never indexed. */
  excludedPaths: string[]
  /** Lowercase extensions, without a dot. */
  excludedExtensions: string[]
  /** Skip dotfiles and dot-directories. */
  excludeHidden: boolean
}

export const EMPTY_EXCLUDE: ExcludeConfig = {
  excludedPaths: [],
  excludedExtensions: [],
  excludeHidden: true,
}

/** Normalises a user-entered path list for fast, stable comparison. */
export function normalizeExcludedPaths(paths: string[]): string[] {
  const seen = new Set<string>()
  for (const p of paths) {
    if (typeof p !== 'string') continue
    const trimmed = p.trim()
    if (trimmed.length === 0) continue
    seen.add(normalizePath(trimmed).toLowerCase())
  }
  return [...seen].sort((a, b) => b.length - a.length)
}

/** Normalises an extension list: lowercase, no dots, no empties. */
export function normalizeExcludedExtensions(exts: string[]): string[] {
  const out = new Set<string>()
  for (const raw of exts) {
    if (typeof raw !== 'string') continue
    const value = raw.trim().toLowerCase().replace(/^\.+/, '')
    if (value.length === 0) continue
    out.add(value)
  }
  return [...out].sort()
}

/** Is this exact path (or something inside it) excluded? */
export function isExcludedPath(target: string, excludedPaths: string[]): boolean {
  const t = normalizePath(target).toLowerCase()
  for (const raw of excludedPaths) {
    const e = normalizePath(raw).toLowerCase()
    if (pathsEqual(t, e) || isInside(t, e)) return true
  }
  return false
}

/** Is this extension excluded? */
export function isExcludedExtension(ext: string, excludedExtensions: string[]): boolean {
  if (ext.length === 0) return false
  const lower = ext.toLowerCase()
  return excludedExtensions.some((e) => normalizePath(e).toLowerCase() === lower)
}

/**
 * Should this entry be skipped entirely?
 *
 * Order matters: the cheap name checks run before the path check, because the
 * path check is the expensive one and there are far more files than folders.
 */
export function isExcludedEntry(
  name: string,
  absolutePath: string,
  ext: string,
  config: ExcludeConfig
): boolean {
  if (config.excludeHidden && name.startsWith('.')) return true
  if (isExcludedExtension(ext, config.excludedExtensions)) return true
  return isExcludedPath(absolutePath, config.excludedPaths)
}

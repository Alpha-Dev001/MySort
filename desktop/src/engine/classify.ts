/**
 * Pure classification: extension normalization, candidate suffixes, category lookup.
 * No disk access, no I/O — fully unit-testable.
 */

import type { Category } from '../shared/types'
import { CATEGORY_LABELS, DEFAULT_EXTENSION_CATEGORY } from './defaultRules'

export type NormalizeResult = { ok: true; ext: string } | { ok: false; reason: string }

/**
 * Normalizes a user-supplied extension: trim, lowercase, strip leading dots.
 * Allowed: a-z 0-9 _ + - and internal dots (compound types like tar.gz).
 */
export function normalizeExtension(raw: string): NormalizeResult {
  const trimmed = raw.trim().toLowerCase().replace(/^\.+/, '')
  if (trimmed.length === 0) return { ok: false, reason: 'empty extension' }
  if (trimmed.length > 40) return { ok: false, reason: 'extension is too long' }
  if (/\s/.test(trimmed)) return { ok: false, reason: 'extensions cannot contain spaces' }
  if (/[*?[\]{}]/.test(trimmed)) return { ok: false, reason: 'wildcards are not allowed' }
  if (/[/\\]/.test(trimmed)) return { ok: false, reason: 'path separators are not allowed' }
  if (!/^[a-z0-9_+-]+(\.[a-z0-9_+-]+)*$/.test(trimmed)) {
    return { ok: false, reason: 'only letters, digits, _ + - and internal dots are allowed' }
  }
  return { ok: true, ext: trimmed }
}

/**
 * Candidate suffixes for a file name, longest first, lowercase, without the leading dot.
 * 'report.TAR.GZ' -> ['tar.gz', 'gz']; 'photo.jpg' -> ['jpg']; '.gitignore' -> [].
 */
export function candidateSuffixes(fileName: string): string[] {
  const lower = fileName.toLowerCase()
  const dot = lower.indexOf('.', 1) // ignore a leading dot (dotfiles have no extension)
  if (dot <= 0) return []
  const parts = lower.slice(dot + 1).split('.')
  if (parts.some((p) => p.length === 0)) return [] // 'file.' or 'a..b' — not a real extension
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join('.'))
  return out
}

/** Category for one normalized suffix, or null when unknown. */
export function categoryForSuffix(suffix: string): Category | null {
  return DEFAULT_EXTENSION_CATEGORY[suffix] ?? null
}

export interface Classification {
  /** null when the file has no usable extension (caller decides to skip). */
  category: Category | null
  /** The suffix that determined the category (longest match), when category != null. */
  matchedSuffix: string | null
}

/** Default-table classification by longest matching suffix. */
export function classifyFileName(fileName: string): Classification {
  for (const suffix of candidateSuffixes(fileName)) {
    const cat = categoryForSuffix(suffix)
    if (cat) return { category: cat, matchedSuffix: suffix }
  }
  const suffixes = candidateSuffixes(fileName)
  if (suffixes.length === 0) return { category: null, matchedSuffix: null }
  return { category: 'other', matchedSuffix: suffixes[0] }
}

/** Display name of a category's default destination folder. */
export function categoryFolderName(category: Category): string {
  return CATEGORY_LABELS[category]
}

/**
 * Search: turning a query model into SQL, and the matching rules behind it.
 *
 * Everything here is pure. The query model is an explicit set of filters —
 * there is no natural-language parsing, and no user text is ever interpolated
 * into SQL: values are always bound parameters, and the only interpolated
 * fragments are column names taken from a fixed whitelist.
 *
 * Fuzzy matching is a subsequence match ("rpt" matches "report.pdf") and is
 * expressed as a LIKE pattern with a wildcard between every character, so it
 * stays inside SQLite and paging and totals remain exact.
 */

import path from 'node:path'
import type { SearchQuery, SearchSort, SortOrder } from '../shared/types'

/** Escapes the LIKE metacharacters so a user's `%` or `_` is literal. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * The LIKE pattern for a text query.
 *
 * Normal: `%text%` (substring).
 * Fuzzy:  `%c%o%l%o%r%` (characters in order, anything between).
 */
export function likePattern(text: string, fuzzy: boolean): string {
  const escaped = escapeLike(text.trim())
  if (!fuzzy) return `%${escaped}%`
  return [...escaped].map((c) => `%${c}`).join('') + '%'
}

/** True when every character of `text` appears in `name`, in order. */
export function fuzzyMatch(name: string, text: string): boolean {
  const n = name.toLowerCase()
  const t = text.toLowerCase().trim()
  if (t.length === 0) return true
  let ti = 0
  for (let ni = 0; ni < n.length && ti < t.length; ni++) {
    if (n[ni] === t[ti]) ti++
  }
  return ti === t.length
}

/**
 * How well a name matches a text query. Higher is better.
 *
 * Used for the 'relevance' sort order. It is deliberately simple: an exact
 * name beats a prefix, which beats a substring, which beats a fuzzy hit.
 */
export function relevanceScore(name: string, text: string): number {
  const n = name.toLowerCase()
  const t = text.trim().toLowerCase()
  if (t.length === 0) return 0
  if (n === t) return 100
  if (n.startsWith(t)) return 80
  if (n.includes(t)) return 60
  if (fuzzyMatch(n, t)) return 40
  return 0
}

const SORT_COLUMNS: Record<SearchSort, string> = {
  name: 'name COLLATE NOCASE',
  modified: 'mtime_ms',
  size: 'size_bytes',
  relevance: 'relevance',
}

export interface SearchSql {
  where: string[]
  params: unknown[]
  orderBy: string
  limit: number
  offset: number
  /** Present only for the 'relevance' sort. */
  relevance?: { expr: string; params: unknown[] }
}

/**
 * Builds the WHERE clause, parameters and ORDER BY for a search query.
 *
 * Every user-provided value becomes a bound parameter. The relevance
 * expression carries its own parameters, kept separate from the WHERE
 * parameters so the same query can be used for both the row query and the
 * count query.
 */
export function buildSearchSql(query: SearchQuery): SearchSql {
  const where: string[] = []
  const params: unknown[] = []
  let relevance: { expr: string; params: unknown[] } | undefined

  const text = (query.text ?? '').trim()
  if (text.length > 0) {
    const fuzzy = query.fuzzy === true
    // The relevance expression is only needed when sorting by relevance.
    if (query.sort === 'relevance') {
      const escaped = escapeLike(text)
      relevance = {
        expr:
          `CASE WHEN name = ? THEN 100 WHEN name LIKE ? ESCAPE '\\' THEN 80 ` +
          `WHEN name LIKE ? ESCAPE '\\' THEN 60 ELSE 40 END`,
        params: [text, `${escaped}%`, `%${escaped}%`],
      }
    }
    where.push(`name LIKE ? ESCAPE '\\'`)
    params.push(likePattern(text, fuzzy))
  }

  const extensions = (query.extensions ?? []).map((e) => e.trim().toLowerCase().replace(/^\.+/, '')).filter((e) => e.length > 0)
  if (extensions.length > 0) {
    where.push(`ext IN (${extensions.map(() => '?').join(', ')})`)
    params.push(...extensions)
  }

  const parentDir = (query.parentDir ?? '').trim()
  if (parentDir.length > 0) {
    // A directory means "this folder and everything below it". The pattern is
    // escaped for LIKE and anchored on a path separator, so "C:\Docs" does not
    // also match "C:\Documents".
    const escaped = escapeLike(parentDir)
    const sep = path.sep === '\\' ? '\\\\' : '/'
    where.push(`(parent_dir = ? COLLATE NOCASE OR parent_dir LIKE ? ESCAPE '\\')`)
    params.push(parentDir, `${escaped}${sep}%`)
  }

  if (typeof query.sizeMin === 'number') {
    where.push('size_bytes >= ?')
    params.push(query.sizeMin)
  }
  if (typeof query.sizeMax === 'number') {
    where.push('size_bytes <= ?')
    params.push(query.sizeMax)
  }
  if (typeof query.modifiedAfter === 'number') {
    where.push('mtime_ms >= ?')
    params.push(query.modifiedAfter)
  }
  if (typeof query.modifiedBefore === 'number') {
    where.push('mtime_ms <= ?')
    params.push(query.modifiedBefore)
  }
  if (typeof query.createdAfter === 'number') {
    where.push('ctime_ms >= ?')
    params.push(query.createdAfter)
  }
  if (typeof query.createdBefore === 'number') {
    where.push('ctime_ms <= ?')
    params.push(query.createdBefore)
  }

  const sort: SearchSort = query.sort ?? 'modified'
  const order: SortOrder = query.order ?? 'desc'
  const direction = order === 'asc' ? 'ASC' : 'DESC'
  // The tie-break on path keeps the ordering total, so paging never serves
  // the same row twice or drops one.
  const orderBy =
    sort === 'relevance'
      ? `relevance ${direction}, name COLLATE NOCASE ASC`
      : `${SORT_COLUMNS[sort]} ${direction}, path COLLATE NOCASE ASC`

  return {
    where,
    params,
    orderBy,
    limit: Math.min(Math.max(query.limit ?? 50, 1), 200),
    offset: Math.max(query.offset ?? 0, 0),
    relevance,
  }
}

/**
 * Human-readable description of a relative period, used by the search screen
 * to fill in the date fields from a named range.
 */
export function relativePeriodStart(period: 'today' | 'week' | 'month' | 'quarter' | 'year'): number {
  const now = new Date()
  const start = new Date(now)
  switch (period) {
    case 'today':
      start.setHours(0, 0, 0, 0)
      break
    case 'week':
      start.setDate(start.getDate() - 7)
      break
    case 'month':
      start.setMonth(start.getMonth() - 1)
      break
    case 'quarter':
      start.setMonth(start.getMonth() - 3)
      break
    case 'year':
      start.setFullYear(start.getFullYear() - 1)
      break
  }
  return start.getTime()
}

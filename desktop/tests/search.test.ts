/**
 * Search: the query model, the SQL it produces, and the matching rules.
 *
 * These are the guarantees the search screen depends on: a user's text never
 * becomes SQL, fuzzy matching stays a subsequence match, and the ordering is
 * total so paging never serves the same row twice.
 */

import { describe, expect, it } from 'vitest'
import {
  buildSearchSql,
  escapeLike,
  fuzzyMatch,
  likePattern,
  relevanceScore,
  relativePeriodStart,
} from '../src/engine/search'

describe('escapeLike', () => {
  it('escapes the LIKE metacharacters so user text stays literal', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
    expect(escapeLike('back\\slash')).toBe('back\\\\slash')
    expect(escapeLike('plain')).toBe('plain')
  })
})

describe('likePattern', () => {
  it('is a substring match by default', () => {
    expect(likePattern('report', false)).toBe('%report%')
  })

  it('is a subsequence match when fuzzy', () => {
    // "rpt" matches "report" because the letters appear in order.
    expect(likePattern('rpt', true)).toBe('%r%p%t%')
  })

  it('keeps user wildcards literal', () => {
    expect(likePattern('100%', false)).toBe('%100\\%%')
  })
})

describe('fuzzyMatch', () => {
  it('matches characters in order', () => {
    expect(fuzzyMatch('report-final.pdf', 'rpt')).toBe(true)
    expect(fuzzyMatch('quarterly-report.pdf', 'qrt')).toBe(true)
  })

  it('does not match out of order', () => {
    expect(fuzzyMatch('report.pdf', 'tpr')).toBe(false)
  })

  it('is case insensitive', () => {
    expect(fuzzyMatch('Report.PDF', 'rpt')).toBe(true)
  })

  it('matches an empty query', () => {
    expect(fuzzyMatch('anything', '')).toBe(true)
  })
})

describe('relevanceScore', () => {
  it('ranks an exact name highest', () => {
    const exact = relevanceScore('report', 'report')
    const prefix = relevanceScore('report.pdf', 'report')
    const contains = relevanceScore('my-report.pdf', 'report')
    const fuzzy = relevanceScore('replied-port.pdf', 'rpt')
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(contains)
    expect(contains).toBeGreaterThan(fuzzy)
  })
})

describe('buildSearchSql', () => {
  it('produces no clauses for an empty query', () => {
    const sql = buildSearchSql({})
    expect(sql.where).toHaveLength(0)
    expect(sql.params).toHaveLength(0)
    expect(sql.limit).toBe(50)
    expect(sql.offset).toBe(0)
  })

  it('binds the text as a parameter, never as SQL', () => {
    const sql = buildSearchSql({ text: "'; DROP TABLE file_index; --" })
    expect(sql.where[0]).toContain('name LIKE ?')
    // The dangerous text is a value, not part of the statement. The
    // underscore is escaped for LIKE, which is what keeps it literal.
    expect(sql.params[0]).toBe("%'; DROP TABLE file\\_index; --%")
    expect(sql.where.join(' ')).not.toContain('DROP TABLE')
  })

  it('escapes LIKE metacharacters in the bound pattern', () => {
    const sql = buildSearchSql({ text: '50%' })
    expect(sql.params[0]).toBe('%50\\%%')
  })

  it('filters by extension', () => {
    const sql = buildSearchSql({ extensions: ['PDF', '.png'] })
    expect(sql.where[0]).toContain('ext IN (?, ?)')
    expect(sql.params).toEqual(['pdf', 'png'])
  })

  it('filters by size range', () => {
    const sql = buildSearchSql({ sizeMin: 1024, sizeMax: 4096 })
    expect(sql.params).toEqual([1024, 4096])
    expect(sql.where).toHaveLength(2)
  })

  it('filters by modification and creation windows', () => {
    const sql = buildSearchSql({
      modifiedAfter: 1000,
      modifiedBefore: 2000,
      createdAfter: 500,
      createdBefore: 3000,
    })
    expect(sql.params).toEqual([1000, 2000, 500, 3000])
  })

  it('scopes to a folder and everything below it', () => {
    const sql = buildSearchSql({ parentDir: 'C:\\Users\\Alex\\Docs' })
    expect(sql.where[0]).toContain('parent_dir = ?')
    expect(sql.params[0]).toBe('C:\\Users\\Alex\\Docs')
    expect(String(sql.params[1])).toContain('%')
  })

  it('orders by the requested column and always breaks ties on the path', () => {
    const byName = buildSearchSql({ sort: 'name', order: 'asc' })
    expect(byName.orderBy).toContain('name COLLATE NOCASE ASC')
    expect(byName.orderBy).toContain('path COLLATE NOCASE ASC')

    const bySize = buildSearchSql({ sort: 'size', order: 'desc' })
    expect(bySize.orderBy).toContain('size_bytes DESC')
  })

  it('produces a relevance expression only when sorting by relevance', () => {
    expect(buildSearchSql({ text: 'x' }).relevance).toBeUndefined()
    const relevant = buildSearchSql({ text: 'x', sort: 'relevance' })
    expect(relevant.relevance).toBeDefined()
    expect(relevant.relevance?.params).toHaveLength(3)
    // The relevance parameters are separate from the WHERE parameters.
    expect(relevant.params).toHaveLength(1)
  })

  it('clamps hostile limits and offsets', () => {
    expect(buildSearchSql({ limit: 0 }).limit).toBe(1)
    expect(buildSearchSql({ limit: 100_000 }).limit).toBe(200)
    expect(buildSearchSql({ offset: -10 }).offset).toBe(0)
  })
})

describe('relativePeriodStart', () => {
  it('starts today at midnight', () => {
    const start = relativePeriodStart('today')
    const d = new Date(start)
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
  })

  it('moves further back for longer periods', () => {
    const week = relativePeriodStart('week')
    const year = relativePeriodStart('year')
    expect(year).toBeLessThan(week)
  })
})

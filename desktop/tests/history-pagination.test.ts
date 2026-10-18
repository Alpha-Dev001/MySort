/**
 * History paging.
 *
 * The history table is the one screen that grows without bound, so paging is a
 * correctness concern rather than a nicety: an unstable sort silently drops and
 * repeats rows as the user pages, and a wrong `total` renders page controls
 * that point at rows that do not exist.
 *
 * These tests pin the three properties the renderer relies on:
 *   1. `total` counts the filtered set, not the page.
 *   2. Ordering is total and deterministic — ties on `created_at` break by id,
 *      because files moved in the same millisecond are the normal case.
 *   3. Walking every page returns each row exactly once, in order.
 */

import Database from 'better-sqlite3'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { OperationsRepo } from '../src/db/repositories/operationsRepo'

const SCHEMA = readFileSync(new URL('../src/db/migrations/0001_init.sql', import.meta.url), 'utf8')
const PAGE_INDEX = readFileSync(new URL('../src/db/migrations/0002_page_index.sql', import.meta.url), 'utf8')

let db: Database.Database
let ops: OperationsRepo

/** Rows are inserted with explicit timestamps so ordering is deterministic. */
function insert(i: number, overrides: Partial<{ status: string; createdAt: string; fileName: string }> = {}): void {
  // Monotonic by default: row N is always newer than row N-1, the way real
  // history grows. Ties are only ever produced by a test that asks for them.
  const createdAt = overrides.createdAt ?? new Date(Date.UTC(2026, 2, 1) + i * 1000).toISOString()
  db.prepare(
    `INSERT INTO operations (
       id, initiated_by, file_name, source_path, planned_dest_path, rule_kind,
       rule_label, explanation, status, undo_status, created_at
     ) VALUES (?, 'auto', ?, ?, ?, 'default', 'Default', '', ?, 'available', ?)`,
  ).run(
    `op-${String(i).padStart(4, '0')}`,
    overrides.fileName ?? `file-${String(i).padStart(4, '0')}.pdf`,
    `C:\\Users\\Alex\\Downloads\\${i}.pdf`,
    `C:\\Users\\Alex\\Sorted\\${i}.pdf`,
    overrides.status ?? 'completed',
    createdAt,
  )
}

/** Walks the whole result set the way the UI does: page by page, until empty. */
function walkEveryPage(opts: { limit: number; status?: 'failed' | 'completed' }): string[] {
  const seen: string[] = []
  const pageCount = Math.ceil(ops.list({ limit: 1 }).total / opts.limit)
  for (let page = 1; page <= pageCount; page++) {
    const res = ops.list({ offset: (page - 1) * opts.limit, limit: opts.limit, status: opts.status })
    seen.push(...res.items.map((i) => i.id))
  }
  return seen
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(SCHEMA)
  db.exec(PAGE_INDEX)
  ops = new OperationsRepo(db)
})

afterEach(() => {
  db.close()
})

describe('history paging', () => {
  it('reports the filtered total, not the page size', () => {
    for (let i = 1; i <= 30; i++) insert(i)

    const first = ops.list({ limit: 10 })
    expect(first.items).toHaveLength(10)
    expect(first.total).toBe(30)
  })

  it('counts only the rows that match the filters', () => {
    for (let i = 1; i <= 10; i++) insert(i)
    for (let i = 11; i <= 16; i++) insert(i, { status: 'failed' })

    const failed = ops.list({ limit: 25, status: 'failed' })
    expect(failed.total).toBe(6)
    expect(failed.items).toHaveLength(6)
    expect(failed.items.every((o) => o.status === 'failed')).toBe(true)

    const searched = ops.list({ limit: 25, query: 'file-0001.pdf' })
    expect(searched.total).toBe(1)
    expect(searched.items[0]?.id).toBe('op-0001')
  })

  it('returns the newest rows first', () => {
    insert(1, { createdAt: '2026-01-01T00:00:00.000Z' })
    insert(2, { createdAt: '2026-03-01T00:00:00.000Z' })
    insert(3, { createdAt: '2026-02-01T00:00:00.000Z' })

    expect(ops.list({ limit: 10 }).items.map((o) => o.id)).toEqual(['op-0002', 'op-0003', 'op-0001'])
  })

  it('breaks ties on identical timestamps by id, so no row is served twice', () => {
    const sameMoment = '2026-03-01T09:00:00.000Z'
    // Four files moved in the same millisecond — a batch, not an edge case.
    for (let i = 1; i <= 4; i++) insert(i, { createdAt: sameMoment })

    const ids = walkEveryPage({ limit: 2 })
    expect(ids).toEqual(['op-0004', 'op-0003', 'op-0002', 'op-0001'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('hands out every row exactly once when walking page by page', () => {
    for (let i = 1; i <= 57; i++) insert(i)

    // 57 rows over pages of 25 leaves a deliberately short final page.
    const page1 = ops.list({ limit: 25 })
    const page2 = ops.list({ offset: 25, limit: 25 })
    const page3 = ops.list({ offset: 50, limit: 25 })

    expect(page1.items).toHaveLength(25)
    expect(page2.items).toHaveLength(25)
    expect(page3.items).toHaveLength(7)
    expect(page3.total).toBe(57)

    const ids = walkEveryPage({ limit: 25 })
    expect(ids).toHaveLength(57)
    expect(new Set(ids).size).toBe(57)
  })

  it('returns an empty page past the end but still reports the real total', () => {
    for (let i = 1; i <= 5; i++) insert(i)

    const past = ops.list({ offset: 500, limit: 25 })
    expect(past.items).toEqual([])
    // The renderer uses this to step back to the last page that exists.
    expect(past.total).toBe(5)
  })

  it('clamps hostile offsets and limits instead of trusting the caller', () => {
    for (let i = 1; i <= 5; i++) insert(i)

    expect(ops.list({ offset: -10, limit: 10 }).items).toHaveLength(5)
    expect(ops.list({ limit: 0 }).items.length).toBeGreaterThan(0)
    expect(ops.list({ limit: 100_000 }).items).toHaveLength(5)
  })

  it('keeps the filter applied to every page, not just the first', () => {
    for (let i = 1; i <= 30; i++) insert(i, { status: 'completed' })
    for (let i = 31; i <= 40; i++) insert(i, { status: 'failed' })

    const ids = walkEveryPage({ limit: 3, status: 'failed' })
    expect(ids).toHaveLength(10)
    expect(new Set(ids).size).toBe(10)
  })

  it('pages a large history without repeating or dropping rows', () => {
    for (let i = 1; i <= 500; i++) insert(i)

    const ids = walkEveryPage({ limit: 25 })
    expect(ids).toHaveLength(500)
    expect(new Set(ids).size).toBe(500)
    // Newest first, all the way down.
    expect(ids[0]).toBe('op-0500')
    expect(ids[ids.length - 1]).toBe('op-0001')
  })
})

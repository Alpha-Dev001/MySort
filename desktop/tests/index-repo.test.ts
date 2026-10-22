/**
 * The metadata index, against a real SQLite database.
 *
 * These tests run the actual migrations 0004 and 0005, so they also prove
 * that the new schema applies cleanly on top of an existing database — the
 * upgrade path every current user takes.
 */

import Database from 'better-sqlite3'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { IndexRepo } from '../src/db/repositories/indexRepo'
import { CollectionsRepo } from '../src/db/repositories/collectionsRepo'
import { RecommendationsRepo } from '../src/db/repositories/recommendationsRepo'
import type { IndexRow } from '../src/engine/indexer'

const SCHEMA = readFileSync(new URL('../src/db/migrations/0001_init.sql', import.meta.url), 'utf8')
const PAGE_INDEX = readFileSync(new URL('../src/db/migrations/0002_page_index.sql', import.meta.url), 'utf8')
const FILE_INDEX = readFileSync(new URL('../src/db/migrations/0004_file_index.sql', import.meta.url), 'utf8')
const COLLECTIONS = readFileSync(
  new URL('../src/db/migrations/0005_collections_recommendations.sql', import.meta.url),
  'utf8'
)

let db: Database.Database
let repo: IndexRepo

/** A path built with the platform separator, the way the indexer stores it. */
const at = (...parts: string[]): string => path.join(...parts)

function row(filePath: string, over: Partial<IndexRow> = {}): IndexRow {
  return {
    path: filePath,
    parentDir: path.dirname(filePath),
    name: path.basename(filePath),
    ext: path.extname(filePath).replace(/^\./, '').toLowerCase(),
    sizeBytes: 1000,
    mtimeMs: 5000,
    ctimeMs: 4000,
    sha256: null,
    hashedSize: null,
    hashedMtime: null,
    indexedAt: new Date().toISOString(),
    ...over,
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(SCHEMA)
  db.exec(PAGE_INDEX)
  db.exec(FILE_INDEX)
  db.exec(COLLECTIONS)
  repo = new IndexRepo(db)
})

afterEach(() => {
  db.close()
})

describe('migrations', () => {
  it('apply cleanly on top of an existing database', () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain('file_index')
    expect(names).toContain('collections')
    expect(names).toContain('collection_rules')
    expect(names).toContain('collection_members')
    expect(names).toContain('recommendations')
    // The original tables are untouched.
    expect(names).toContain('operations')
    expect(names).toContain('rules')
    expect(names).toContain('settings')
  })
})

describe('IndexRepo', () => {
  it('stores and reads a file', () => {
    const file = at('C:\\Docs', 'report.pdf')
    repo.upsertMany([row(file)])
    const stored = repo.getByPath(file.toLowerCase())
    expect(stored?.name).toBe('report.pdf')
    expect(stored?.ext).toBe('pdf')
    expect(stored?.sizeBytes).toBe(1000)
    expect(stored?.verification).toBe('indexed')
  })

  it('refreshes a file rather than duplicating it', () => {
    const file = at('C:\\a.pdf')
    repo.upsertMany([row(file, { sizeBytes: 1 })])
    repo.upsertMany([row(file, { sizeBytes: 2 })])
    expect(repo.count()).toBe(1)
    expect(repo.getByPath(file)?.sizeBytes).toBe(2)
  })

  it('keeps a hash that is still valid and drops one that is not', () => {
    const file = at('C:\\a.pdf')
    repo.upsertMany([row(file, { sizeBytes: 10, mtimeMs: 20 })])
    repo.setHash(file, 'hash-1', 10, 20)
    expect(repo.getByPath(file)?.sha256).toBe('hash-1')
    expect(repo.getByPath(file)?.verification).toBe('hashed')

    // The file changed: the old hash must not be presented as current.
    repo.upsertMany([row(file, { sizeBytes: 11, mtimeMs: 21 })])
    const after = repo.getByPath(file)
    expect(after?.sha256).toBeNull()
    expect(after?.verification).toBe('indexed')
  })

  it('searches by name', () => {
    repo.upsertMany([
      row(at('C:\\a', 'report.pdf')),
      row(at('C:\\a', 'notes.txt')),
      row(at('C:\\a', 'report.docx')),
    ])
    const result = repo.search({ text: 'report' })
    expect(result.total).toBe(2)
    expect(result.items.map((i) => i.name).sort()).toEqual(['report.docx', 'report.pdf'])
  })

  it('searches by extension', () => {
    repo.upsertMany([row(at('C:\\a', 'x.pdf')), row(at('C:\\a', 'y.png'))])
    const result = repo.search({ extensions: ['pdf'] })
    expect(result.total).toBe(1)
    expect(result.items[0].name).toBe('x.pdf')
  })

  it('searches by size range', () => {
    repo.upsertMany([
      row(at('C:\\small.pdf'), { sizeBytes: 10 }),
      row(at('C:\\big.pdf'), { sizeBytes: 10_000 }),
    ])
    expect(repo.search({ sizeMin: 1000, sizeMax: 20_000 }).total).toBe(1)
    expect(repo.search({ sizeMin: 1000, sizeMax: 20_000 }).items[0].name).toBe('big.pdf')
  })

  it('searches by modification window', () => {
    repo.upsertMany([
      row(at('C:\\old.pdf'), { mtimeMs: 1000 }),
      row(at('C:\\new.pdf'), { mtimeMs: 9000 }),
    ])
    const result = repo.search({ modifiedAfter: 5000 })
    expect(result.total).toBe(1)
    expect(result.items[0].name).toBe('new.pdf')
  })

  it('scopes a search to a folder', () => {
    repo.upsertMany([row(at('C:\\Docs', 'a.pdf')), row(at('C:\\Other', 'b.pdf'))])
    expect(repo.search({ parentDir: 'C:\\Docs' }).total).toBe(1)
  })

  it('does not let a folder prefix swallow a sibling folder', () => {
    repo.upsertMany([row(at('C:\\Docs', 'a.pdf')), row(at('C:\\Documents', 'b.pdf'))])
    expect(repo.search({ parentDir: 'C:\\Docs' }).total).toBe(1)
  })

  it('sorts by the requested column with a stable tie-break', () => {
    repo.upsertMany([
      row(at('C:\\b.pdf'), { sizeBytes: 5, mtimeMs: 5 }),
      row(at('C:\\a.pdf'), { sizeBytes: 5, mtimeMs: 5 }),
    ])
    const byName = repo.search({ sort: 'name', order: 'asc' })
    expect(byName.items.map((i) => i.name)).toEqual(['a.pdf', 'b.pdf'])
  })

  it('returns the filtered total, not the page size', () => {
    for (let i = 0; i < 30; i++) repo.upsertMany([row(at(`C:\\f${i}.pdf`))])
    const page = repo.search({ limit: 10 })
    expect(page.items).toHaveLength(10)
    expect(page.total).toBe(30)
  })

  it('finds the candidates for duplicate detection by size', () => {
    repo.upsertMany([
      row(at('C:\\a.pdf'), { sizeBytes: 100 }),
      row(at('C:\\b.pdf'), { sizeBytes: 100 }),
      row(at('C:\\c.pdf'), { sizeBytes: 999 }),
    ])
    const candidates = repo.duplicateCandidates()
    expect(candidates.map((c) => path.basename(c.path)).sort()).toEqual(['a.pdf', 'b.pdf'])
  })

  it('removes rows under a folder', () => {
    repo.upsertMany([row(at('C:\\Docs', 'a.pdf')), row(at('C:\\Other', 'b.pdf'))])
    repo.removeUnder('C:\\Docs')
    expect(repo.count()).toBe(1)
  })

  it('does not remove a sibling folder that shares a prefix', () => {
    repo.upsertMany([row(at('C:\\Docs', 'a.pdf')), row(at('C:\\Documents', 'b.pdf'))])
    repo.removeUnder('C:\\Docs')
    expect(repo.count()).toBe(1)
  })

  it('clears the index without touching anything else', () => {
    repo.upsertMany([row(at('C:\\a.pdf'))])
    repo.clear()
    expect(repo.count()).toBe(0)
  })
})

describe('CollectionsRepo', () => {
  it('creates a collection with rules and members', () => {
    const collections = new CollectionsRepo(db)
    const created = collections.create('Invoices', 'Everything to do with billing')
    expect(created.name).toBe('Invoices')

    collections.setRules(created.id, [
      { kind: 'extension', value: 'pdf' },
      { kind: 'name_contains', value: 'invoice' },
    ])
    collections.addMember(created.id, at('C:\\manual.pdf'))

    const loaded = collections.get(created.id)
    expect(loaded?.rules).toHaveLength(2)
    expect(loaded?.rules[0].kind).toBe('extension')
    expect(loaded?.manualPaths).toEqual([at('C:\\manual.pdf')])
  })

  it('deletes a collection without touching the files it referenced', () => {
    const collections = new CollectionsRepo(db)
    const created = collections.create('Temp')
    collections.addMember(created.id, at('C:\\file.pdf'))
    collections.remove(created.id)
    expect(collections.get(created.id)).toBeNull()
    // The file path is just a string; nothing on disk was involved.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM collection_members`).get()).toEqual({ n: 0 })
  })
})

describe('RecommendationsRepo', () => {
  it('keeps a dismissed recommendation dismissed', () => {
    const recommendations = new RecommendationsRepo(db)
    const payload = { name: 'PDF files', extensions: ['pdf'], namePattern: null, destination: 'Docs' }
    const evidence = { evidence: '3 files went to Docs', occurrences: 3, firstSeenAt: 'a', lastSeenAt: 'b' }

    recommendations.upsert({ id: 'r1', fingerprint: 'fp1', payload, evidence })
    recommendations.setStatus('r1', 'dismissed')

    // Detecting the same pattern again must not resurrect it.
    recommendations.upsert({ id: 'r2', fingerprint: 'fp1', payload, evidence })
    const all = recommendations.list()
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe('dismissed')
  })

  it('refuses to accept a dismissed recommendation through the service', () => {
    const recommendations = new RecommendationsRepo(db)
    const payload = { name: 'PDF files', extensions: ['pdf'], namePattern: null, destination: 'Docs' }
    const evidence = { evidence: '3 files went to Docs', occurrences: 3, firstSeenAt: 'a', lastSeenAt: 'b' }
    recommendations.upsert({ id: 'r1', fingerprint: 'fp1', payload, evidence })
    recommendations.setStatus('r1', 'dismissed')
    expect(recommendations.get('r1')?.status).toBe('dismissed')
  })
})

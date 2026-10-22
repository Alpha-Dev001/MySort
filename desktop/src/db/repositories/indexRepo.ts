/**
 * The local metadata index: storage and queries.
 *
 * The index stores paths, names, sizes, timestamps and optional content
 * hashes. It never stores file contents. Every row is a *cache* of what the
 * file system said at a point in time — the caller re-checks the file on disk
 * before acting on it.
 */

import type Database from 'better-sqlite3'
import path from 'node:path'
import { appError } from '../../shared/errors'
import type {
  IndexedFile,
  SearchQuery,
  VerificationState,
} from '../../shared/types'
import { buildSearchSql } from '../../engine/search'
import type { IndexRow, IndexWriter } from '../../engine/indexer'
import type { DuplicateCandidate } from '../../engine/duplicates'

interface RawIndexRow {
  path: string
  parent_dir: string
  name: string
  ext: string
  size_bytes: number
  mtime_ms: number
  ctime_ms: number
  sha256: string | null
  hashed_size: number | null
  hashed_mtime: number | null
}

function verificationOf(row: RawIndexRow): VerificationState {
  if (!row.sha256) return 'indexed'
  if (row.hashed_size === null || row.hashed_mtime === null) return 'stale'
  return row.hashed_size === row.size_bytes && row.hashed_mtime === row.mtime_ms
    ? 'hashed'
    : 'stale'
}

function mapRow(row: RawIndexRow): IndexedFile {
  return {
    path: row.path,
    parentDir: row.parent_dir,
    name: row.name,
    ext: row.ext,
    sizeBytes: row.size_bytes,
    modifiedMs: row.mtime_ms,
    createdMs: row.ctime_ms,
    sha256: row.sha256,
    verification: verificationOf(row),
  }
}

export interface SearchPage {
  items: IndexedFile[]
  total: number
}

export class IndexRepo implements IndexWriter {
  constructor(private readonly db: Database.Database) {}

  // ---------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------

  /**
   * Inserts or refreshes rows.
   *
   * The content hash is deliberately *not* overwritten: a re-scan knows the
   * size and the modification time, but not whether the bytes are still the
   * same ones that were hashed. The hash is cleared instead, so a stale hash
   * is never presented as current.
   */
  upsertMany(rows: IndexRow[]): void {
    if (rows.length === 0) return
    const stmt = this.db.prepare(
      `INSERT INTO file_index (
         path, parent_dir, name, ext, size_bytes, mtime_ms, ctime_ms, sha256,
         hashed_size, hashed_mtime, indexed_at
       ) VALUES (
         @path, @parentDir, @name, @ext, @sizeBytes, @mtimeMs, @ctimeMs, NULL,
         NULL, NULL, @indexedAt
       )
       ON CONFLICT(path) DO UPDATE SET
         parent_dir = excluded.parent_dir,
         name       = excluded.name,
         ext        = excluded.ext,
         size_bytes = excluded.size_bytes,
         mtime_ms   = excluded.mtime_ms,
         ctime_ms   = excluded.ctime_ms,
         -- The hash survives only while the file is byte-for-byte the file
         -- that was hashed; otherwise it is dropped rather than trusted.
         sha256 = CASE
           WHEN file_index.hashed_size = excluded.size_bytes
            AND file_index.hashed_mtime = excluded.mtime_ms
           THEN file_index.sha256 ELSE NULL END,
         hashed_size  = CASE
           WHEN file_index.hashed_size = excluded.size_bytes
            AND file_index.hashed_mtime = excluded.mtime_ms
           THEN file_index.hashed_size ELSE NULL END,
         hashed_mtime = CASE
           WHEN file_index.hashed_size = excluded.size_bytes
            AND file_index.hashed_mtime = excluded.mtime_ms
           THEN file_index.hashed_mtime ELSE NULL END,
         indexed_at  = excluded.indexed_at`
    )
    const tx = this.db.transaction((batch: IndexRow[]) => {
      for (const row of batch) {
        stmt.run({
          path: row.path,
          parentDir: row.parentDir,
          name: row.name,
          ext: row.ext,
          sizeBytes: row.sizeBytes,
          mtimeMs: row.mtimeMs,
          ctimeMs: row.ctimeMs,
          indexedAt: row.indexedAt,
        })
      }
    })
    tx(rows)
  }

  removePaths(paths: string[]): void {
    if (paths.length === 0) return
    const stmt = this.db.prepare(`DELETE FROM file_index WHERE path = ?`)
    const tx = this.db.transaction((batch: string[]) => {
      for (const p of batch) stmt.run(p)
    })
    tx(paths)
  }

  removeUnder(dir: string): void {
    // The pattern is escaped for LIKE and anchored on a path separator, so
    // removing "C:\Docs" does not also remove "C:\Documents".
    const escaped = dir.replace(/[\\%_]/g, (c) => `\\${c}`)
    const sep = path.sep === '\\' ? '\\\\' : '/'
    this.db
      .prepare(`DELETE FROM file_index WHERE path = ? COLLATE NOCASE OR path LIKE ? ESCAPE '\\'`)
      .run(dir, `${escaped}${sep}%`)
  }

  clear(): void {
    this.db.prepare(`DELETE FROM file_index`).run()
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM file_index`).get() as { n: number }
    return row.n
  }

  /** Records a content hash together with the metadata it was taken from. */
  setHash(filePath: string, hash: string, sizeBytes: number, mtimeMs: number): void {
    this.db
      .prepare(
        `UPDATE file_index SET sha256 = ?, hashed_size = ?, hashed_mtime = ?
         WHERE path = ? COLLATE NOCASE`
      )
      .run(hash, sizeBytes, mtimeMs, filePath)
  }

  // ---------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------

  getByPath(filePath: string): IndexedFile | null {
    const row = this.db
      .prepare(`SELECT * FROM file_index WHERE path = ? COLLATE NOCASE`)
      .get(filePath) as RawIndexRow | undefined
    return row ? mapRow(row) : null
  }

  search(query: SearchQuery): SearchPage {
    const built = buildSearchSql(query)
    const whereClause = built.where.length > 0 ? ` WHERE ${built.where.join(' AND ')}` : ''

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM file_index${whereClause}`)
        .get(...built.params) as { n: number }
    ).n

    const select = built.relevance ? `${built.relevance.expr} AS relevance,` : ''
    const selectParams = built.relevance ? built.relevance.params : []
    const orderBy = built.relevance
      ? built.orderBy.replace(/^relevance/, 'relevance')
      : built.orderBy

    const rows = this.db
      .prepare(
        `SELECT ${select} path, parent_dir, name, ext, size_bytes, mtime_ms, ctime_ms,
                sha256, hashed_size, hashed_mtime
         FROM file_index${whereClause}
         ORDER BY ${orderBy} LIMIT ? OFFSET ?`
      )
      .all(...selectParams, ...built.params, built.limit, built.offset) as RawIndexRow[]

    return { items: rows.map(mapRow), total }
  }

  recent(limit: number): IndexedFile[] {
    const rows = this.db
      .prepare(
        `SELECT path, parent_dir, name, ext, size_bytes, mtime_ms, ctime_ms,
                sha256, hashed_size, hashed_mtime
         FROM file_index ORDER BY indexed_at DESC, path COLLATE NOCASE ASC LIMIT ?`
      )
      .all(Math.min(Math.max(limit, 1), 100)) as RawIndexRow[]
    return rows.map(mapRow)
  }

  /**
   * Every file whose size is shared with at least one other indexed file.
   *
   * This is the candidate set for duplicate detection — nothing here is a
   * duplicate until its content hash matches.
   */
  duplicateCandidates(limit = 200): DuplicateCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT i.path, i.name, i.ext, i.size_bytes, i.mtime_ms, i.ctime_ms,
                i.sha256, i.hashed_size, i.hashed_mtime
         FROM file_index i
         JOIN (
           SELECT size_bytes FROM file_index
           WHERE size_bytes > 0
           GROUP BY size_bytes HAVING COUNT(*) > 1
         ) d ON d.size_bytes = i.size_bytes
         ORDER BY i.size_bytes DESC, i.path COLLATE NOCASE ASC
         LIMIT ?`
      )
      .all(Math.min(Math.max(limit, 1), 5000)) as {
      path: string
      name: string
      ext: string
      size_bytes: number
      mtime_ms: number
      ctime_ms: number
      sha256: string | null
      hashed_size: number | null
      hashed_mtime: number | null
    }[]
    return rows.map((r) => ({
      path: r.path,
      name: r.name,
      ext: r.ext,
      sizeBytes: r.size_bytes,
      modifiedMs: r.mtime_ms,
      createdMs: r.ctime_ms,
      sha256: r.sha256,
      hashedSize: r.hashed_size,
      hashedMtime: r.hashed_mtime,
    }))
  }

  /** Files whose recorded hash is no longer trustworthy. */
  staleHashCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM file_index
         WHERE sha256 IS NOT NULL
           AND (hashed_size IS NULL OR hashed_mtime IS NULL
                OR hashed_size <> size_bytes OR hashed_mtime <> mtime_ms)`
      )
      .get() as { n: number }
    return row.n
  }

  // ---------------------------------------------------------------------
  // Bookkeeping
  // ---------------------------------------------------------------------

  getState<T>(key: string): T | null {
    const row = this.db
      .prepare(`SELECT value_json FROM index_state WHERE state_key = ?`)
      .get(key) as { value_json: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.value_json) as T
    } catch {
      return null
    }
  }

  setState(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO index_state (state_key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value ?? null), new Date().toISOString())
  }

  /** Removes index rows for files that no longer exist. */
  pruneMissing(existingPaths: Set<string>): number {
    const rows = this.db.prepare(`SELECT path FROM file_index`).all() as { path: string }[]
    const gone = rows.map((r) => r.path).filter((p) => !existingPaths.has(p.toLowerCase()))
    if (gone.length === 0) return 0
    this.removePaths(gone)
    return gone.length
  }

  /** Used by the reset flow. */
  clearAll(): void {
    this.clear()
    this.db.prepare(`DELETE FROM index_state`).run()
  }

  assertWritable(): void {
    try {
      this.db.prepare(`SELECT 1 FROM file_index LIMIT 1`).get()
    } catch (e) {
      throw appError('DB_ERROR', `the file index is unavailable: ${(e as Error).message}`)
    }
  }
}

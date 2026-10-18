/** Monitored folders storage. Paths are unique case-insensitively (Windows). */

import type Database from 'better-sqlite3'
import { appError } from '../../shared/errors'
import type { FolderMode } from '../../shared/types'

export interface FolderRow {
  id: number
  path: string
  enabled: boolean
  mode: FolderMode
  auto_since: string | null
  last_reconciled_at: string | null
  created_at: string
  updated_at: string
}

interface RawFolderRow {
  id: number
  path: string
  enabled: number
  mode: string
  auto_since: string | null
  last_reconciled_at: string | null
  created_at: string
  updated_at: string
}

function mapFolder(r: RawFolderRow): FolderRow {
  return {
    id: r.id,
    path: r.path,
    enabled: r.enabled === 1,
    mode: r.mode === 'auto' ? 'auto' : 'manual',
    auto_since: r.auto_since,
    last_reconciled_at: r.last_reconciled_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export class FoldersRepo {
  constructor(private readonly db: Database.Database) {}

  list(): FolderRow[] {
    const rows = this.db.prepare(`SELECT * FROM monitored_folders ORDER BY id`).all() as RawFolderRow[]
    return rows.map(mapFolder)
  }

  listEnabled(): FolderRow[] {
    return this.list().filter((f) => f.enabled)
  }

  get(id: number): FolderRow | null {
    const row = this.db.prepare(`SELECT * FROM monitored_folders WHERE id = ?`).get(id) as
      | RawFolderRow
      | undefined
    return row ? mapFolder(row) : null
  }

  insert(input: { path: string; mode: FolderMode }): FolderRow {
    const now = new Date().toISOString()
    try {
      const result = this.db
        .prepare(
          `INSERT INTO monitored_folders (path, enabled, mode, auto_since, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?, ?)`
        )
        .run(input.path, input.mode, input.mode === 'auto' ? now : null, now, now)
      return this.get(Number(result.lastInsertRowid)) as FolderRow
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw appError('CONFLICT', 'this folder is already monitored')
      }
      throw e
    }
  }

  setMode(id: number, mode: FolderMode): FolderRow {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE monitored_folders
         SET mode = ?, auto_since = CASE WHEN ? = 'auto' THEN COALESCE(auto_since, ?) ELSE auto_since END, updated_at = ?
         WHERE id = ?`
      )
      .run(mode, mode, now, now, id)
    return this.get(id) as FolderRow
  }

  setEnabled(id: number, enabled: boolean): void {
    this.db
      .prepare(`UPDATE monitored_folders SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, new Date().toISOString(), id)
  }

  remove(id: number): void {
    this.db.prepare(`DELETE FROM monitored_folders WHERE id = ?`).run(id)
  }

  touchReconciled(id: number): void {
    this.db
      .prepare(`UPDATE monitored_folders SET last_reconciled_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id)
  }

  getCategoryDestinations(): Record<string, string> {
    const rows = this.db.prepare(`SELECT category, path FROM category_destinations`).all() as {
      category: string
      path: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.category, r.path]))
  }

  setCategoryDestination(category: string, destPath: string): void {
    this.db
      .prepare(
        `INSERT INTO category_destinations (category, path, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(category) DO UPDATE SET path = excluded.path, updated_at = excluded.updated_at`
      )
      .run(category, destPath, new Date().toISOString())
  }
}

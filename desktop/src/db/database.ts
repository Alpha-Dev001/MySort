/**
 * Database bootstrap: pragmas, forward-only migrations with backup, and the
 * "never touch a database from a newer version" refusal.
 *
 * PRAGMA synchronous = FULL makes SQLite flush to disk before a commit returns,
 * which matters because the intent record must be safely on disk before any
 * file is touched. The database is tiny, so the cost is negligible.
 */

import Database from 'better-sqlite3'
import { readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { appError, type AppError } from '../shared/errors'
import initSql from './migrations/0001_init.sql?raw'
import pageIndexSql from './migrations/0002_page_index.sql?raw'
import folderRenameSql from './migrations/0003_folder_rename.sql?raw'

export interface MigrationFile {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: MigrationFile[] = [
  { version: 1, name: 'init', sql: initSql },
  { version: 2, name: 'page_index', sql: pageIndexSql },
  { version: 3, name: 'folder_rename', sql: folderRenameSql },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/** Thrown when the database was created by a newer app version; never auto-reset. */
export class DatabaseFromFutureError extends Error {
  constructor(
    public readonly fileVersion: number,
    public readonly appVersion: number
  ) {
    super(`database schema v${fileVersion} is newer than this app (v${appVersion})`)
    this.name = 'DatabaseFromFutureError'
  }
}

export function isAppErrorLike(e: unknown): e is AppError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e
}

export function runMigrations(db: Database.Database, dbPath: string): void {
  // The ledger is bootstrapped here rather than in a migration file: it must
  // exist before any migration can record itself as applied.
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`
  )
  const hasMigrations = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
    .get()
  const userVersion = Number(db.pragma('user_version', { simple: true }))
  if (userVersion > LATEST_SCHEMA_VERSION) {
    throw new DatabaseFromFutureError(userVersion, LATEST_SCHEMA_VERSION)
  }

  const applied = hasMigrations
    ? (db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as {
        version: number
      }[]).map((r) => r.version)
    : []
  const pending = MIGRATIONS.filter((m) => !applied.includes(m.version))
  if (pending.length === 0) return

  backupBeforeMigrate(db, dbPath, userVersion)

  const insert = db.prepare(
    `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`
  )
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql)
      insert.run(migration.version, migration.name, new Date().toISOString())
      db.pragma(`user_version = ${migration.version}`)
    })()
  }
}

/** Copies the pre-migration database next to itself; keeps the last two backups. */
function backupBeforeMigrate(db: Database.Database, dbPath: string, fromVersion: number): void {
  try {
    const dir = path.dirname(dbPath)
    const backupPath = path.join(dir, `mysort.db.bak-v${fromVersion}`)
    rmSync(backupPath, { force: true })
    db.prepare(`VACUUM INTO ?`).run(backupPath)
    pruneOldBackups(dir)
  } catch {
    // A failed backup must not block startup; migrations are forward-only anyway.
  }
}

function pruneOldBackups(dir: string): void {
  const files = readdirSync(dir).filter((f) => /^mysort\.db\.bak-v\d+$/.test(f))
  if (files.length <= 2) return
  const sorted = files.sort((a, b) => {
    const va = Number(a.match(/v(\d+)$/)?.[1] ?? 0)
    const vb = Number(b.match(/v(\d+)$/)?.[1] ?? 0)
    return va - vb
  })
  for (const f of sorted.slice(0, sorted.length - 2)) {
    rmSync(path.join(dir, f), { force: true })
  }
}

export function openDatabase(dbPath: string): Database.Database {
  try {
    const db = new Database(dbPath)
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
    runMigrations(db, dbPath)
    return db
  } catch (e) {
    if (e instanceof DatabaseFromFutureError) throw e
    if (isAppErrorLike(e)) throw e
    throw appError('DB_ERROR', `could not open the database: ${(e as Error).message}`)
  }
}

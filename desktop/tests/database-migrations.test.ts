/**
 * The database bootstrap: forward-only migrations, backups, and the refusal to
 * open a database from a newer app.
 *
 * These run the real `openDatabase` against a temporary file, so they cover
 * the upgrade path every existing user takes — not a hand-written schema.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase, runMigrations, DatabaseFromFutureError, LATEST_SCHEMA_VERSION } from '../src/db/database'

let dir = ''
let dbPath = ''

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mysort-db-'))
  dbPath = path.join(dir, 'mysort.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('openDatabase', () => {
  it('creates the schema on a fresh profile', () => {
    const db = openDatabase(dbPath)
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as {
        name: string
      }[]
    ).map((t) => t.name)
    db.close()

    expect(tables).toContain('settings')
    expect(tables).toContain('operations')
    expect(tables).toContain('rules')
    expect(tables).toContain('monitored_folders')
    expect(tables).toContain('file_index')
    expect(tables).toContain('collections')
    expect(tables).toContain('recommendations')
  })

  it('records the schema version', () => {
    const db = openDatabase(dbPath)
    const version = db.pragma('user_version', { simple: true })
    const applied = db
      .prepare(`SELECT version FROM schema_migrations ORDER BY version`)
      .all() as { version: number }[]
    db.close()

    expect(version).toBe(LATEST_SCHEMA_VERSION)
    expect(applied.map((a) => a.version)).toEqual([1, 2, 3, 4, 5])
  })

  it('opens an existing database again without re-running the migrations', () => {
    const first = openDatabase(dbPath)
    first.prepare(`INSERT INTO settings (setting_key, value_json, updated_at) VALUES (?, ?, ?)`).run(
      'destinationRoot',
      '"C:\\\\Sorted"',
      new Date().toISOString()
    )
    first.close()

    const second = openDatabase(dbPath)
    const value = second
      .prepare(`SELECT value_json FROM settings WHERE setting_key = ?`)
      .get('destinationRoot') as { value_json: string }
    const applied = second
      .prepare(`SELECT version FROM schema_migrations ORDER BY version`)
      .all() as { version: number }[]
    second.close()

    // The user's setting survived, and the ledger was not duplicated.
    expect(value.value_json).toBe('"C:\\\\Sorted"')
    expect(applied).toHaveLength(LATEST_SCHEMA_VERSION)
  })

  it('refuses a database written by a newer app instead of corrupting it', () => {
    const db = new Database(dbPath)
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 5}`)
    db.close()

    expect(() => openDatabase(dbPath)).toThrow(DatabaseFromFutureError)
  })

  it('backs the database up before a migration runs', () => {
    // A database that is genuinely at version 1: the original schema and the
    // matching ledger row.
    const db = new Database(dbPath)
    db.exec(readFileSync(new URL('../src/db/migrations/0001_init.sql', import.meta.url), 'utf8'))
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    INTEGER PRIMARY KEY,
         name       TEXT NOT NULL,
         applied_at TEXT NOT NULL
       )`
    )
    db.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'init', ?)`).run(
      new Date().toISOString()
    )
    db.pragma(`user_version = 1`)
    db.close()

    const reopened = new Database(dbPath)
    runMigrations(reopened, dbPath)
    const version = reopened.pragma('user_version', { simple: true })
    reopened.close()

    expect(version).toBe(LATEST_SCHEMA_VERSION)
    const backups = readdirSync(dir).filter((f) => /^mysort\.db\.bak-v\d+$/.test(f))
    expect(backups).toContain('mysort.db.bak-v1')
    expect(existsSync(path.join(dir, 'mysort.db.bak-v1'))).toBe(true)
  })
})

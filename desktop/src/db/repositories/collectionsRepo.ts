/**
 * Collections: named sets of file references.
 *
 * A collection never owns a file. It stores paths — some derived from rules,
 * some added by hand — and resolves them against the index and the file
 * system on demand. Deleting a collection deletes nothing on disk.
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { appError } from '../../shared/errors'
import type { CollectionRule, FileCollection } from '../../shared/types'

interface RawCollectionRow {
  id: string
  name: string
  description: string
  created_at: string
  updated_at: string
}

export class CollectionsRepo {
  constructor(private readonly db: Database.Database) {}

  list(): FileCollection[] {
    const rows = this.db
      .prepare(`SELECT * FROM collections ORDER BY name COLLATE NOCASE ASC`)
      .all() as RawCollectionRow[]
    return rows.map((r) => this.hydrate(r))
  }

  get(id: string): FileCollection | null {
    const row = this.db.prepare(`SELECT * FROM collections WHERE id = ?`).get(id) as
      | RawCollectionRow
      | undefined
    return row ? this.hydrate(row) : null
  }

  create(name: string, description = ''): FileCollection {
    const now = new Date().toISOString()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO collections (id, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, name, description, now, now)
    return this.get(id) as FileCollection
  }

  remove(id: string): void {
    const result = this.db.prepare(`DELETE FROM collections WHERE id = ?`).run(id)
    if (result.changes === 0) throw appError('NOT_FOUND', 'collection not found')
  }

  setRules(id: string, rules: CollectionRule[]): void {
    if (!this.get(id)) throw appError('NOT_FOUND', 'collection not found')
    const now = new Date().toISOString()
    const insert = this.db.prepare(
      `INSERT INTO collection_rules (id, collection_id, position, kind, value, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM collection_rules WHERE collection_id = ?`).run(id)
      rules.forEach((rule, index) => {
        insert.run(randomUUID(), id, index + 1, rule.kind, rule.value, now)
      })
      this.db.prepare(`UPDATE collections SET updated_at = ? WHERE id = ?`).run(now, id)
    })
    tx()
  }

  addMember(id: string, filePath: string): void {
    if (!this.get(id)) throw appError('NOT_FOUND', 'collection not found')
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO collection_members (collection_id, path, added_at) VALUES (?, ?, ?)
         ON CONFLICT(collection_id, path) DO NOTHING`
      )
      .run(id, filePath, now)
    this.db.prepare(`UPDATE collections SET updated_at = ? WHERE id = ?`).run(now, id)
  }

  removeMember(id: string, filePath: string): void {
    this.db
      .prepare(`DELETE FROM collection_members WHERE collection_id = ? AND path = ? COLLATE NOCASE`)
      .run(id, filePath)
    this.db.prepare(`UPDATE collections SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
  }

  memberPaths(id: string): string[] {
    const rows = this.db
      .prepare(`SELECT path FROM collection_members WHERE collection_id = ? ORDER BY added_at DESC`)
      .all(id) as { path: string }[]
    return rows.map((r) => r.path)
  }

  private hydrate(row: RawCollectionRow): FileCollection {
    const rules = this.db
      .prepare(`SELECT kind, value FROM collection_rules WHERE collection_id = ? ORDER BY position`)
      .all(row.id) as { kind: string; value: string }[]
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      rules: rules.map((r) => ({ kind: r.kind as CollectionRule['kind'], value: r.value })),
      manualPaths: this.memberPaths(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

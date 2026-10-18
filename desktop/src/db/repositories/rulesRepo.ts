/** Rules storage. Position is the user order; lower is checked first. */

import type Database from 'better-sqlite3'
import { appError } from '../../shared/errors'

export interface RuleRow {
  id: string
  name: string
  extensions: string[]
  namePattern: string | null
  destination: string
  destinationKind: 'relative' | 'absolute'
  enabled: boolean
  position: number
  createdAt: string
  updatedAt: string
}

interface RawRuleRow {
  id: string
  name: string
  extensions_json: string
  name_pattern: string | null
  destination: string
  destination_kind: string
  enabled: number
  position: number
  created_at: string
  updated_at: string
}

function mapRule(r: RawRuleRow): RuleRow {
  let extensions: string[] = []
  try {
    const parsed = JSON.parse(r.extensions_json) as unknown
    if (Array.isArray(parsed)) extensions = parsed.filter((e): e is string => typeof e === 'string')
  } catch {
    extensions = []
  }
  return {
    id: r.id,
    name: r.name,
    extensions,
    namePattern: r.name_pattern,
    destination: r.destination,
    destinationKind: r.destination_kind === 'absolute' ? 'absolute' : 'relative',
    enabled: r.enabled === 1,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface RuleInsert {
  id: string
  name: string
  extensions: string[]
  namePattern: string | null
  destination: string
  destinationKind: 'relative' | 'absolute'
  enabled: boolean
}

export class RulesRepo {
  constructor(private readonly db: Database.Database) {}

  list(): RuleRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM rules ORDER BY position, created_at, id`)
      .all() as RawRuleRow[]
    return rows.map(mapRule)
  }

  get(id: string): RuleRow | null {
    const row = this.db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as RawRuleRow | undefined
    return row ? mapRule(row) : null
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM rules`).get() as { n: number }).n
  }

  insert(input: RuleInsert): RuleRow {
    const now = new Date().toISOString()
    const position =
      ((this.db.prepare(`SELECT COALESCE(MAX(position), 0) AS p FROM rules`).get() as { p: number })
        .p ?? 0) + 1
    this.db
      .prepare(
        `INSERT INTO rules (id, name, extensions_json, name_pattern, destination, destination_kind, enabled, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.name,
        JSON.stringify(input.extensions),
        input.namePattern,
        input.destination,
        input.destinationKind,
        input.enabled ? 1 : 0,
        position,
        now,
        now
      )
    return this.get(input.id) as RuleRow
  }

  update(id: string, input: RuleInsert): RuleRow {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE rules SET name = ?, extensions_json = ?, name_pattern = ?, destination = ?,
         destination_kind = ?, enabled = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        input.name,
        JSON.stringify(input.extensions),
        input.namePattern,
        input.destination,
        input.destinationKind,
        input.enabled ? 1 : 0,
        now,
        id
      )
    return this.get(id) as RuleRow
  }

  setEnabled(id: string, enabled: boolean): RuleRow {
    this.db
      .prepare(`UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, new Date().toISOString(), id)
    return this.get(id) as RuleRow
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM rules WHERE id = ?`).run(id)
  }

  /** Applied in one transaction; must be exactly the current set of ids. */
  reorder(orderedIds: string[]): RuleRow[] {
    const current = this.list()
    const currentIds = new Set(current.map((r) => r.id))
    if (
      orderedIds.length !== current.length ||
      orderedIds.some((id) => !currentIds.has(id))
    ) {
      throw appError('VALIDATION_FAILED', 'the reorder list must contain every current rule id')
    }
    const now = new Date().toISOString()
    const update = this.db.prepare(`UPDATE rules SET position = ?, updated_at = ? WHERE id = ?`)
    this.db.transaction(() => {
      orderedIds.forEach((id, index) => update.run(index + 1, now, id))
    })()
    return this.list()
  }
}

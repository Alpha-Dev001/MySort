/**
 * Rule recommendations: suggestions derived from repeated, user-approved
 * moves.
 *
 * A recommendation is never a rule and never acts on its own. It is a row
 * that lets the app show the evidence and remember that the user dismissed
 * it, so the same suggestion is not offered again.
 */

import type Database from 'better-sqlite3'
import { appError } from '../../shared/errors'
import type { RecommendationStatus, RuleRecommendation } from '../../shared/types'

interface RawRecommendationRow {
  id: string
  fingerprint: string
  kind: string
  payload_json: string
  evidence_json: string
  status: string
  created_at: string
  updated_at: string
}

interface RecommendationPayload {
  name: string
  extensions: string[]
  namePattern: string | null
  destination: string
}

interface RecommendationEvidence {
  evidence: string
  occurrences: number
  firstSeenAt: string
  lastSeenAt: string
}

function parse<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback
  } catch {
    return fallback
  }
}

export class RecommendationsRepo {
  constructor(private readonly db: Database.Database) {}

  list(status?: RecommendationStatus): RuleRecommendation[] {
    const rows = (
      status
        ? this.db
            .prepare(`SELECT * FROM recommendations WHERE status = ? ORDER BY updated_at DESC`)
            .all(status)
        : this.db.prepare(`SELECT * FROM recommendations ORDER BY updated_at DESC`).all()
    ) as RawRecommendationRow[]
    return rows.map(mapRow)
  }

  get(id: string): RuleRecommendation | null {
    const row = this.db.prepare(`SELECT * FROM recommendations WHERE id = ?`).get(id) as
      | RawRecommendationRow
      | undefined
    return row ? mapRow(row) : null
  }

  /** Finds a recommendation by its pattern fingerprint, whatever its status. */
  getByFingerprint(fingerprint: string): RuleRecommendation | null {
    const row = this.db
      .prepare(`SELECT * FROM recommendations WHERE fingerprint = ?`)
      .get(fingerprint) as RawRecommendationRow | undefined
    return row ? mapRow(row) : null
  }

  /**
   * Records a detected pattern.
   *
   * An existing row is left alone once it has been accepted or dismissed —
   * that is what keeps a dismissed suggestion from coming back. A pending row
   * is refreshed with the newer evidence.
   */
  upsert(input: {
    id: string
    fingerprint: string
    payload: RecommendationPayload
    evidence: RecommendationEvidence
  }): RuleRecommendation {
    const existing = this.getByFingerprint(input.fingerprint)
    const now = new Date().toISOString()

    if (existing) {
      if (existing.status !== 'pending') return existing
      this.db
        .prepare(
          `UPDATE recommendations SET payload_json = ?, evidence_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          JSON.stringify(input.payload),
          JSON.stringify(input.evidence),
          now,
          existing.id
        )
      return this.get(existing.id) as RuleRecommendation
    }

    this.db
      .prepare(
        `INSERT INTO recommendations (id, fingerprint, kind, payload_json, evidence_json, status, created_at, updated_at)
         VALUES (?, ?, 'rule', ?, ?, 'pending', ?, ?)`
      )
      .run(
        input.id,
        input.fingerprint,
        JSON.stringify(input.payload),
        JSON.stringify(input.evidence),
        now,
        now
      )
    return this.get(input.id) as RuleRecommendation
  }

  setStatus(id: string, status: RecommendationStatus): RuleRecommendation {
    const result = this.db
      .prepare(`UPDATE recommendations SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), id)
    if (result.changes === 0) throw appError('NOT_FOUND', 'recommendation not found')
    return this.get(id) as RuleRecommendation
  }
}

function mapRow(row: RawRecommendationRow): RuleRecommendation {
  const payload = parse<RecommendationPayload>(row.payload_json, {
    name: '',
    extensions: [],
    namePattern: null,
    destination: '',
  })
  const evidence = parse<RecommendationEvidence>(row.evidence_json, {
    evidence: '',
    occurrences: 0,
    firstSeenAt: row.created_at,
    lastSeenAt: row.updated_at,
  })
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    name: payload.name,
    extensions: payload.extensions,
    namePattern: payload.namePattern,
    destination: payload.destination,
    evidence: evidence.evidence,
    occurrences: evidence.occurrences,
    firstSeenAt: evidence.firstSeenAt,
    lastSeenAt: evidence.lastSeenAt,
    status: row.status as RecommendationStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Operations history: journal implementation + queries for history and overview. */

import type Database from 'better-sqlite3'
import { appError, type AppError, type ErrorCode } from '../../shared/errors'
import type {
  FileOperation,
  HistoryPage,
  HistoryQuery,
  InitiatedBy,
  OperationStatus,
  RuleKind,
  UndoStatus,
} from '../../shared/types'
import type { NewOperation, OperationJournal, OperationOutcome, UnfinishedOperation } from '../../engine/executor'

interface RawOperationRow {
  id: string
  batch_id: string | null
  monitored_folder_id: number | null
  initiated_by: string
  undo_of: string | null
  file_name: string
  source_path: string
  planned_dest_path: string
  final_dest_path: string | null
  rule_kind: string
  rule_id: string | null
  rule_label: string
  explanation: string
  method: string | null
  status: string
  error_code: string | null
  error_detail: string | null
  size_bytes: number | null
  mtime_ms: number | null
  dest_mtime_ms: number | null
  sha256: string | null
  undo_status: string
  undo_block_code: string | null
  created_at: string
  finished_at: string | null
}

function mapError(code: string | null, detail: string | null): AppError | null {
  if (!code) return null
  return appError(code as ErrorCode, detail ?? code)
}

function mapOperation(r: RawOperationRow): FileOperation {
  return {
    id: r.id,
    batchId: r.batch_id,
    initiatedBy: r.initiated_by as InitiatedBy,
    undoOf: r.undo_of,
    fileName: r.file_name,
    sourcePath: r.source_path,
    plannedDestPath: r.planned_dest_path,
    finalDestPath: r.final_dest_path,
    ruleKind: r.rule_kind as RuleKind,
    ruleLabel: r.rule_label,
    explanation: r.explanation,
    status: r.status as OperationStatus,
    error: mapError(r.error_code, r.error_detail),
    undo: { status: r.undo_status as UndoStatus, blockCode: (r.undo_block_code as ErrorCode) ?? null },
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }
}

export interface RetentionResult {
  deleted: number
  expired: number
}

export class OperationsRepo implements OperationJournal {
  constructor(private readonly db: Database.Database) {}

  begin(op: NewOperation): void {
    try {
      this.db
        .prepare(
          `INSERT INTO operations (
             id, batch_id, monitored_folder_id, initiated_by, undo_of, file_name, source_path,
             planned_dest_path, rule_kind, rule_id, rule_label, explanation, status,
             size_bytes, mtime_ms, undo_status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, 'not_eligible', ?)`
        )
        .run(
          op.id,
          op.batchId,
          op.folderId,
          op.initiatedBy,
          op.undoOf,
          op.fileName,
          op.sourcePath,
          op.plannedDestPath,
          op.ruleKind,
          op.ruleId,
          op.ruleLabel,
          op.explanation,
          op.sizeBytes,
          op.mtimeMs,
          op.createdAt
        )
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw appError('CONFLICT', 'another operation for this file is already active')
      }
      if (String(err.message ?? '').includes('ux_ops_active_source')) {
        throw appError('CONFLICT', 'another operation for this file is already active')
      }
      throw appError('DB_ERROR', `could not record the operation: ${err.message}`)
    }
  }

  finish(id: string, outcome: OperationOutcome): void {
    try {
      this.db
        .prepare(
          `UPDATE operations SET
             status = ?, final_dest_path = ?, dest_mtime_ms = ?, method = ?,
             error_code = ?, error_detail = ?, sha256 = ?, undo_status = ?, undo_block_code = ?, finished_at = ?
           WHERE id = ?`
        )
        .run(
          outcome.status,
          outcome.finalDestPath ?? null,
          outcome.finalMtimeMs ?? null,
          outcome.method ?? null,
          outcome.errorCode ?? null,
          outcome.errorDetail ?? null,
          outcome.sha256 ?? null,
          outcome.undoStatus,
          outcome.status === 'completed' ? null : (outcome.errorCode ?? null),
          outcome.finishedAt,
          id
        )
    } catch (e) {
      throw appError('DB_ERROR', `could not record the result: ${(e as Error).message}`)
    }
  }

  findUnfinished(): UnfinishedOperation[] {
    const rows = this.db
      .prepare(
        `SELECT id, status, file_name, source_path, planned_dest_path, final_dest_path, size_bytes, mtime_ms, sha256
         FROM operations WHERE status IN ('planned','in_progress') ORDER BY created_at`
      )
      .all() as {
      id: string
      status: string
      file_name: string
      source_path: string
      planned_dest_path: string
      final_dest_path: string | null
      size_bytes: number | null
      mtime_ms: number | null
      sha256: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      status: r.status as 'planned' | 'in_progress',
      fileName: r.file_name,
      sourcePath: r.source_path,
      plannedDestPath: r.planned_dest_path,
      finalDestPath: r.final_dest_path,
      sizeBytes: r.size_bytes,
      mtimeMs: r.mtime_ms,
      sha256: r.sha256,
    }))
  }

  setUndoStatus(id: string, status: UndoStatus, blockCode: ErrorCode | null): void {
    this.db
      .prepare(`UPDATE operations SET undo_status = ?, undo_block_code = ? WHERE id = ?`)
      .run(status, blockCode, id)
  }

  get(id: string): FileOperation | null {
    const row = this.db.prepare(`SELECT * FROM operations WHERE id = ?`).get(id) as
      | RawOperationRow
      | undefined
    return row ? mapOperation(row) : null
  }

  /** Fields undo needs beyond the shared FileOperation view. */
  getUndoRow(id: string): {
    id: string
    status: string
    finishedAt: string | null
    initiatedBy: string
    fileName: string
    sourcePath: string
    finalDestPath: string | null
    sizeBytes: number | null
    destMtimeMs: number | null
    sha256: string | null
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, status, finished_at, initiated_by, file_name, source_path, final_dest_path, size_bytes, dest_mtime_ms, sha256
         FROM operations WHERE id = ?`
      )
      .get(id) as
      | {
          id: string
          status: string
          finished_at: string | null
          initiated_by: string
          file_name: string
          source_path: string
          final_dest_path: string | null
          size_bytes: number | null
          dest_mtime_ms: number | null
          sha256: string | null
        }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      status: row.status,
      finishedAt: row.finished_at,
      initiatedBy: row.initiated_by,
      fileName: row.file_name,
      sourcePath: row.source_path,
      finalDestPath: row.final_dest_path,
      sizeBytes: row.size_bytes,
      destMtimeMs: row.dest_mtime_ms,
      sha256: row.sha256,
    }
  }

  list(query: HistoryQuery): HistoryPage {
    // Base clauses exclude the status filter: the status chips must always
    // describe the whole date/search window, whatever is currently selected.
    const base: string[] = []
    const baseParams: (string | number)[] = []
    if (query.query) {
      base.push('(file_name LIKE ? COLLATE NOCASE OR rule_label LIKE ? COLLATE NOCASE)')
      baseParams.push(`%${query.query}%`, `%${query.query}%`)
    }
    if (query.from) {
      base.push('created_at >= ?')
      baseParams.push(query.from)
    }
    if (query.to) {
      base.push('created_at <= ?')
      baseParams.push(query.to)
    }

    const where: string[] = [...base]
    const params: (string | number)[] = [...baseParams]
    if (query.status && query.status !== 'all') {
      where.push('status = ?')
      params.push(query.status)
    }
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM operations${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`)
        .get(...params) as { n: number }
    ).n

    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
    const offset = Math.max(query.offset ?? 0, 0)
    const rows = this.db
      .prepare(
        `SELECT * FROM operations${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as RawOperationRow[]

    const countRows = base.length
      ? (this.db
          .prepare(`SELECT status, COUNT(*) AS n FROM operations WHERE ${base.join(' AND ')} GROUP BY status`)
          .all(...baseParams) as { status: OperationStatus; n: number }[])
      : (this.db
          .prepare('SELECT status, COUNT(*) AS n FROM operations GROUP BY status')
          .all() as { status: OperationStatus; n: number }[])
    const statusCounts: HistoryPage['statusCounts'] = {}
    for (const c of countRows) statusCounts[c.status] = c.n
    if (Object.keys(statusCounts).length === 0) statusCounts.completed = 0

    return { items: rows.map(mapOperation), total, statusCounts }
  }

  countCompletedSince(iso: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM operations WHERE status = 'completed' AND finished_at >= ?`)
        .get(iso) as { n: number }
    ).n
  }

  countAttention(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM operations WHERE status IN ('needs_review','failed')`)
        .get() as { n: number }
    ).n
  }

  /** Reconciliation guard: has this exact file already been handled since `sinceIso`? */
  wasRecentlyCompleted(sourcePath: string, sinceIso: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM operations
         WHERE source_path = ? COLLATE NOCASE AND status = 'completed' AND COALESCE(finished_at, created_at) >= ?`
      )
      .get(sourcePath, sinceIso) as { n: number }
    return row.n > 0
  }

  hasActiveOperation(sourcePath: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM operations WHERE source_path = ? COLLATE NOCASE AND status IN ('planned','in_progress')`
      )
      .get(sourcePath) as { n: number }
    return row.n > 0
  }

  /** Delete finished rows past retention; expire undo outside its window. */
  applyRetention(historyRetentionDays: number, undoWindowDays: number, now = Date.now()): RetentionResult {
    const historyCutoff = new Date(now - historyRetentionDays * 86_400_000).toISOString()
    const undoCutoff = new Date(now - undoWindowDays * 86_400_000).toISOString()
    // needs_review rows are kept: they are unresolved user business, not history.
    const deleted = this.db
      .prepare(
        `DELETE FROM operations WHERE status IN ('completed','failed','skipped') AND COALESCE(finished_at, created_at) < ?`
      )
      .run(historyCutoff).changes
    const expired = this.db
      .prepare(
        `UPDATE operations SET undo_status = 'expired', undo_block_code = 'UNDO_BLOCKED'
         WHERE undo_status = 'available' AND COALESCE(finished_at, created_at) < ?`
      )
      .run(undoCutoff).changes
    return { deleted, expired }
  }

  deleteAll(): void {
    this.db.prepare(`DELETE FROM operations`).run()
  }
}

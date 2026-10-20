/**
 * Undo: offered only under strictly defined safety conditions, re-validated
 * from scratch (history rows come from a user-writable database, so nothing is
 * trusted). Undo runs through the same executor and journal as a normal move
 * (initiated_by = 'undo') and never overwrites anything.
 */

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppError, ErrorCode } from '../shared/errors'
import { appError } from '../shared/errors'
import type { FileStat, FsReader } from './fs'
import { hashFile } from './fs'

export interface UndoFacts {
  completed: boolean
  finishedAt: string | null
  finalDestPath: string | null
  /** Live stat at finalDestPath, or null when nothing is there. */
  destStat: FileStat | null
  recordedSizeBytes: number | null
  /** Destination mtime recorded at completion; null when unknown (skip the check). */
  recordedDestMtimeMs: number | null
  /** Content hash recorded at completion; null when it was not recorded. */
  recordedSha256: string | null
  /** Live hash of the destination, or null when not computed. */
  destHash: string | null
  sourceFolderExists: boolean
  originalPathOccupied: boolean
  now: number
  undoWindowDays: number
}

export type UndoEligibility =
  | { eligible: true }
  | { eligible: false; code: ErrorCode; message: string }

/** Pure decision table; every row is unit-tested (AC-5). */
export function evaluateUndo(facts: UndoFacts): UndoEligibility {
  if (!facts.completed) {
    return { eligible: false, code: 'UNDO_BLOCKED', message: 'Only completed operations can be undone.' }
  }
  if (!facts.finalDestPath) {
    return { eligible: false, code: 'UNDO_BLOCKED', message: 'This operation has no destination.' }
  }
  if (facts.finishedAt) {
    const finished = Date.parse(facts.finishedAt)
    if (Number.isFinite(finished) && facts.now - finished > facts.undoWindowDays * 86_400_000) {
      return { eligible: false, code: 'UNDO_BLOCKED', message: 'The undo window for this operation has expired.' }
    }
  }
  if (!facts.destStat || !facts.destStat.isFile) {
    return {
      eligible: false,
      code: 'SOURCE_GONE',
      message: 'The file no longer exists at its destination.',
    }
  }
  if (facts.recordedSizeBytes !== null && facts.destStat.size !== facts.recordedSizeBytes) {
    return { eligible: false, code: 'SOURCE_CHANGED', message: 'The file was modified after it was moved.' }
  }
  if (
    facts.recordedDestMtimeMs !== null &&
    facts.destStat.mtimeMs !== facts.recordedDestMtimeMs
  ) {
    return { eligible: false, code: 'SOURCE_CHANGED', message: 'The file was modified after it was moved.' }
  }
  if (
    facts.recordedSha256 !== null &&
    facts.destHash !== null &&
    facts.destHash !== facts.recordedSha256
  ) {
    return { eligible: false, code: 'SOURCE_CHANGED', message: 'The file content changed after it was moved.' }
  }
  if (!facts.sourceFolderExists) {
    return {
      eligible: false,
      code: 'DEST_UNAVAILABLE',
      message: 'The original folder no longer exists.',
    }
  }
  if (facts.originalPathOccupied) {
    return {
      eligible: false,
      code: 'PERMISSION_DENIED',
      message: 'Something already exists at the original location.',
    }
  }
  return { eligible: true }
}

export interface UndoRow {
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
}

export interface UndoRunResult {
  status: 'done' | 'blocked' | 'failed'
  undoOperationId?: string
  error?: AppError
}

export interface RunUndoOptions {
  folderId: number | null
  undoWindowDays: number
  /** Explicit user action: restore under a new name when the original path is taken. */
  restoreWithNewName?: boolean
  /** Bound by the orchestrator: performs the actual move via the executor. */
  executeMove(args: {
    operationId: string
    sourcePath: string
    destDir: string
    destName: string
    undoOf: string
    folderId: number | null
    fingerprint: { size: number; mtimeMs: number }
  }): Promise<{ status: 'completed' | 'failed' | 'skipped' | 'needs_review'; error?: AppError; finalDestPath?: string }>
  journal: {
    setUndoStatus(id: string, status: 'done' | 'blocked', blockCode: ErrorCode | null): void
  }
}

/** Fetch the live facts an undo decision needs (no writes). */
export async function collectUndoFacts(
  fs: FsReader,
  row: UndoRow,
  opts: { undoWindowDays: number; now?: number; hashLimitBytes?: number }
): Promise<UndoFacts> {
  const now = opts.now ?? Date.now()
  const hashLimit = opts.hashLimitBytes ?? 512 * 1024 * 1024
  const destStat = row.finalDestPath ? await statOrNull(fs, row.finalDestPath) : null
  const destHash =
    row.sha256 && destStat && destStat.size <= hashLimit && row.finalDestPath
      ? await hashFile(row.finalDestPath, hashLimit).catch(() => null)
      : null
  return {
    completed: row.status === 'completed',
    finishedAt: row.finishedAt,
    finalDestPath: row.finalDestPath,
    destStat,
    recordedSizeBytes: row.sizeBytes,
    recordedDestMtimeMs: row.destMtimeMs,
    recordedSha256: row.sha256,
    destHash,
    sourceFolderExists: await fs.exists(path.dirname(row.sourcePath)),
    originalPathOccupied: await fs.exists(row.sourcePath),
    now,
    undoWindowDays: opts.undoWindowDays,
  }
}

async function statOrNull(fs: FsReader, p: string): Promise<FileStat | null> {
  try {
    return await fs.lstat(p)
  } catch {
    return null
  }
}

export async function runUndo(
  fs: FsReader,
  row: UndoRow,
  opts: RunUndoOptions
): Promise<UndoRunResult> {
  if (row.initiatedBy === 'undo') {
    // Undo of an undo is not supported.
    return { status: 'blocked', error: appError('UNDO_BLOCKED', 'this operation is already an undo') }
  }
  const facts = await collectUndoFacts(fs, row, { undoWindowDays: opts.undoWindowDays })
  const eligibility = opts.restoreWithNewName
    ? evaluateUndo({ ...facts, originalPathOccupied: false })
    : evaluateUndo(facts)

  if (!eligibility.eligible) {
    opts.journal.setUndoStatus(
      row.id,
      'blocked',
      eligibility.code === 'UNDO_BLOCKED' ? 'UNDO_BLOCKED' : eligibility.code
    )
    return { status: 'blocked', error: appError('UNDO_BLOCKED', eligibility.message, { reason: eligibility.code }) }
  }

  const finalStat = facts.destStat
  if (!finalStat) {
    return { status: 'blocked', error: appError('SOURCE_GONE', 'the file no longer exists') }
  }

  const operationId = randomUUID()
  const result = await opts.executeMove({
    operationId,
    sourcePath: row.finalDestPath as string,
    destDir: path.dirname(row.sourcePath),
    destName: path.basename(row.sourcePath),
    undoOf: row.id,
    folderId: opts.folderId,
    fingerprint: { size: finalStat.size, mtimeMs: finalStat.mtimeMs },
  })

  if (result.status === 'completed') {
    opts.journal.setUndoStatus(row.id, 'done', null)
    return { status: 'done', undoOperationId: operationId }
  }
  const error = result.error ?? appError('INTERNAL', 'the undo move did not complete')
  opts.journal.setUndoStatus(row.id, 'blocked', error.code ?? 'INTERNAL')
  return { status: 'failed', undoOperationId: operationId, error }
}

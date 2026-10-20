/**
 * Executor: performs exactly one move with full journaling.
 *
 * Pipeline: pre-flight (eligibility, fingerprint, path re-validation) -> Tx A
 * (intent row committed) -> atomic move -> verify -> Tx B (record result).
 * SQLite and the file system cannot share a transaction, so the intent must be
 * safely on disk before any file is touched; a crash in between is resolved by
 * recovery.ts at next start.
 *
 * No-overwrite design: same volume uses hard link (fails EEXIST when taken),
 * cross volume copies to a .part file and claims the final name by link as well.
 * An existing file can never be overwritten.
 */

import path from 'node:path'
import { appError, fromErrno, isAppError, toAppError, type AppError, type ErrorCode } from '../shared/errors'
import type { InitiatedBy, MoveMethod, RuleKind, UndoStatus } from '../shared/types'
import { hashFile, type FsWriter } from './fs'
import { checkStatEligibility } from './pathSafety'
import { uniqueNameSequence } from './uniqueName'

export interface NewOperation {
  id: string
  batchId: string | null
  folderId: number | null
  initiatedBy: InitiatedBy
  undoOf: string | null
  fileName: string
  sourcePath: string
  plannedDestPath: string
  ruleKind: RuleKind
  ruleId: string | null
  ruleLabel: string
  explanation: string
  sizeBytes: number | null
  mtimeMs: number | null
  createdAt: string
}

export interface OperationOutcome {
  status: 'completed' | 'failed' | 'skipped' | 'needs_review'
  finalDestPath?: string | undefined
  /** Destination mtime right after the move; undo re-checks against it. */
  finalMtimeMs?: number | null | undefined
  method?: MoveMethod | undefined
  errorCode?: ErrorCode | null | undefined
  errorDetail?: string | null | undefined
  sha256?: string | null | undefined
  undoStatus: UndoStatus
  finishedAt: string
}

export interface UnfinishedOperation {
  id: string
  status: 'planned' | 'in_progress'
  fileName: string
  sourcePath: string
  plannedDestPath: string
  finalDestPath: string | null
  sizeBytes: number | null
  mtimeMs: number | null
  sha256: string | null
}

export interface OperationJournal {
  /** Tx A. Throws on database errors or when another active op owns the source. */
  begin(op: NewOperation): void
  /** Tx B. Throws on database errors (recovery completes the record later). */
  finish(id: string, outcome: OperationOutcome): void
  findUnfinished(): UnfinishedOperation[]
  setUndoStatus(id: string, status: UndoStatus, blockCode: ErrorCode | null): void
}

export interface ExecuteInput {
  operationId: string
  batchId?: string | null
  initiatedBy: InitiatedBy
  folderId?: number | null
  undoOf?: string | null
  sourcePath: string
  fileName?: string
  /** Absolute destination directory (validated by the caller). */
  destDir: string
  /** Original destination file name; a unique successor is claimed if taken. */
  destName: string
  rule: { kind: RuleKind; id: string | null; label: string; explanation: string }
  /** Size + mtime that made this file ready; re-checked right before acting. */
  fingerprint: { size: number; mtimeMs: number }
  /** Re-validate the destination path immediately before acting (T4). */
  validateDestinationPath(
    destDir: string
  ): Promise<{ ok: true } | { ok: false; code: ErrorCode; message: string }>
  /** true = pre-flight failures also create history rows (manual apply/retry/undo). */
  recordPreFlight?: boolean
}

export interface ExecuteResult {
  operationId: string
  status: 'completed' | 'failed' | 'skipped' | 'needs_review'
  finalDestPath?: string
  error?: AppError
}

export interface ExecutorHooks {
  /** Test hook: throwing here simulates a crash after the named step. */
  afterStep?(step: 'begin' | 'claimed' | 'moved' | 'verified' | 'finish'): void
}

export interface ExecutorDeps {
  fs: FsWriter
  journal: OperationJournal
  /** Files up to this size get a SHA-256 verification on cross-volume moves. */
  hashLimitBytes?: number
  hooks?: ExecutorHooks
}

export const PART_PREFIX = '.mysort-'
export const PART_SUFFIX = '.part'
export const partFileNameFor = (operationId: string): string =>
  `${PART_PREFIX}${operationId}${PART_SUFFIX}`

const SKIPPED_CODES: ReadonlySet<string> = new Set([
  'SOURCE_GONE',
  'NOT_READY',
  'SOURCE_CHANGED',
  'EXCLUDED',
])

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])

async function removeQuiet(fs: FsWriter, p: string): Promise<void> {
  try {
    await fs.unlink(p)
  } catch {
    /* our own temp artifact; recovery sweeps it */
  }
}

export async function executeOperation(
  deps: ExecutorDeps,
  input: ExecuteInput
): Promise<ExecuteResult> {
  const { fs, journal } = deps
  const hashLimit = deps.hashLimitBytes ?? 512 * 1024 * 1024
  const fileName = input.fileName ?? path.basename(input.sourcePath)
  const nowIso = (): string => new Date().toISOString()

  const op: NewOperation = {
    id: input.operationId,
    batchId: input.batchId ?? null,
    folderId: input.folderId ?? null,
    initiatedBy: input.initiatedBy,
    undoOf: input.undoOf ?? null,
    fileName,
    sourcePath: input.sourcePath,
    plannedDestPath: path.join(input.destDir, input.destName),
    ruleKind: input.rule.kind,
    ruleId: input.rule.id,
    ruleLabel: input.rule.label,
    explanation: input.rule.explanation,
    sizeBytes: input.fingerprint.size,
    mtimeMs: input.fingerprint.mtimeMs,
    createdAt: nowIso(),
  }

  const finish = (outcome: Omit<OperationOutcome, 'finishedAt'>): ExecuteResult => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        journal.finish(input.operationId, { ...outcome, finishedAt: nowIso() })
        deps.hooks?.afterStep?.('finish')
        break
      } catch {
        /* Tx B failed: recovery completes the record at next start */
      }
    }
    const result: ExecuteResult = {
      operationId: input.operationId,
      status: outcome.status,
    }
    if (outcome.finalDestPath) result.finalDestPath = outcome.finalDestPath
    if (outcome.errorCode) {
      result.error = appError(outcome.errorCode, outcome.errorDetail ?? outcome.errorCode)
    }
    return result
  }

  const preflightFail = (error: AppError): ExecuteResult => {
    if (!input.recordPreFlight) {
      const status = SKIPPED_CODES.has(error.code) ? 'skipped' : 'failed'
      return { operationId: input.operationId, status, error }
    }
    try {
      journal.begin(op)
    } catch (e) {
      return { operationId: input.operationId, status: 'failed', error: toAppError(e) }
    }
    const status = SKIPPED_CODES.has(error.code) ? 'skipped' : 'failed'
    return finish({ status, errorCode: error.code, errorDetail: error.message, undoStatus: 'not_eligible' })
  }

  // ---------------------------------------------------------------------
  // Pre-flight: nothing is journaled and no file is touched if these fail.
  // ---------------------------------------------------------------------

  let stat
  try {
    stat = await fs.lstat(input.sourcePath)
  } catch {
    return preflightFail(appError('SOURCE_GONE', 'the file no longer exists'))
  }
  const eligibility = checkStatEligibility(stat)
  if (!eligibility.eligible) {
    return preflightFail(appError('SOURCE_CHANGED', `file is not eligible (${eligibility.reason})`))
  }
  if (stat.size !== input.fingerprint.size || stat.mtimeMs !== input.fingerprint.mtimeMs) {
    return preflightFail(appError('NOT_READY', 'the file changed since it was last seen'))
  }

  const validation = await input.validateDestinationPath(input.destDir)
  if (!validation.ok) {
    return preflightFail(appError(validation.code, validation.message))
  }
  try {
    await fs.mkdir(input.destDir)
  } catch (e) {
    return preflightFail(fromErrno(e, 'DEST_UNAVAILABLE', 'could not create the destination folder'))
  }

  // Tx A: intent is on disk before any file is touched.
  try {
    journal.begin(op)
  } catch (e) {
    const err = isAppError(e) ? e : appError('DB_ERROR', 'could not record the operation')
    return { operationId: input.operationId, status: 'failed', error: err }
  }
  deps.hooks?.afterStep?.('begin')

  const crossVolume = !sameVolumeImpl(input.sourcePath, input.destDir)
  const moveFailed = (e: unknown, what: string): ExecuteResult =>
    finish({
      status: 'failed',
      errorCode: fromErrno(e, 'INTERNAL', what).code,
      errorDetail: fromErrno(e, 'INTERNAL', what).message,
      undoStatus: 'not_eligible',
    })

  let finalPath: string | null = null
  let method: MoveMethod = 'link_unlink'
  let sha256: string | null = null
  const names = uniqueNameSequence(input.destName)

  if (!crossVolume) {
    // Same volume: hard link at the destination (atomic, fails EEXIST), then
    // remove the source name. Data is never copied and nothing can be overwritten.
    for (let attempts = 0; attempts < 1002 && !finalPath; attempts++) {
      const dest = path.join(input.destDir, names.next().value as string)
      try {
        await fs.link(input.sourcePath, dest)
        finalPath = dest
        method = 'link_unlink'
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EEXIST') continue
        if (code && LINK_UNSUPPORTED.has(code)) {
          // FAT/exFAT/network shares: check-then-rename (documented tiny race).
          try {
            await fs.renameNoReplace(input.sourcePath, dest)
            finalPath = dest
            method = 'rename'
          } catch (e2) {
            const code2 = (e2 as NodeJS.ErrnoException).code
            if (code2 === 'EEXIST') continue
            return moveFailed(e2, 'could not move the file')
          }
          continue
        }
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          return moveFailed(e, 'the file is in use or permission was denied')
        }
        return moveFailed(e, 'could not move the file')
      }
    }
    if (!finalPath) {
      return finish({
        status: 'failed',
        errorCode: 'CONFLICT',
        errorDetail: 'could not find a free destination name',
        undoStatus: 'not_eligible',
      })
    }
    deps.hooks?.afterStep?.('claimed')
    if (method === 'link_unlink') {
      const destStat = await fs.lstat(finalPath).catch(() => null)
      if (!destStat || destStat.size !== input.fingerprint.size) {
        return finish({
          status: 'needs_review',
          finalDestPath: finalPath,
          errorCode: 'INTERRUPTED',
          errorDetail: 'verification of the destination failed; both names were kept',
          undoStatus: 'not_eligible',
        })
      }
      try {
        await fs.unlink(input.sourcePath)
      } catch {
        return finish({
          status: 'needs_review',
          finalDestPath: finalPath,
          errorCode: 'INTERRUPTED',
          errorDetail: 'the destination was created but the original name could not be removed',
          undoStatus: 'not_eligible',
        })
      }
    }
    deps.hooks?.afterStep?.('moved')
  } else {
    // Cross volume: copy to a .part file, verify, claim the final name, and
    // only then remove the source. There is a window with two copies, never zero.
    const partPath = path.join(input.destDir, partFileNameFor(input.operationId))
    try {
      await fs.copyExclusive(input.sourcePath, partPath)
    } catch (e) {
      await removeQuiet(fs, partPath)
      return moveFailed(e, 'could not copy the file')
    }
    const partStat = await fs.lstat(partPath).catch(() => null)
    if (!partStat || partStat.size !== input.fingerprint.size) {
      await removeQuiet(fs, partPath)
      return finish({
        status: 'needs_review',
        errorCode: 'SOURCE_CHANGED',
        errorDetail: 'the file changed while it was being copied; the copy was discarded',
        undoStatus: 'not_eligible',
      })
    }
    if (partStat.size <= hashLimit) {
      const hPart = await hashFile(partPath, hashLimit)
      const hSrc = await hashFile(input.sourcePath, hashLimit)
      if (!hPart || !hSrc || hPart !== hSrc) {
        await removeQuiet(fs, partPath)
        return finish({
          status: 'needs_review',
          errorCode: 'SOURCE_CHANGED',
          errorDetail: 'the file changed while it was being copied; the copy was discarded',
          undoStatus: 'not_eligible',
        })
      }
      sha256 = hPart
    }
    for (let attempts = 0; attempts < 1002 && !finalPath; attempts++) {
      const dest = path.join(input.destDir, names.next().value as string)
      try {
        await fs.link(partPath, dest)
        finalPath = dest
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EEXIST') continue
        if (code && LINK_UNSUPPORTED.has(code)) {
          try {
            await fs.renameNoReplace(partPath, dest)
            finalPath = dest
          } catch (e2) {
            const code2 = (e2 as NodeJS.ErrnoException).code
            if (code2 === 'EEXIST') continue
            await removeQuiet(fs, partPath)
            return moveFailed(e2, 'could not finalize the copied file')
          }
          continue
        }
        await removeQuiet(fs, partPath)
        return moveFailed(e, 'could not finalize the copied file')
      }
    }
    method = 'copy_verify'
    deps.hooks?.afterStep?.('claimed')
    deps.hooks?.afterStep?.('moved')
    if (!finalPath) {
      await removeQuiet(fs, partPath)
      return finish({
        status: 'failed',
        errorCode: 'CONFLICT',
        errorDetail: 'could not find a free destination name',
        undoStatus: 'not_eligible',
      })
    }
    // Re-check the source before removing it (the final step of the move).
    const srcNow = await fs.lstat(input.sourcePath).catch(() => null)
    const sourceIntact =
      srcNow !== null &&
      srcNow.size === input.fingerprint.size &&
      srcNow.mtimeMs === input.fingerprint.mtimeMs
    if (!sourceIntact) {
      return finish({
        status: 'needs_review',
        finalDestPath: finalPath,
        errorCode: 'SOURCE_CHANGED',
        errorDetail: 'the source changed during the copy; both copies were kept',
        sha256,
        undoStatus: 'not_eligible',
      })
    }
    try {
      await fs.unlink(input.sourcePath)
    } catch {
      return finish({
        status: 'needs_review',
        finalDestPath: finalPath,
        errorCode: 'INTERRUPTED',
        errorDetail: 'the copy is complete but the original could not be removed',
        sha256,
        undoStatus: 'not_eligible',
      })
    }
  }

  // Final verification.
  deps.hooks?.afterStep?.('verified')
  const destStat = await fs.lstat(finalPath).catch(() => null)
  if (!destStat || (!destStat.isDirectory && destStat.size !== input.fingerprint.size)) {
    return finish({
      status: 'needs_review',
      finalDestPath: finalPath,
      errorCode: 'INTERNAL',
      errorDetail: 'the destination could not be verified',
      sha256,
      undoStatus: 'not_eligible',
    })
  }

  return finish({
    status: 'completed',
    finalDestPath: finalPath,
    finalMtimeMs: destStat.mtimeMs,
    method,
    sha256,
    undoStatus: 'available',
  })
}

// Kept local to avoid an import cycle with pathSafety's async validator.
function sameVolumeImpl(a: string, b: string): boolean {
  const { parse } = path
  return parse(a).root.toLowerCase() === parse(b).root.toLowerCase()
}

/**
 * Recovery: run at every startup before monitoring resumes.
 *
 * For each unfinished (planned/in_progress) operation, inspect the disk and
 * either finish the record or park it in needs_review. Recovery never searches
 * the disk for lost files and never deletes anything it cannot prove belongs to
 * the interrupted operation. The only file it ever removes (besides its own
 * .part artifact) is a source it has just verified identical to the destination.
 */

import path from 'node:path'
import { hashFile, type FsWriter } from './fs'
import { PART_PREFIX, PART_SUFFIX, type OperationJournal } from './executor'
import type { ErrorCode } from '../shared/errors'
import type { RecoveryOutcome, RecoverySummary } from '../shared/types'

export interface RecoveryDeps {
  fs: FsWriter
  journal: OperationJournal
  /** Largest file to hash while verifying; beyond this only size is compared. */
  verifyLimitBytes?: number
}

export interface RecoveryOptions {
  ranAt?: string
}

async function removeQuiet(fs: FsWriter, p: string): Promise<void> {
  try {
    await fs.unlink(p)
  } catch {
    /* our own artifact, or already gone; nothing to do */
  }
}

export async function recoverUnfinished(
  deps: RecoveryDeps,
  opts: RecoveryOptions = {}
): Promise<RecoverySummary> {
  const verifyLimit = deps.verifyLimitBytes ?? 4 * 1024 * 1024 * 1024
  const unfinished = deps.journal.findUnfinished()
  const items: RecoverySummary['items'] = []
  let recovered = 0
  let failed = 0
  let needsReview = 0

  for (const op of unfinished) {
    const dest = op.finalDestPath ?? op.plannedDestPath
    const destDir = path.dirname(dest)
    const partPath = path.join(destDir, `${PART_PREFIX}${op.id}${PART_SUFFIX}`)

    const sourceExists = await deps.fs.exists(op.sourcePath)
    const destExists = await deps.fs.exists(dest)
    const partExists = await deps.fs.exists(partPath)

    const record = (status: RecoveryOutcome, errorCode: ErrorCode | null, note: string): void => {
      deps.journal.finish(op.id, {
        status,
        finalDestPath: destExists ? dest : undefined,
        errorCode,
        errorDetail: note,
        undoStatus: status === 'completed' ? 'available' : 'not_eligible',
        finishedAt: new Date().toISOString(),
      })
      if (status === 'completed') recovered += 1
      else if (status === 'failed') failed += 1
      else needsReview += 1
      items.push({
        operationId: op.id,
        fileName: op.fileName,
        sourcePath: op.sourcePath,
        destPath: dest,
        outcome: status,
        note,
      })
    }

    // The source is gone and the destination is there: the move finished, we
    // simply never got to write the outcome down.
    if (!sourceExists && destExists) {
      const st = await deps.fs.lstat(dest).catch(() => null)
      if (st && st.isFile && (op.sizeBytes === null || st.size === op.sizeBytes)) {
        record('completed', null, 'The move had finished. MySort recorded it as completed.')
      } else {
        record(
          'needs_review',
          'SOURCE_CHANGED',
          'The moved file exists but its size differs from what was recorded. Nothing was changed.'
        )
      }
      continue
    }

    // The source is intact and nothing was created: we stopped before moving.
    if (sourceExists && !destExists) {
      if (partExists) await removeQuiet(deps.fs, partPath)
      record(
        'failed',
        'INTERRUPTED',
        'MySort stopped before the file was moved. The original file is intact and can be retried.'
      )
      continue
    }

    // Both exist: only release the source name once the two are proven identical.
    if (sourceExists && destExists) {
      const [ss, ds] = [
        await deps.fs.lstat(op.sourcePath).catch(() => null),
        await deps.fs.lstat(dest).catch(() => null),
      ]
      if (!ss || !ds || ss.size !== ds.size) {
        record(
          'needs_review',
          'SOURCE_CHANGED',
          'Both an original and a moved copy exist and their sizes differ. Nothing was changed.'
        )
        continue
      }
      const hDest = op.sha256 ?? (await hashFile(dest, verifyLimit))
      const hSrc = await hashFile(op.sourcePath, verifyLimit)
      if (hDest && hSrc && hDest === hSrc) {
        try {
          await deps.fs.unlink(op.sourcePath)
          record(
            'completed',
            null,
            'Recovered: the copy was verified identical and the original name was released.'
          )
        } catch {
          record(
            'needs_review',
            'INTERRUPTED',
            'The copies are identical but the original name could not be removed. Nothing was deleted.'
          )
        }
      } else {
        record(
          'needs_review',
          'SOURCE_CHANGED',
          'Both copies exist and could not be verified identical. Nothing was changed.'
        )
      }
      continue
    }

    if (partExists) {
      record(
        'needs_review',
        'INTERRUPTED',
        'Only a partial temporary copy (.part) remains. Nothing was changed; you can delete it safely.'
      )
    } else {
      record(
        'needs_review',
        'SOURCE_GONE',
        'Neither the original file nor the moved copy could be found. It was probably moved or deleted outside MySort.'
      )
    }
  }

  return {
    ranAt: opts.ranAt ?? new Date().toISOString(),
    checked: unfinished.length,
    recovered,
    failed,
    needsReview,
    items,
  }
}
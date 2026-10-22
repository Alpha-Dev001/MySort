/**
 * The indexer: walks directories and records file *metadata* in the local
 * index.
 *
 * It never writes, moves or deletes a user file. It only reads names, sizes
 * and timestamps. The index is a cache — it can be deleted and rebuilt at any
 * time without touching anything the user owns.
 *
 * Design notes:
 *
 * - The walk is iterative and breadth-first, so a deep tree cannot blow the
 *   stack and the queue stays bounded by the number of directories.
 * - Symlinks are skipped entirely (lstat, not stat), which also removes any
 *   chance of a symlink loop.
 * - A directory that cannot be read is counted and stepped over; it never
 *   stops the scan.
 * - Cancellation is checked between directories and between batches, so a
 *   cancel request takes effect promptly without aborting mid-write.
 */

import path from 'node:path'
import type { FsReader } from './fs'
import { isExcludedEntry, type ExcludeConfig } from './exclusions'
import type { IndexScope } from '../shared/types'

export interface IndexRow {
  path: string
  parentDir: string
  name: string
  ext: string
  sizeBytes: number
  mtimeMs: number
  ctimeMs: number
  sha256: string | null
  hashedSize: number | null
  hashedMtime: number | null
  indexedAt: string
}

/** The storage side of the index. Implemented by the repository. */
export interface IndexWriter {
  upsertMany(rows: IndexRow[]): void
  /** Removes every row under a directory (used when rebuilding). */
  removeUnder(dir: string): void
  clear(): void
  count(): number
}

export interface IndexProgress {
  scanned: number
  indexed: number
  skipped: number
  errors: number
  currentRoot: string | null
}

export interface IndexToken {
  cancelled: boolean
}

export interface IndexOptions {
  token: IndexToken
  onProgress?: (progress: IndexProgress) => void
  /** Rows are written in batches of this size. */
  batchSize?: number
  /** Hard cap on the number of files a single pass will record. */
  maxFiles?: number
  now?: () => number
}

export interface IndexResult {
  scanned: number
  indexed: number
  skipped: number
  errors: number
  cancelled: boolean
  /** True when the pass hit `maxFiles` and stopped early. */
  truncated: boolean
  durationMs: number
}

/** The extension of a file name: the last dot-separated segment, lowercase. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** Splits a scope into the exclusion rules the walker uses. */
export function excludeConfigFor(scope: IndexScope): ExcludeConfig {
  return {
    excludedPaths: scope.excludedPaths,
    excludedExtensions: scope.excludedExtensions,
    excludeHidden: scope.excludeHidden,
  }
}

/**
 * Walks every root and writes the metadata it finds into the index.
 *
 * The writer is called in batches; the caller owns the transaction.
 */
export async function runIndex(
  fs: FsReader,
  writer: IndexWriter,
  scope: IndexScope,
  options: IndexOptions
): Promise<IndexResult> {
  const batchSize = Math.max(options.batchSize ?? 250, 1)
  const maxFiles = Math.max(options.maxFiles ?? 250_000, 1)
  const now = options.now ?? Date.now
  const exclude = excludeConfigFor(scope)
  const startedAt = now()

  let scanned = 0
  let indexed = 0
  let skipped = 0
  let errors = 0
  let cancelled = false
  let truncated = false
  let batch: IndexRow[] = []

  const queue: { dir: string; depth: number }[] = []
  for (const root of scope.roots) {
    if (root.length === 0) continue
    queue.push({ dir: root, depth: 0 })
  }

  const flush = (): void => {
    if (batch.length === 0) return
    writer.upsertMany(batch)
    batch = []
  }

  const report = (currentRoot: string | null): void => {
    options.onProgress?.({ scanned, indexed, skipped, errors, currentRoot })
  }

  while (queue.length > 0) {
    if (options.token.cancelled) {
      cancelled = true
      break
    }
    const { dir, depth } = queue.shift() as { dir: string; depth: number }

    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      // An unreadable directory is skipped; it never stops the scan.
      errors++
      report(dir)
      continue
    }

    for (const name of names) {
      if (options.token.cancelled) {
        cancelled = true
        break
      }
      if (indexed + batch.length >= maxFiles) {
        truncated = true
        break
      }

      const full = path.join(dir, name)
      const ext = extensionOf(name)
      if (isExcludedEntry(name, full, ext, exclude)) {
        skipped++
        continue
      }

      let stat
      try {
        stat = await fs.lstat(full)
      } catch {
        errors++
        continue
      }

      // Symlinks are never followed and never indexed.
      if (stat.isSymlink) {
        skipped++
        continue
      }

      if (stat.isDirectory) {
        if (depth < scope.maxDepth) queue.push({ dir: full, depth: depth + 1 })
        else skipped++
        continue
      }

      if (!stat.isFile) {
        skipped++
        continue
      }

      scanned++
      batch.push({
        path: full,
        parentDir: path.dirname(full),
        name,
        ext,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.birthtimeMs,
        sha256: null,
        hashedSize: null,
        hashedMtime: null,
        indexedAt: new Date(now()).toISOString(),
      })
      indexed++

      if (batch.length >= batchSize) {
        flush()
        report(dir)
      }
    }

    if (cancelled || truncated) break
    report(dir)
  }

  flush()
  report(null)

  return {
    scanned,
    indexed,
    skipped,
    errors,
    cancelled,
    truncated,
    durationMs: now() - startedAt,
  }
}

/**
 * Duplicate service: finds *exact* duplicates and reports them.
 *
 * It never deletes anything. The report tells the user which files share
 * identical content and how much space that duplication occupies, so the
 * decision about what to keep stays with them.
 *
 * The scan runs in the main process with a bounded number of parallel
 * hashers, so a large candidate set never blocks the interface.
 */

import type { DuplicateReport } from '../shared/types'
import { IndexRepo } from '../db/repositories/indexRepo'
import { buildDuplicateGroups, hashCandidates, type DuplicateCandidate } from '../engine/duplicates'
import { NodeFs, hashFile } from '../engine/fs'
import type { FsReader } from '../engine/fs'
import { logger } from './logger'

/** Files larger than this are not hashed — the cost outweighs the benefit. */
const HASH_LIMIT_BYTES = 512 * 1024 * 1024
const DEFAULT_CANDIDATE_LIMIT = 2000

export interface DuplicateServiceDeps {
  indexRepo: IndexRepo
  fs?: FsReader
  onProgress?: (done: number, total: number) => void
}

export class DuplicateService {
  private readonly repo: IndexRepo
  private readonly fs: FsReader
  private token: { cancelled: boolean } | null = null
  private running = false

  constructor(private readonly deps: DuplicateServiceDeps) {
    this.repo = deps.indexRepo
    this.fs = deps.fs ?? new NodeFs()
  }

  isRunning(): boolean {
    return this.running
  }

  cancel(): void {
    if (this.token) this.token.cancelled = true
  }

  /**
   * Scans for exact duplicates.
   *
   * Files that changed while the scan was running are reported as uncertain
   * rather than as duplicates.
   */
  async scan(options: { limit?: number } = {}): Promise<DuplicateReport> {
    if (this.running) {
      throw new Error('a duplicate scan is already running')
    }
    this.running = true
    const startedAt = Date.now()
    const token = { cancelled: false }
    this.token = token

    try {
      const limit = Math.min(Math.max(options.limit ?? DEFAULT_CANDIDATE_LIMIT, 1), 5000)
      const candidates = this.repo.duplicateCandidates(limit)

      // Re-check every candidate against the live file system. The index is a
      // cache; a file that moved or changed since it was recorded is not
      // evidence of anything.
      const live: DuplicateCandidate[] = []
      let unverifiable = 0
      for (const candidate of candidates) {
        if (token.cancelled) break
        const stat = await this.fs.lstat(candidate.path).catch(() => null)
        if (!stat || !stat.isFile) {
          unverifiable++
          continue
        }
        if (stat.size !== candidate.sizeBytes || stat.mtimeMs !== candidate.modifiedMs) {
          unverifiable++
          continue
        }
        live.push({
          ...candidate,
          sizeBytes: stat.size,
          modifiedMs: stat.mtimeMs,
        })
      }

      // Hash whatever does not have a trustworthy cached hash.
      const needsHash = live.filter(
        (c) => !c.sha256 || c.hashedSize !== c.sizeBytes || c.hashedMtime !== c.modifiedMs
      )

      if (needsHash.length > 0) {
        await hashCandidates(
          needsHash.map((c) => c.path),
          {
            token,
            concurrency: 2,
            hash: async (filePath) => {
              const stat = await this.fs.lstat(filePath).catch(() => null)
              if (!stat || !stat.isFile || stat.size > HASH_LIMIT_BYTES) return null
              const hash = await hashFile(filePath, HASH_LIMIT_BYTES).catch(() => null)
              if (hash) this.repo.setHash(filePath, hash, stat.size, stat.mtimeMs)
              return hash
            },
            onProgress: (done, total) => this.deps.onProgress?.(done, total),
          }
        )
      }

      // Re-read the candidates so the freshly computed hashes are included.
      const refreshed = this.repo
        .duplicateCandidates(limit)
        .map((c) => ({ ...c }))
      const { groups } = buildDuplicateGroups(refreshed)

      const report: DuplicateReport = {
        groups,
        candidateFiles: live.length,
        hashedFiles: needsHash.length,
        unverifiableFiles: unverifiable,
        tookMs: Date.now() - startedAt,
        truncated: token.cancelled,
      }
      logger.info(
        `duplicate scan: ${groups.length} group(s) from ${live.length} candidate(s), ${needsHash.length} hashed, ${unverifiable} unverifiable`
      )
      return report
    } finally {
      this.running = false
      this.token = null
    }
  }
}

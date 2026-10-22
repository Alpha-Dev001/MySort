/**
 * Search service: owns the local metadata index.
 *
 * The index is built in the main process, never in the renderer, so a scan of
 * a large tree never blocks the interface. The service:
 *
 * - keeps the scope (which roots to walk, what to skip) in the settings store,
 * - runs at most one index pass at a time and can cancel it,
 * - keeps the index in step with the watcher by applying incremental
 *   add/change/unlink events,
 * - and answers queries against the index.
 *
 * The index is a cache. Nothing here ever moves, writes or deletes a user
 * file, and the index can be deleted and rebuilt at any time.
 */

import path from 'node:path'
import { appError } from '../shared/errors'
import type {
  IndexedFile,
  IndexScope,
  IndexStatus,
  SearchQuery,
  SearchResultPage,
  VerificationState,
} from '../shared/types'
import { IndexRepo } from '../db/repositories/indexRepo'
import { SettingsRepo } from '../db/repositories/settingsRepo'
import { runIndex, type IndexToken } from '../engine/indexer'
import { normalizeExcludedExtensions, normalizeExcludedPaths } from '../engine/exclusions'
import { NodeFs, hashFile } from '../engine/fs'
import type { FsReader } from '../engine/fs'
import { logger } from './logger'

const SETTINGS_KEY_SCOPE = 'indexScope'
/** Files larger than this are not hashed: the cost is not worth it. */
const HASH_LIMIT_BYTES = 512 * 1024 * 1024

export type IndexStatusListener = (status: IndexStatus) => void

export interface SearchServiceDeps {
  indexRepo: IndexRepo
  settingsRepo: SettingsRepo
  fs?: FsReader
  /**
   * The folders to index when the user has not chosen a scope of their own.
   * Defaults to the watched folders and the destination root — the places
   * MySort already touches — so the first index pass covers what matters
   * without asking the user to pick anything.
   */
  defaultRoots?: () => string[]
  onStatus?: (status: IndexStatus) => void
}

export class SearchService {
  private readonly repo: IndexRepo
  private readonly settingsRepo: SettingsRepo
  private readonly fs: FsReader
  private readonly listeners = new Set<IndexStatusListener>()

  private status: IndexStatus = {
    phase: 'idle',
    running: false,
    scanned: 0,
    indexed: 0,
    skipped: 0,
    errors: 0,
    currentRoot: null,
    startedAt: null,
    finishedAt: null,
    message: null,
    totalIndexed: 0,
  }

  private token: IndexToken | null = null
  private job: Promise<void> | null = null

  constructor(private readonly deps: SearchServiceDeps) {
    this.repo = deps.indexRepo
    this.settingsRepo = deps.settingsRepo
    this.fs = deps.fs ?? new NodeFs()
  }

  // ---------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------

  onStatusChange(listener: IndexStatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(patch: Partial<IndexStatus>): void {
    this.status = { ...this.status, ...patch, totalIndexed: this.repo.count() }
    for (const listener of this.listeners) {
      try {
        listener(this.status)
      } catch {
        /* a broken listener must not stop the index */
      }
    }
    this.deps.onStatus?.(this.status)
  }

  getStatus(): IndexStatus {
    return { ...this.status, totalIndexed: this.repo.count() }
  }

  // ---------------------------------------------------------------------
  // Scope
  // ---------------------------------------------------------------------

  getScope(): IndexScope {
    const stored = this.settingsRepo.get<IndexScope>(SETTINGS_KEY_SCOPE)
    if (stored && Array.isArray(stored.roots)) {
      return {
        roots: stored.roots.filter((r) => typeof r === 'string' && r.length > 0),
        maxDepth: clampDepth(stored.maxDepth),
        excludedPaths: normalizeExcludedPaths(stored.excludedPaths ?? []),
        excludedExtensions: normalizeExcludedExtensions(stored.excludedExtensions ?? []),
        excludeHidden: stored.excludeHidden !== false,
      }
    }
    // No scope of the user's own: index what MySort already watches.
    const roots = (this.deps.defaultRoots?.() ?? []).filter((r) => r.length > 0)
    return {
      roots,
      maxDepth: 6,
      excludedPaths: [],
      excludedExtensions: [],
      excludeHidden: true,
    }
  }

  setScope(scope: IndexScope): IndexScope {
    const next: IndexScope = {
      roots: scope.roots.filter((r) => r.length > 0),
      maxDepth: clampDepth(scope.maxDepth),
      excludedPaths: normalizeExcludedPaths(scope.excludedPaths),
      excludedExtensions: normalizeExcludedExtensions(scope.excludedExtensions),
      excludeHidden: scope.excludeHidden !== false,
    }
    this.settingsRepo.set(SETTINGS_KEY_SCOPE, next)
    return next
  }

  // ---------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------

  /**
   * Starts an index pass.
   *
   * Only one pass runs at a time. A second request while a pass is running
   * is refused rather than queued, so the work cannot pile up.
   */
  start(options: { rebuild?: boolean } = {}): IndexStatus {
    if (this.job) {
      throw appError('CONFLICT', 'an index pass is already running')
    }
    const scope = this.getScope()
    if (scope.roots.length === 0) {
      throw appError('VALIDATION_FAILED', 'choose at least one folder to index')
    }

    const token: IndexToken = { cancelled: false }
    this.token = token
    const startedAt = new Date().toISOString()
    this.publish({
      phase: options.rebuild ? 'rebuilding' : 'scanning',
      running: true,
      scanned: 0,
      indexed: 0,
      skipped: 0,
      errors: 0,
      currentRoot: scope.roots[0] ?? null,
      startedAt,
      finishedAt: null,
      message: null,
    })

    this.job = (async () => {
      try {
        if (options.rebuild) {
          // A rebuild clears the index first. It touches no user file.
          this.repo.clear()
        }
        const result = await runIndex(this.fs, this.repo, scope, {
          token,
          onProgress: (progress) => {
            this.publish({
              phase: token.cancelled ? 'cancelling' : options.rebuild ? 'rebuilding' : 'scanning',
              scanned: progress.scanned,
              indexed: progress.indexed,
              skipped: progress.skipped,
              errors: progress.errors,
              currentRoot: progress.currentRoot,
            })
          },
        })
        this.publish({
          phase: result.cancelled ? 'idle' : 'idle',
          running: false,
          finishedAt: new Date().toISOString(),
          currentRoot: null,
          message: result.cancelled
            ? 'Indexing was cancelled.'
            : result.truncated
              ? 'Indexing stopped early — the folder is very large.'
              : null,
        })
        logger.info(
          `index pass finished: scanned ${result.scanned}, indexed ${result.indexed}, skipped ${result.skipped}, errors ${result.errors}`
        )
      } catch (e) {
        this.publish({
          phase: 'error',
          running: false,
          finishedAt: new Date().toISOString(),
          message: (e as Error).message,
        })
        logger.error(`index pass failed: ${(e as Error).message}`)
      } finally {
        this.job = null
        this.token = null
      }
    })()

    return this.getStatus()
  }

  cancel(): IndexStatus {
    if (!this.token) return this.getStatus()
    this.token.cancelled = true
    this.publish({ phase: 'cancelling', message: 'Stopping…' })
    return this.getStatus()
  }

  /** Removes every indexed row. User files are untouched. */
  clear(): IndexStatus {
    if (this.token) this.token.cancelled = true
    this.repo.clear()
    this.publish({
      phase: 'idle',
      running: false,
      scanned: 0,
      indexed: 0,
      skipped: 0,
      errors: 0,
      currentRoot: null,
      message: 'The index was cleared.',
    })
    return this.getStatus()
  }

  /** Waits for the running pass to finish. Used on shutdown. */
  async drain(): Promise<void> {
    if (this.job) {
      if (this.token) this.token.cancelled = true
      await this.job.catch(() => undefined)
    }
  }

  // ---------------------------------------------------------------------
  // Incremental updates
  // ---------------------------------------------------------------------

  /**
   * Applies a watcher event to the index.
   *
   * The index is a cache, so a failed update is not fatal: the next full
   * pass repairs it.
   */
  async applyFileEvent(event: 'add' | 'change' | 'unlink', filePath: string): Promise<void> {
    try {
      if (event === 'unlink') {
        this.repo.removePaths([filePath])
        return
      }
      const stat = await this.fs.lstat(filePath).catch(() => null)
      if (!stat || !stat.isFile || stat.isSymlink) {
        this.repo.removePaths([filePath])
        return
      }
      const name = path.basename(filePath)
      const dot = name.lastIndexOf('.')
      const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
      this.repo.upsertMany([
        {
          path: filePath,
          parentDir: path.dirname(filePath),
          name,
          ext,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.birthtimeMs,
          sha256: null,
          hashedSize: null,
          hashedMtime: null,
          indexedAt: new Date().toISOString(),
        },
      ])
    } catch (e) {
      logger.warn(`index update failed for a file: ${(e as Error).message}`)
    }
  }

  /** Records a content hash for a file, with the metadata it was taken from. */
  async hashFile(filePath: string): Promise<string | null> {
    const stat = await this.fs.lstat(filePath).catch(() => null)
    if (!stat || !stat.isFile) return null
    const hash = await hashFile(filePath, HASH_LIMIT_BYTES).catch(() => null)
    if (hash) this.repo.setHash(filePath, hash, stat.size, stat.mtimeMs)
    return hash
  }

  // ---------------------------------------------------------------------
  // Querying
  // ---------------------------------------------------------------------

  query(query: SearchQuery): SearchResultPage {
    const startedAt = Date.now()
    const page = this.repo.search(query)
    return {
      items: page.items,
      total: page.total,
      tookMs: Date.now() - startedAt,
      truncated: false,
    }
  }

  recent(limit = 25) {
    return this.repo.recent(limit)
  }

  /**
   * Re-checks an indexed row against the file system.
   *
   * The index is never the authority on whether a file exists, so every
   * action on a search result goes through this first.
   */
  async revalidate(filePath: string): Promise<{ exists: boolean; changed: boolean }> {
    const indexed = this.repo.getByPath(filePath)
    const stat = await this.fs.lstat(filePath).catch(() => null)
    if (!stat || !stat.isFile) return { exists: false, changed: true }
    if (!indexed) return { exists: true, changed: false }
    const changed = indexed.sizeBytes !== stat.size || indexed.modifiedMs !== stat.mtimeMs
    return { exists: true, changed }
  }

  /**
   * The indexed record for a path, or an error.
   *
   * The renderer may only ask the app to act on files MySort has catalogued.
   * A path that is not in the index is refused, so a compromised renderer
   * cannot use the app to open or reveal something it never listed.
   */
  requireIndexed(filePath: string): IndexedFile {
    const row = this.repo.getByPath(filePath)
    if (!row) {
      throw appError('NOT_FOUND', 'that file is not in the index')
    }
    return row
  }

  verificationFor(row: { sha256: string | null; sizeBytes: number; modifiedMs: number }): VerificationState {
    if (!row.sha256) return 'indexed'
    return 'hashed'
  }
}

function clampDepth(value: number): number {
  if (!Number.isFinite(value)) return 6
  return Math.min(Math.max(Math.floor(value), 0), 16)
}

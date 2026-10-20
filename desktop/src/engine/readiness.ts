/**
 * File readiness: a per-candidate state machine that decides when a file is
 * truly finished downloading. A watcher event is only a hint — a candidate is
 * Ready after N consecutive stat checks with identical size and mtime.
 *
 * One cheap timer runs only while candidates exist; there is no polling when
 * the map is empty. Candidates are keyed by normalized, case-insensitive path,
 * so duplicate events collapse into one candidate.
 */

import type { FileStat, FsReader } from './fs'
import { checkNameEligibility, checkStatEligibility, type SkipReason } from './pathSafety'

export type CandidateState = 'waiting' | 'ready' | 'claimed' | 'backoff' | 'needs_attention' | 'gone'

export interface Fingerprint {
  size: number
  mtimeMs: number
}

export interface Candidate {
  key: string
  path: string
  fileName: string
  state: CandidateState
  stableCount: number
  fingerprint: Fingerprint | null
  lastSize: number | null
  lastMtimeMs: number | null
  addedAt: number
  backoffLevel: number
  nextAttemptAt: number
  attempts: number
}

export interface ReadinessEvents {
  /** A candidate satisfied the stability requirement. */
  onReady(candidate: Candidate, fingerprint: Fingerprint): void
  /** The file vanished before it became ready. */
  onGone(key: string, path: string): void
  /** Name/stat eligibility rejected the candidate. */
  onSkipped(path: string, fileName: string, reason: SkipReason): void
  /** Backoff retries exhausted; surfaced as needs-review/attention. */
  onNeedsAttention(path: string, fileName: string): void
}

export interface ReadinessOptions {
  stableChecks: number
  intervalMs: number
  maxCandidates: number
  now(): number
}

export const DEFAULT_READINESS: Omit<ReadinessOptions, 'now'> = {
  stableChecks: 3,
  intervalMs: 2000,
  maxCandidates: 200,
}

const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const

export function candidateKey(path: string): string {
  return path.replace(/\//g, '\\').toLowerCase()
}

export class ReadinessChecker {
  private readonly candidates = new Map<string, Candidate>()
  private readonly queue: { key: string; path: string; fileName: string }[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly fs: FsReader,
    private readonly events: ReadinessEvents,
    private readonly options: ReadinessOptions = { ...DEFAULT_READINESS, now: Date.now }
  ) {}

  get size(): number {
    return this.candidates.size
  }

  get(key: string): Candidate | undefined {
    return this.candidates.get(candidateKey(key))
  }

  list(): Candidate[] {
    return [...this.candidates.values()]
  }

  /** Cheap eligibility first; eligible candidates wait for stability. */
  async add(path: string, fileName?: string): Promise<void> {
    const key = candidateKey(path)
    if (this.candidates.has(key)) return
    const name = fileName ?? path.split(/[\\/]/).pop() ?? path
    const nameCheck = checkNameEligibility(name)
    if (!nameCheck.eligible) {
      this.events.onSkipped(path, name, nameCheck.reason)
      return
    }
    if (this.candidates.size >= this.options.maxCandidates) {
      this.queue.push({ key, path, fileName: name })
      return // drained on a later tick when capacity frees up
    }
    const candidate: Candidate = {
      key,
      path,
      fileName: name,
      state: 'waiting',
      stableCount: 0,
      fingerprint: null,
      lastSize: null,
      lastMtimeMs: null,
      addedAt: this.options.now(),
      backoffLevel: 0,
      nextAttemptAt: 0,
      attempts: 0,
    }
    this.candidates.set(key, candidate)
    this.ensureTimer()
  }

  /** A change event arrived: the file is being written again. */
  change(path: string): void {
    const c = this.candidates.get(candidateKey(path))
    if (!c || c.state === 'claimed') return
    c.state = 'waiting'
    c.stableCount = 0
    c.lastSize = null
    c.lastMtimeMs = null
    c.fingerprint = null
    c.nextAttemptAt = 0
  }

  remove(path: string): void {
    const key = candidateKey(path)
    const c = this.candidates.get(key)
    if (c && c.state !== 'gone') {
      this.candidates.delete(key)
      if (c.state !== 'claimed') this.events.onGone(key, c.path)
    } else {
      this.candidates.delete(key)
    }
  }

  markClaimed(path: string): Candidate | undefined {
    const c = this.candidates.get(candidateKey(path))
    if (c) c.state = 'claimed'
    return c
  }

  /** Executor reported busy/locked: exponential backoff, then attention. */
  scheduleBackoff(path: string): void {
    const c = this.candidates.get(candidateKey(path))
    if (!c) return
    if (c.backoffLevel >= BACKOFF_MS.length) {
      c.state = 'needs_attention'
      this.events.onNeedsAttention(c.path, c.fileName)
      return
    }
    c.state = 'backoff'
    c.nextAttemptAt = this.options.now() + BACKOFF_MS[c.backoffLevel]
    c.backoffLevel += 1
    c.stableCount = 0
    c.lastSize = null
  }

  /** Executor rejected the candidate pre-flight (not ready / changed). */
  releaseToWaiting(path: string): void {
    const c = this.candidates.get(candidateKey(path))
    if (!c) return
    c.state = 'waiting'
    c.stableCount = 0
    c.lastSize = null
    c.nextAttemptAt = 0
  }

  /** Successful move or user-resolved item: drop the candidate silently. */
  complete(path: string): void {
    this.candidates.delete(candidateKey(path))
  }

  start(): void {
    this.ensureTimer()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** One pass over all candidates; called by the timer or directly in tests. */
  async tick(): Promise<void> {
    this.drainQueue()
    if (this.candidates.size === 0) {
      this.stop()
      return
    }
    const now = this.options.now()
    for (const c of [...this.candidates.values()]) {
      if (c.state === 'claimed' || c.state === 'needs_attention' || c.state === 'gone') continue
      if (c.state === 'backoff') {
        if (now < c.nextAttemptAt) continue
        c.state = 'waiting'
        c.stableCount = 0
        c.lastSize = null
      }
      let stat: FileStat
      try {
        stat = await this.fs.lstat(c.path)
      } catch {
        this.candidates.delete(c.key)
        this.events.onGone(c.key, c.path)
        continue
      }
      const isDir = stat.isDirectory && !stat.isSymlink
      if (isDir) {
        // Folders: stability is based on mtime only (size is meaningless for
        // directories). A folder being filled keeps changing mtime and never
        // becomes ready until the writes settle.
        stat = { ...stat, size: 0 }
      } else if (!stat.isFile || stat.isSymlink || stat.size === 0) {
        // Not a regular file: a symlink, a socket, or an empty file. None of
        // them are ever moved, so the candidate is dropped and the reason is
        // reported. (Directories never reach this branch — they are handled
        // above, and `checkStatEligibility` reports them as eligible.)
        const skip = checkStatEligibility(stat)
        this.candidates.delete(c.key)
        if (!skip.eligible) this.events.onSkipped(c.path, c.fileName, skip.reason)
        continue
      }
      const changed =
        c.lastSize !== null && (c.lastSize !== stat.size || c.lastMtimeMs !== stat.mtimeMs)
      c.lastSize = stat.size
      c.lastMtimeMs = stat.mtimeMs
      if (changed) {
        c.stableCount = 0
        continue
      }
      c.stableCount += 1
      if (c.stableCount >= this.options.stableChecks && c.state === 'waiting') {
        c.state = 'ready'
        c.fingerprint = { size: stat.size, mtimeMs: stat.mtimeMs }
        this.events.onReady(c, c.fingerprint)
      }
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.candidates.size < this.options.maxCandidates) {
      const next = this.queue.shift()
      if (next && !this.candidates.has(next.key)) {
        this.candidates.set(next.key, {
          key: next.key,
          path: next.path,
          fileName: next.fileName,
          state: 'waiting',
          stableCount: 0,
          fingerprint: null,
          lastSize: null,
          lastMtimeMs: null,
          addedAt: this.options.now(),
          backoffLevel: 0,
          nextAttemptAt: 0,
          attempts: 0,
        })
      }
    }
  }

  private ensureTimer(): void {
    if (this.timer || this.candidates.size === 0) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.options.intervalMs)
    // Never keep the process alive just for readiness checks (quit must be fast).
    this.timer.unref?.()
  }
}

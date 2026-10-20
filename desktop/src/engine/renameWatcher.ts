/**
 * RenameWatcher: watches the PARENT of every tracked directory so that a
 * rename of the tracked directory itself is visible. Watching the tracked
 * directory cannot work — once it is renamed it is watched by nothing.
 *
 * chokidar surfaces a parent-child rename as `unlinkDir(oldPath)` followed by
 * `addDir(newPath)` (or the reverse on some file systems); the pairing window
 * in renameTracking.ts turns the pair into one rename. The watcher only
 * reports; deciding what a rename means is the orchestrator's job.
 */

import chokidar, { type FSWatcher } from 'chokidar'
import path from 'node:path'
import { RenamePairer, pathKey } from './renameTracking'

export interface RenameWatcherEvents {
  onRenamed(from: string, to: string): void
  /** A tracked directory vanished without a replacement. */
  onVanished(trackedPath: string): void
}

interface ParentEntry {
  refs: number
  watcher: FSWatcher | null
  starting: Promise<void> | null
  pairer: RenamePairer
}

export class RenameWatcher {
  private readonly parents = new Map<string, ParentEntry>()
  private readonly tracked = new Set<string>()
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private disposed = false
  private now: () => number

  constructor(
    private readonly events: RenameWatcherEvents,
    options: { windowMs?: number; now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now
    this.windowMs = options.windowMs ?? 5000
  }

  private windowMs: number

  /** Registers a directory for rename tracking (idempotent per path). */
  track(dirPath: string): void {
    if (this.disposed) return
    if (this.tracked.has(pathKey(dirPath))) return
    this.tracked.add(pathKey(dirPath))
    const parent = path.dirname(dirPath)
    let entry = this.parents.get(parent)
    if (!entry) {
      entry = { refs: 0, watcher: null, starting: null, pairer: new RenamePairer(this.windowMs) }
      this.parents.set(parent, entry)
    }
    entry.refs += 1
    if (this.running && !entry.watcher) this.startParent(parent)
  }

  /** Unregisters a directory; the parent watcher stops when nothing tracks it. */
  async untrack(dirPath: string): Promise<void> {
    this.tracked.delete(pathKey(dirPath))
    const parent = path.dirname(dirPath)
    const entry = this.parents.get(parent)
    if (!entry) return
    entry.refs -= 1
    if (entry.refs <= 0) await this.stopParent(parent)
  }

  async start(): Promise<void> {
    if (this.disposed) return
    this.running = true
    for (const parent of this.parents.keys()) {
      const entry = this.parents.get(parent)
      if (entry && !entry.watcher) this.startParent(parent)
    }
    this.pruneTimer = setInterval(() => this.prune(), this.windowMs / 2)
    this.pruneTimer.unref?.()
  }

  async stop(): Promise<void> {
    this.running = false
    const stopping: Promise<void>[] = []
    for (const [parent, entry] of [...this.parents]) {
      if (entry.watcher) stopping.push(this.stopParent(parent))
    }
    await Promise.all(stopping)
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
  }

  dispose(): void {
    this.disposed = true
    void this.stop()
    this.parents.clear()
    this.tracked.clear()
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private startParent(parent: string): void {
    const entry = this.parents.get(parent)
    if (!entry || entry.watcher) return
    try {
      const watcher = chokidar.watch(parent, {
        depth: 0,
        ignoreInitial: true,
        followSymlinks: false,
        usePolling: false,
        awaitWriteFinish: false,
      })
      entry.watcher = watcher
      watcher.on('addDir', (p: string) => this.onAddDir(parent, p))
      watcher.on('unlinkDir', (p: string) => this.onRemovedDir(parent, p))
      watcher.on('error', () => {
        /* the parent exists or does not: reconcile is the safety net */
      })
      entry.starting = new Promise<void>((resolve) => watcher.once('ready', resolve)).then(() => {
        entry.starting = null
      })
    } catch {
      /* no parent watcher; reconcile covers the folder itself */
    }
  }

  private async stopParent(parent: string): Promise<void> {
    const entry = this.parents.get(parent)
    if (!entry) return
    const watcher = entry.watcher
    if (entry.starting) {
      await entry.starting.catch(() => undefined)
      entry.starting = null
    }
    entry.watcher = null
    this.parents.delete(parent)
    if (watcher) {
      try {
        await watcher.close()
      } catch {
        /* already closed */
      }
    }
  }

  private onAddDir(parent: string, fullPath: string): void {
    const entry = this.parents.get(parent)
    if (!entry) return
    const match = entry.pairer.noteAdded(fullPath, this.now())
    if (match) this.events.onRenamed(match.from, match.to)
  }

  private onRemovedDir(parent: string, fullPath: string): void {
    const entry = this.parents.get(parent)
    if (!entry) return
    const match = entry.pairer.noteRemoved(fullPath, this.now())
    if (match) this.events.onRenamed(match.from, match.to)
  }

  /** Reports tracked directories whose unpaired removal just expired. */
  private prune(): void {
    if (this.disposed || !this.running) return
    for (const entry of [...this.parents.values()]) {
      for (const p of entry.pairer.expire(this.now())) {
        if (this.tracked.has(pathKey(p))) this.events.onVanished(p)
      }
    }
  }
}

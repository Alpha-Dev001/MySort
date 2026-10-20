/**
 * Rename tracking: matching a vanished directory with the directory that
 * appeared in its place.
 *
 * Windows reports a folder rename to the PARENT directory only (chokidar
 * surfaces it as `unlinkDir(old)` + `addDir(new)`), so renames are detected by
 * pairing those two events inside a short window. The same idea works for
 * renames that happened while the app was closed: last scan's snapshot of the
 * parent's subfolders is diffed against the parent now.
 *
 * Pure logic — the watcher, the snapshots and the clock are injected.
 */

/** Case-insensitive absolute path key (Windows). */
export function pathKey(p: string): string {
  return p.toLowerCase().replace(/[\\/]+$/, '')
}

export interface RenameMatch {
  from: string
  to: string
}

/**
 * Pairing state for one parent directory. Each tracked directory contributes
 * a parent; directories sharing a parent share one pairer, which keeps the
 * pairing consistent when several folders in one parent change at once.
 */
export class RenamePairer {
  private readonly added = new Map<string, number>()
  private readonly removed = new Map<string, number>()
  private readonly windowMs: number
  /** Bounds the work per parent; users rename a handful of folders at once. */
  private static readonly CAP = 32

  constructor(windowMs = 5000) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error('RenamePairer windowMs must be a positive number')
    }
    this.windowMs = windowMs
  }

  /**
   * A directory disappeared. Returns the rename when this loss pairs with a
   * recent appearance of a *different* directory in the same parent.
   * Same-name loss and repopulation is a delete+recreate, not a rename: the
   * old path is gone, so a same-name partner must NOT pair with it.
   */
  noteRemoved(dirPath: string, nowMs: number): RenameMatch | null {
    const partner = this.takePartner(this.added, dirPath, nowMs)
    if (partner === null) {
      this.queue(this.removed, dirPath, nowMs)
      return null
    }
    return { from: dirPath, to: partner }
  }

  /** A directory appeared; pairs with a recent loss in the same parent. */
  noteAdded(dirPath: string, nowMs: number): RenameMatch | null {
    const partner = this.takePartner(this.removed, dirPath, nowMs)
    if (partner === null) {
      this.queue(this.added, dirPath, nowMs)
      return null
    }
    return { from: partner, to: dirPath }
  }

  /**
   * Drops every entry older than the pairing window and returns the paths of
   * expired, unpaired *removals* — i.e. directories that vanished without a
   * replacement. Removed-but-unpaired means deleted, moved away, or renamed
   * to a place we cannot see; the caller decides whether that matters.
   */
  expire(nowMs: number): string[] {
    const vanished: string[] = []
    for (const [p, at] of this.removed) {
      if (this.isExpired(at, nowMs)) {
        this.removed.delete(p)
        vanished.push(p)
      }
    }
    for (const [p, at] of this.added) {
      if (this.isExpired(at, nowMs)) this.added.delete(p)
    }
    return vanished
  }

  private takePartner(
    partners: Map<string, number>,
    dirPath: string,
    nowMs: number
  ): string | null {
    const key = pathKey(dirPath)
    for (const [partnerPath, at] of partners) {
      if (pathKey(partnerPath) === key) continue // same name = recreate, not rename
      if (this.isExpired(at, nowMs)) continue
      partners.delete(partnerPath)
      return partnerPath
    }
    return null
  }

  private queue(map: Map<string, number>, dirPath: string, nowMs: number): void {
    map.set(dirPath, nowMs)
    if (map.size > RenamePairer.CAP) {
      let oldestPath: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [p, at] of map) {
        if (at < oldestAt) {
          oldestAt = at
          oldestPath = p
        }
      }
      if (oldestPath) map.delete(oldestPath)
    }
  }

  private isExpired(at: number, nowMs: number): boolean {
    return at < nowMs - this.windowMs
  }
}

// ---------------------------------------------------------------------------
// Offline pairing (folder renamed while MySort was closed)
// ---------------------------------------------------------------------------

export type OfflineRename =
  | { status: 'ok' }
  | { status: 'renamed'; to: string }
  | { status: 'unknown' }

/** Sorted, de-duplicated directory names for a snapshot. */
export function snapshotNames(names: string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}

/**
 * Where did the watched folder go?
 *
 * Evidenced only when the previous snapshot contains exactly one subfolder
 * that disappeared and the parent now has exactly one new one, and the
 * disappeared one is the watched folder itself. Anything else is 'unknown' so
 * the user decides instead of MySort guessing.
 */
export function inferOfflineRename(
  watchedName: string,
  snapshot: string[] | null,
  currentNames: string[]
): OfflineRename {
  const current = new Set(currentNames.map((n) => n.toLowerCase()))
  if (current.has(watchedName.toLowerCase())) return { status: 'ok' }
  if (!snapshot || snapshot.length === 0) return { status: 'unknown' }

  const snapSet = new Set(snapshot.map((n) => n.toLowerCase()))
  const removed = snapshot.filter((n) => !current.has(n.toLowerCase()))
  const added = currentNames.filter((n) => !snapSet.has(n.toLowerCase()))
  if (removed.length !== 1 || added.length !== 1) return { status: 'unknown' }
  if (removed[0].toLowerCase() !== watchedName.toLowerCase()) return { status: 'unknown' }
  return { status: 'renamed', to: added[0] }
}

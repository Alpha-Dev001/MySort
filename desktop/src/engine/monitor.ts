/**
 * Folder monitoring: one watcher per enabled folder, top level only, no polling.
 * The watcher only emits candidates — the readiness checker decides when a file
 * is safe to move. Watcher failures restart with backoff and trigger a
 * reconciliation scan (orchestrator side).
 */

import chokidar, { type FSWatcher } from 'chokidar'
import path from 'node:path'
import type { FsReader } from './fs'

export interface MonitorEvents {
  onAdd(filePath: string): void
  onAddDir(dirPath: string): void
  onChange(filePath: string): void
  onUnlink(filePath: string): void
  onUnlinkDir(dirPath: string): void
  onError(error: Error): void
  onReady(): void
}

export interface FolderMonitorOptions {
  folderPath: string
  /** Paths that must never become candidates (e.g. inside the destination root). */
  ignoredPaths?: string[]
  events: MonitorEvents
}

function isIgnored(filePath: string, ignoredPaths: string[]): boolean {
  const lower = filePath.toLowerCase()
  return ignoredPaths.some((p) => {
    const prefix = p.toLowerCase().replace(/[\\/]+$/, '') + path.sep
    return lower.startsWith(prefix)
  })
}

export class FolderMonitor {
  private watcher: FSWatcher | null = null
  private stopped = false

  constructor(private readonly options: FolderMonitorOptions) {}

  async start(): Promise<void> {
    if (this.watcher) return
    this.stopped = false
    const ignored = this.options.ignoredPaths ?? []
    const watcher = chokidar.watch(this.options.folderPath, {
      depth: 0,
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: false,
      awaitWriteFinish: false,
      ignored: (p: string) => isIgnored(p, ignored),
    })
    this.watcher = watcher
    watcher.on('add', (p: string) => this.options.events.onAdd(p))
    watcher.on('addDir', (p: string) => this.options.events.onAddDir(p))
    watcher.on('change', (p: string) => this.options.events.onChange(p))
    watcher.on('unlink', (p: string) => this.options.events.onUnlink(p))
    watcher.on('unlinkDir', (p: string) => this.options.events.onUnlinkDir(p))
    watcher.on('error', (e: unknown) =>
      this.options.events.onError(e instanceof Error ? e : new Error(String(e)))
    )
    watcher.on('ready', () => this.options.events.onReady())
    await new Promise<void>((resolve, reject) => {
      watcher.once('ready', resolve)
      watcher.once('error', reject)
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    const watcher = this.watcher
    this.watcher = null
    if (watcher) await watcher.close()
    void this.stopped
  }
}

/**
 * Plain directory listing used by reconciliation scans and previews.
 * Returns full paths of top-level entries, sorted for deterministic output.
 */
export async function listTopLevel(reader: FsReader, folderPath: string): Promise<string[]> {
  const names = await reader.readdir(folderPath)
  return names.map((n) => path.join(folderPath, n)).sort((a, b) => a.localeCompare(b))
}

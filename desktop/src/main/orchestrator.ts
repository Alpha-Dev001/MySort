/**
 * Orchestrator: the only place that wires engine parts together. It owns
 * monitoring state, candidates, preview plans, and the recently-moved ledger;
 * it emits events for the UI and never trusts renderer-supplied paths.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { appError, toAppError, type AppError } from '../shared/errors'
import type {
  ApplicationSettings,
  FileOperation,
  FolderMode,
  MonitoringStatus,
  MonitoredFolder,
  OperationResult,
  OrganizationPlan,
  OverviewStats,
  PreviewApplyResult,
  RecoverySummary,
  RuleTestResult,
  UndoResult,
} from '../shared/types'
import type { FoldersRepo, FolderRow } from '../db/repositories/foldersRepo'
import type { OperationsRepo } from '../db/repositories/operationsRepo'
import type { SettingsRepo } from '../db/repositories/settingsRepo'
import { ReadinessChecker, type Candidate, type Fingerprint } from '../engine/readiness'
import type { FsWriter } from '../engine/fs'
import { FolderMonitor, listTopLevel } from '../engine/monitor'
import { buildPlan } from '../engine/planner'
import { executeOperation, type ExecuteInput, type ExecuteResult } from '../engine/executor'
import { recoverUnfinished } from '../engine/recovery'
import { runUndo } from '../engine/undo'
import { RenameWatcher } from '../engine/renameWatcher'
import { inferOfflineRename, pathKey, snapshotNames } from '../engine/renameTracking'

import {
  checkNameEligibility,
  checkStatEligibility,
  isDangerousDirName,
  isInside,
  normalizePath,
  pathsEqual,
  sameVolume,
  validateDestination,
  type DestinationContext,
} from '../engine/pathSafety'
import { resolveRule, sortRules, patternToRegExp, resolveRuleDestination } from '../engine/rules'
import { SETTINGS_KEY_RULES_SEEDED, SEED_RULES } from '../engine/defaultRules'
import { SettingsService } from './settingsService'
import { RulesService, relocatePath } from './rulesService'
import { logger } from './logger'

export interface OrchestratorEvents {
  monitoringStatus(status: MonitoringStatus): void
  operationUpdated(op: FileOperation): void
  recoverySummary(summary: RecoverySummary): void
  rulesChanged(): void
  settingsChanged(s: ApplicationSettings): void
  notify(kind: 'failure' | 'summary' | 'info', title: string, body: string): void
}

/** Snapshot of the destination root's parent's subfolders, for offline rename tracking. */
const SETTINGS_KEY_ROOT_PARENT_SNAPSHOT = 'destinationRootParentDirs'

export interface OrchestratorDeps {
  repos: {
    settings: SettingsRepo
    folders: FoldersRepo
    operations: OperationsRepo
  }
  settingsService: SettingsService
  rulesService: RulesService
  fs: FsWriter
  /** Deny list for destinations (system locations, app data, startup folders). */
  denyPaths: string[]
  /**
   * Raw watcher events, forwarded so the local metadata index can stay in
   * step with the file system. The orchestrator never uses them for anything
   * else.
   */
  onFileEvent?: (event: { type: 'add' | 'change' | 'unlink'; path: string }) => void
  events: OrchestratorEvents
}

interface FolderRuntime {
  row: FolderRow
  monitor: FolderMonitor | null
  state: 'watching' | 'unavailable' | 'error' | 'paused'
  lastError: AppError | null
  lastScanAt: string | null
  restartTimer: ReturnType<typeof setTimeout> | null
  restartAttempt: number
}

const LEDGER_TTL_MS = 60 * 1000
const PLAN_APPLY_STABILITY_MS = 800
/** How long a built plan stays applyable. After this the user must re-preview. */
const PLAN_TTL_MS = 30 * 60 * 1000

interface CachedPlan {
  plan: OrganizationPlan
  createdAtMs: number
}

export class Orchestrator {
  private readonly readiness: ReadinessChecker
  private readonly runtimes = new Map<number, FolderRuntime>()
  private readonly recentlyMoved = new Map<string, number>()
  /** Plans awaiting approval, keyed by planId and dropped after PLAN_TTL_MS. */
  private readonly plans = new Map<string, CachedPlan>()
  private state: 'stopped' | 'starting' | 'running' | 'paused' | 'error' = 'stopped'
  private since: string | null = null
  private disposed = false
  private statusEmitScheduled = false
  private retentionTimer: ReturnType<typeof setInterval> | null = null
  private lastRecovery: RecoverySummary | null = null
  /** Watches the parents of tracked folders + the destination root for renames. */
  private readonly renameWatcher: RenameWatcher
  /** The destination root we currently track renames for (original path string). */
  private trackedRootPath: string | null = null
  /** Paths the user was already told are missing; one notification per run per path. */
  private readonly missingNotified = new Set<string>()

  constructor(private readonly deps: OrchestratorDeps) {
    this.readiness = new ReadinessChecker(deps.fs, {
      onReady: (c, fp) => this.onCandidateReady(c, fp),
      onGone: () => this.scheduleStatus(),
      onSkipped: (_p, name, reason) => {
        logger.info(`candidate skipped: ${reason} (${name.length} chars)`)
        this.scheduleStatus()
      },
      onNeedsAttention: (p, name) => {
        logger.warn(`candidate needs attention, dropping from queue (${name.length} chars)`)
        this.readiness.complete(p)
        this.scheduleStatus()
      },
    })
    this.renameWatcher = new RenameWatcher({
      onRenamed: (from, to) => void this.handleRename(from, to),
      onVanished: (p) => void this.handleVanish(p),
    })
  }

  // ------------------------------------------------------------------
  // Boot, recovery, retention
  // ------------------------------------------------------------------

  boot(): void {
    const settings = this.deps.settingsService.get()
    if (!this.deps.repos.settings.get(SETTINGS_KEY_RULES_SEEDED)) {
      this.deps.rulesService.seedOnce(SEED_RULES)
      this.deps.repos.settings.set(SETTINGS_KEY_RULES_SEEDED, true)
      this.deps.events.rulesChanged()
    }
    this.retentionTimer = setInterval(() => this.applyRetention(), 24 * 60 * 60 * 1000)
    this.retentionTimer.unref?.()
    this.applyRetention()
    logger.info(`boot complete; destination root and ${settings.readinessStableChecks}-check stability`)
  }

  applyRetention(): void {
    const s = this.deps.settingsService.get()
    const result = this.deps.repos.operations.applyRetention(s.historyRetentionDays, s.undoWindowDays)
    if (result.deleted > 0 || result.expired > 0) {
      logger.info(`retention: deleted ${result.deleted}, expired ${result.expired}`)
    }
  }

  // ------------------------------------------------------------------
  // Recovery
  // ------------------------------------------------------------------

  /**
   * Resolves moves that were interrupted by a crash or a forced quit. Runs
   * before monitoring resumes so a half-finished move is settled first.
   *
   * Recovery only ever inspects operations the journal already knows about. It
   * never scans the disk for unrecognised files and never deletes anything it
   * has not proven identical to its destination.
   */
  async runRecovery(): Promise<RecoverySummary> {
    const summary = await recoverUnfinished({
      fs: this.deps.fs,
      journal: this.deps.repos.operations,
    })
    this.lastRecovery = summary.checked > 0 ? summary : null
    if (summary.checked > 0) {
      logger.warn(
        `recovery: checked ${summary.checked}, recovered ${summary.recovered}, needs review ${summary.needsReview}`
      )
      this.deps.events.recoverySummary(summary)
    }
    return summary
  }

  /** Clears the startup recovery banner once the user has seen it. */
  dismissRecovery(): void {
    this.lastRecovery = null
  }

  // ------------------------------------------------------------------
  // Monitoring lifecycle
  // ------------------------------------------------------------------

  async startMonitoring(): Promise<MonitoringStatus> {
    if (this.disposed) return this.status()
    this.state = 'starting'
    this.since = new Date().toISOString()
    this.emitStatus()
    // Settle folder renames that happened while MySort was closed, before any
    // watcher is created — otherwise a renamed folder is watched in vain.
    await this.recoverRenames()
    const enabled = this.deps.repos.folders.listEnabled()
    for (const row of enabled) {
      this.renameWatcher.track(row.path)
      await this.ensureRuntime(row)
    }
    await this.syncRootTracking()
    await this.renameWatcher.start()
    this.state = 'running'
    this.emitStatus()
    await this.snapshotRootParent()
    for (const row of enabled) {
      void this.reconcile(row)
    }
    return this.status()
  }

  async pauseMonitoring(): Promise<MonitoringStatus> {
    this.state = 'paused'
    this.since = new Date().toISOString()
    for (const rt of this.runtimes.values()) {
      await this.stopRuntime(rt)
      rt.state = 'paused'
    }
    this.readiness.stop()
    await this.renameWatcher.stop()
    this.emitStatus()
    return this.status()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.retentionTimer) clearInterval(this.retentionTimer)
    this.renameWatcher.dispose()
    this.runtimes.clear()
    this.readiness.stop()
  }

  // ------------------------------------------------------------------
  // Folders
  // ------------------------------------------------------------------

  listFolders(): MonitoredFolder[] {
    return this.deps.repos.folders.list().map((row) => {
      const rt = this.runtimes.get(row.id)
      return {
        id: row.id,
        path: row.path,
        enabled: row.enabled,
        mode: row.mode,
        autoSince: row.auto_since,
        lastReconciledAt: row.last_reconciled_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        state: rt?.state ?? (row.enabled ? 'paused' : 'paused'),
        pendingCandidates: this.countCandidatesIn(row.path),
        lastError: rt?.lastError ?? null,
      }
    })
  }

  async addFolder(folderPath: string, mode: FolderMode): Promise<MonitoredFolder> {
    await this.validateSourceFolder(folderPath)
    const existing = this.deps.repos.folders.list()
    for (const f of existing) {
      const a = folderPath.toLowerCase().replace(/[\\/]+$/, '')
      const b = f.path.toLowerCase().replace(/[\\/]+$/, '')
      if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
        throw appError('CONFLICT', 'this folder overlaps with an already monitored folder')
      }
    }
    const row = this.deps.repos.folders.insert({ path: folderPath, mode })
    this.renameWatcher.track(row.path)
    if (this.state === 'running' || this.state === 'starting') await this.ensureRuntime(row)
    void this.reconcile(row)
    this.emitStatus()
    return this.toMonitoredFolder(row)
  }

  async removeFolder(folderId: number): Promise<void> {
    const row = this.deps.repos.folders.get(folderId)
    const rt = this.runtimes.get(folderId)
    if (rt) {
      await this.stopRuntime(rt)
      this.runtimes.delete(folderId)
    }
    this.deps.repos.folders.remove(folderId) // never touches files
    if (row) await this.renameWatcher.untrack(row.path)
    this.emitStatus()
  }

  async setFolderMode(folderId: number, mode: FolderMode): Promise<MonitoredFolder> {
    const row = this.deps.repos.folders.get(folderId)
    if (!row) throw appError('NOT_FOUND', 'folder not found')
    const updated = this.deps.repos.folders.setMode(folderId, mode)
    if (mode === 'auto') void this.reconcile(updated)
    this.emitStatus()
    return this.toMonitoredFolder(updated)
  }

  async validateSourceFolder(folderPath: string): Promise<void> {
    const stat = await this.deps.fs.lstat(folderPath).catch(() => null)
    if (!stat || !stat.isDirectory) {
      throw appError('PATH_INVALID', 'the selected path is not a folder')
    }
    const root = path.parse(folderPath).root
    if (folderPath.replace(/[\\/]+$/, '').toLowerCase() === root.replace(/[\\/]+$/, '').toLowerCase()) {
      throw appError('PATH_DENIED', 'a drive root cannot be monitored')
    }
  }

  // ------------------------------------------------------------------
  // Rename tracking
  // ------------------------------------------------------------------
  //
  // The user may rename a watched folder (or the destination root) instead of
  // re-picking it. Tracking keeps the SAME folder row, so history, rules, and
  // the auto timestamp survive; nothing is re-created at the old path.

  /** Runs on every startMonitoring: follows renames that happened while closed. */
  private async recoverRenames(): Promise<void> {
    for (const row of this.deps.repos.folders.list()) {
      if (existsSync(row.path)) {
        void this.recordParentSnapshot(row)
        continue
      }
      const followed = await this.followOfflineFolderRename(row)
      if (!followed) this.notifyFolderMissing(row.path)
    }
    if (existsSync(this.deps.settingsService.get().destinationRoot)) return
    await this.followOfflineRootRename()
  }

  private async followOfflineFolderRename(row: FolderRow): Promise<boolean> {
    const parent = path.dirname(row.path)
    let current: string[]
    try {
      current = await this.listDirNames(parent)
    } catch {
      return false // the parent is gone as well; the notice stands
    }
    const snapshot = this.deps.repos.folders.getParentDirs(row.id)
    const outcome = inferOfflineRename(path.basename(row.path), snapshot, current)
    if (outcome.status !== 'renamed') return false
    const updated = await this.applyFolderRename(row.id, path.join(parent, outcome.to))
    return updated !== null
  }

  private async followOfflineRootRename(): Promise<void> {
    const root = this.deps.settingsService.get().destinationRoot
    const parent = path.dirname(root)
    let current: string[]
    try {
      current = await this.listDirNames(parent)
    } catch {
      this.notifyFolderMissing(root)
      return
    }
    const snapshot = this.deps.repos.settings.get<string[]>(SETTINGS_KEY_ROOT_PARENT_SNAPSHOT)
    const outcome = inferOfflineRename(path.basename(root), snapshot ?? null, current)
    if (outcome.status !== 'renamed') {
      this.notifyFolderMissing(root)
      return
    }
    await this.applyRootRename(root, path.join(parent, outcome.to))
  }

  /** Live rename event from a parent watcher. */
  private async handleRename(from: string, to: string): Promise<void> {
    if (this.disposed || !existsSync(to)) return
    const folder = this.deps.repos.folders.list().find((r) => pathsEqual(r.path, from))
    if (folder) {
      const updated = await this.applyFolderRename(folder.id, to)
      logger.info(
        updated
          ? `rename tracking: '${folder.path}' -> '${to}'`
          : `rename tracking: could not follow '${from}'`
      )
      this.deps.events.notify(
        updated ? 'info' : 'failure',
        updated ? 'Folder followed' : 'Watched folder could not be followed',
        updated
          ? `${path.basename(from)} is now ${path.basename(to)} — MySort keeps sorting from there.`
          : `${from} disappeared and another watched folder may already use the new place. Open MySort to re-pick it.`
      )
      return
    }
    const root = this.deps.settingsService.get().destinationRoot
    if (pathsEqual(root, from)) {
      logger.info(`rename tracking: destination root '${from}' -> '${to}'`)
      await this.applyRootRename(from, to)
    }
  }

  /** Live expiry of an unpaired removal — the folder is gone with no heir. */
  private async handleVanish(vanishedPath: string): Promise<void> {
    if (this.disposed) return
    const folder = this.deps.repos.folders.list().find((r) => pathsEqual(r.path, vanishedPath))
    if (folder) {
      const rt = this.runtimes.get(folder.id)
      if (rt) {
        rt.state = 'unavailable'
        rt.lastError = appError('DEST_UNAVAILABLE', 'the watched folder is gone')
      }
      this.plans.clear()
      this.emitStatus()
    }
    this.notifyFolderMissing(vanishedPath)
  }

  /**
   * Moves the watched folder row to its new path. Same row, same id: history,
   * rules and the auto timestamp keep pointing at this folder.
   */
  private async applyFolderRename(folderId: number, nextPath: string): Promise<FolderRow | null> {
    const row = this.deps.repos.folders.get(folderId)
    if (!row) return null
    if (pathsEqual(row.path, nextPath)) return this.deps.repos.folders.get(folderId)
    try {
      const updated = this.deps.repos.folders.updatePath(folderId, nextPath)
      this.missingNotified.delete(pathKey(row.path))
      const rt = this.runtimes.get(folderId)
      if (rt) {
        rt.row = updated
        if (rt.monitor) await this.stopRuntime(rt)
      }
      await this.renameWatcher.untrack(row.path)
      this.renameWatcher.track(nextPath)
      this.plans.clear()
      if (this.state === 'running' || this.state === 'starting') {
        await this.ensureRuntime(updated)
        void this.reconcile(updated)
      }
      await this.recordParentSnapshot(updated)
      this.emitStatus()
      return updated
    } catch (e) {
      logger.warn(`rename tracking: folder row update refused: ${(e as Error).message}`)
      return null
    }
  }

  /** Moves the destination root setting and every path anchored under it. */
  private async applyRootRename(from: string, to: string): Promise<void> {
    try {
      this.plans.clear()
      this.missingNotified.delete(pathKey(from))
      this.deps.settingsService.update({ destinationRoot: to })
      this.remapAnchoredPaths(from, to)
      await this.syncRootTracking()
      if (this.state === 'running') await this.refreshMonitors()
      await this.snapshotRootParent()
      this.deps.events.settingsChanged(this.deps.settingsService.get())
      this.deps.events.notify(
        'info',
        'Destination folder followed',
        `${path.basename(from)} is now ${to} — sorting continues in the renamed folder.`
      )
      logger.info(`rename tracking: destination root followed to '${to}'`)
    } catch (e) {
      logger.error(`rename tracking: destination root move failed: ${(e as Error).message}`)
    }
  }

  /** Rewrites absolute rule destinations and category destinations under the old root. */
  private remapAnchoredPaths(oldRoot: string, newRoot: string): void {
    // Rules the user anchored by picking a folder through the OS picker.
    this.deps.rulesService.remapAbsoluteDestinations(oldRoot, newRoot)
    // Per-category destinations anchored the same way.
    const categories = this.deps.repos.folders.getCategoryDestinations()
    for (const [category, destPath] of Object.entries(categories)) {
      const next = relocatePath(normalizePath(destPath), oldRoot, newRoot)
      if (next) this.deps.repos.folders.setCategoryDestination(category, next)
    }
  }

  /** Top-level names that are destination subfolders; never sort these as candidates. */
  private combinedDestinationSubfolders(): string[] {
    const names = new Set<string>([
      'Folders', 'Images', 'Videos', 'Documents', 'Audio', 'Archives', 'Other',
      'Apps', 'Music', 'Pictures',
    ])
    try {
      for (const r of this.deps.rulesService.ruleContext().rules) {
        if (r.destination.kind === 'relative' && r.destination.value) {
          const first = r.destination.value.split(/[\\/]/)[0]
          if (first) names.add(first)
        }
      }
    } catch {
      /* rules unavailable; defaults still apply */
    }
    return [...names]
  }

  /** The tracked root changed (user picked another, or tracking followed it). */
  private async syncRootTracking(): Promise<void> {
    const root = this.deps.settingsService.get().destinationRoot
    if (this.trackedRootPath && pathsEqual(this.trackedRootPath, root)) return
    if (this.trackedRootPath) await this.renameWatcher.untrack(this.trackedRootPath)
    this.trackedRootPath = root
    this.renameWatcher.track(root)
  }

  /** Snapshot of the destination root's parent for offline recovery. */
  private async snapshotRootParent(): Promise<void> {
    try {
      const root = this.deps.settingsService.get().destinationRoot
      const dirs = await this.listDirNames(path.dirname(root))
      this.deps.repos.settings.set(SETTINGS_KEY_ROOT_PARENT_SNAPSHOT, dirs)
    } catch {
      /* parent unreadable; snapshot stays stale and recovery stays conservative */
    }
  }

  /** Subfolder names under a parent, via the injected fs port. */
  private async listDirNames(parent: string): Promise<string[]> {
    const names = await this.deps.fs.readdir(parent)
    const dirs: string[] = []
    for (const n of names) {
      try {
        const stat = await this.deps.fs.lstat(path.join(parent, n))
        if (stat.isDirectory) dirs.push(n)
      } catch {
        /* the entry vanished mid-scan */
      }
    }
    return dirs
  }

  /** Snapshot of a watched folder's parent, taken on every successful scan. */
  private async recordParentSnapshot(row: FolderRow): Promise<void> {
    try {
      const dirs = await this.listDirNames(path.dirname(row.path))
      this.deps.repos.folders.setParentDirs(row.id, snapshotNames(dirs))
    } catch {
      /* parent unreadable; snapshot stays stale */
    }
  }

  /** One notice per path per run: the folder is gone and could not be followed. */
  private notifyFolderMissing(folderPath: string): void {
    const key = pathKey(folderPath)
    if (this.missingNotified.has(key)) return
    this.missingNotified.add(key)
    this.deps.events.notify(
      'failure',
      'Folder not found',
      `${folderPath} no longer exists and its new location is not identifiable. Re-pick the folder in Settings to keep sorting it.`
    )
  }

  private toMonitoredFolder(row: FolderRow): MonitoredFolder {
    const rt = this.runtimes.get(row.id)
    return {
      id: row.id,
      path: row.path,
      enabled: row.enabled,
      mode: row.mode,
      autoSince: row.auto_since,
      lastReconciledAt: row.last_reconciled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      state: rt?.state ?? 'paused',
      pendingCandidates: this.countCandidatesIn(row.path),
      lastError: rt?.lastError ?? null,
    }
  }

  // ------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------

  status(): MonitoringStatus {
    let state = this.state
    const runtimes = [...this.runtimes.values()]
    if (state === 'running' && runtimes.some((r) => r.state === 'error')) state = 'error'
    else if (
      state === 'running' &&
      runtimes.length > 0 &&
      runtimes.every((r) => r.state === 'unavailable')
    ) {
      state = 'stopped'
    }
    return {
      state,
      since: this.since,
      folders: runtimes.map((r) => ({
        folderId: r.row.id,
        path: r.row.path,
        state: r.state,
        pendingCandidates: this.countCandidatesIn(r.row.path),
        lastScanAt: r.lastScanAt,
        ...(r.lastError ? { lastError: r.lastError } : {}),
      })),
    }
  }

  async overview(): Promise<OverviewStats> {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const candidates = this.readiness.list()
    return {
      sortedToday: this.deps.repos.operations.countCompletedSince(midnight.toISOString()),
      waiting: candidates.filter((c) => c.state === 'waiting' || c.state === 'ready').length,
      needsAttention: this.deps.repos.operations.countAttention(),
      recent: this.deps.repos.operations.list({ limit: 5 }).items,
      monitoring: this.status(),
      recovery: this.lastRecovery,
    }
  }

  private countCandidatesIn(folderPath: string): number {
    const prefix = folderPath.toLowerCase().replace(/[\\/]+$/, '') + path.sep
    return this.readiness
      .list()
      .filter((c) => c.state !== 'claimed' && c.path.toLowerCase().startsWith(prefix)).length
  }

  private emitStatus(): void {
    if (this.statusEmitScheduled) return
    this.statusEmitScheduled = true
    const timer = setTimeout(() => {
      this.statusEmitScheduled = false
      this.deps.events.monitoringStatus(this.status())
    }, 250)
    timer.unref?.()
  }

  private scheduleStatus(): void {
    this.emitStatus()
  }

  // ------------------------------------------------------------------
  // Watchers
  // ------------------------------------------------------------------

  private async ensureRuntime(row: FolderRow): Promise<void> {
    let rt = this.runtimes.get(row.id)
    if (!rt) {
      rt = {
        row,
        monitor: null,
        state: 'paused',
        lastError: null,
        lastScanAt: null,
        restartTimer: null,
        restartAttempt: 0,
      }
      this.runtimes.set(row.id, rt)
    }
    rt.row = row
    if (this.state !== 'running' && this.state !== 'starting') return
    if (!existsSync(row.path)) {
      rt.state = 'unavailable'
      rt.lastError = appError('DEST_UNAVAILABLE', 'the monitored folder is not available')
      return
    }
    if (rt.monitor) return
    try {
      rt.monitor = this.makeMonitor(row)
      await rt.monitor.start()
      rt.state = 'watching'
      rt.lastError = null
      rt.restartAttempt = 0
      this.readiness.start()
      this.emitStatus()
    } catch (e) {
      rt.monitor = null
      rt.state = 'error'
      rt.lastError = toAppError(e)
      this.scheduleRestart(rt)
    }
  }

  private makeMonitor(row: FolderRow): FolderMonitor {
    const destRoot = this.deps.settingsService.get().destinationRoot
    const combined = pathsEqual(row.path, destRoot)
    // In combined (sort-in-place) mode the watched folder IS the destination
    // root, so ignoring the whole root would ignore everything. Ignore only the
    // destination subfolders instead.
    const ignoredPaths = combined ? [] : [destRoot]
    const isDestSubfolder = (p: string): boolean =>
      combined && this.combinedDestinationSubfolders().includes(path.basename(p))
    return new FolderMonitor({
      folderPath: row.path,
      ignoredPaths,
      events: {
        onAdd: (p) => {
          if (isDestSubfolder(p)) return
          this.deps.onFileEvent?.({ type: 'add', path: p })
          void this.readiness.add(p)
        },
        onAddDir: (p) => {
          if (!this.deps.settingsService.get().sortFolders) return
          const name = path.basename(p)
          if (isDangerousDirName(name)) return
          if (isDestSubfolder(p)) return
          void this.readiness.add(p)
        },
        onChange: (p) => {
          this.deps.onFileEvent?.({ type: 'change', path: p })
          this.readiness.change(p)
        },
        onUnlink: (p) => {
          this.deps.onFileEvent?.({ type: 'unlink', path: p })
          this.readiness.remove(p)
        },
        onUnlinkDir: (p) => this.readiness.remove(p),
        onError: (e) => this.handleWatcherError(row.id, e),
        onReady: () => {
          const rt = this.runtimes.get(row.id)
          if (rt) {
            rt.state = 'watching'
            rt.restartAttempt = 0
            rt.lastError = null
          }
          this.emitStatus()
        },
      },
    })
  }

  private handleWatcherError(folderId: number, error: Error): void {
    const rt = this.runtimes.get(folderId)
    if (!rt) return
    rt.state = 'error'
    rt.lastError = toAppError(error)
    this.emitStatus()
    this.scheduleRestart(rt)
  }

  private scheduleRestart(rt: FolderRuntime): void {
    if (this.disposed) return
    if (rt.restartTimer) clearTimeout(rt.restartTimer)
    const delay = Math.min(1000 * 2 ** rt.restartAttempt, 30_000)
    rt.restartAttempt += 1
    rt.restartTimer = setTimeout(() => {
      rt.restartTimer = null
      void this.recreateMonitor(rt)
    }, delay)
    rt.restartTimer.unref?.()
  }

  private async recreateMonitor(rt: FolderRuntime): Promise<void> {
    if (this.disposed) return
    await this.stopRuntime(rt)
    if (!existsSync(rt.row.path)) {
      rt.state = 'unavailable'
      rt.lastError = appError('DEST_UNAVAILABLE', 'the monitored folder is not available')
      this.emitStatus()
      return this.recreateLater(rt)
    }
    try {
      rt.monitor = this.makeMonitor(rt.row)
      await rt.monitor.start()
      rt.state = 'watching'
      rt.lastError = null
      rt.restartAttempt = 0
      this.emitStatus()
      void this.reconcile(rt.row) // safety net after every successful restart
    } catch (e) {
      rt.monitor = null
      rt.state = 'error'
      rt.lastError = toAppError(e)
      this.scheduleRestart(rt)
    }
  }

  private recreateLater(rt: FolderRuntime): void {
    if (this.disposed) return
    rt.restartTimer = setTimeout(() => {
      rt.restartTimer = null
      void this.recreateMonitor(rt)
    }, 60_000)
    rt.restartTimer.unref?.()
  }

  private async stopRuntime(rt: FolderRuntime): Promise<void> {
    if (rt.restartTimer) {
      clearTimeout(rt.restartTimer)
      rt.restartTimer = null
    }
    const monitor = rt.monitor
    rt.monitor = null
    if (monitor) {
      try {
        await monitor.stop()
      } catch {
        /* watcher already closed */
      }
    }
  }

  // ------------------------------------------------------------------
  // Candidate flow (auto mode)
  // ------------------------------------------------------------------

  private folderForPath(filePath: string): FolderRow | null {
    const dir = path.dirname(filePath).toLowerCase().replace(/[\\/]+$/, '')
    for (const rt of this.runtimes.values()) {
      if (rt.row.path.toLowerCase().replace(/[\\/]+$/, '') === dir) return rt.row
    }
    return null
  }

  private onCandidateReady(candidate: Candidate, fingerprint: Fingerprint): void {
    const folder = this.folderForPath(candidate.path)
    if (!folder) {
      this.readiness.complete(candidate.path)
      return
    }
    const settings = this.deps.settingsService.get()
    if (folder.mode === 'auto' && !settings.previewBeforeAuto) {
      this.readiness.markClaimed(candidate.path)
      void this.autoMove(candidate, fingerprint, folder).finally(() => this.scheduleStatus())
    }
    this.scheduleStatus()
  }

  private async autoMove(
    candidate: Candidate,
    fingerprint: Fingerprint,
    folder: FolderRow
  ): Promise<void> {
    try {
      const settings = this.deps.settingsService.get()
      // Safety: never move a folder that contains the destination root or any
      // monitored folder — that would drag the destination into itself.
      let destPath: string | null = null
      let ruleKind: 'custom' | 'default' | 'none' = 'default'
      let ruleId: string | null = null
      let ruleLabel = 'Folders'
      let explanation = 'Top-level folder sorted into the Folders bucket.'
      const stat = await this.deps.fs.lstat(candidate.path).catch(() => null)
      const isDir = !!stat?.isDirectory && !stat?.isSymlink

      if (isDir && !settings.sortFolders) {
        this.readiness.complete(candidate.path)
        return
      }
      if (isDir && isDangerousDirName(candidate.fileName)) {
        this.readiness.complete(candidate.path)
        return
      }
      if (isDir && (this.combinedDestinationSubfolders().includes(candidate.fileName))) {
        this.readiness.complete(candidate.path)
        return
      }
      if (isDir) {
        const root = normalizePath(settings.destinationRoot)
        if (isInside(root, candidate.path) || pathsEqual(root, candidate.path)) {
          // destination root lives inside this folder: moving it is unsafe
          this.readiness.complete(candidate.path)
          return
        }
        for (const mf of this.deps.repos.folders.list()) {
          if (!mf.enabled) continue
          if (mf.id === folder.id) continue
          if (isInside(mf.path, candidate.path) || pathsEqual(mf.path, candidate.path)) {
            this.readiness.complete(candidate.path)
            return
          }
        }
        // Name-pattern custom rules take precedence over the bucket.
        const ctx = this.deps.rulesService.ruleContext()
        const ordered = sortRules(ctx.rules)
        let matched = false
        for (const rule of ordered) {
          if (!rule.enabled || !rule.namePattern) continue
          if (!patternToRegExp(rule.namePattern).test(candidate.fileName.toLowerCase())) continue
          const resolved = resolveRuleDestination(rule.destination, ctx.destinationRoot)
          if (resolved.ok) {
            destPath = resolved.path
            ruleKind = 'custom'
            ruleId = rule.id
            ruleLabel = rule.name
            explanation = `Matched custom rule '${rule.name}' by filename pattern.`
            matched = true
            break
          }
        }
        if (!matched) {
          destPath = normalizePath(path.join(settings.destinationRoot, 'Folders'))
        }
      } else {
        const resolution = resolveRule(candidate.fileName, this.deps.rulesService.ruleContext())
        if (resolution.outcome === 'no_action') {
          this.readiness.complete(candidate.path)
          return
        }
        if (resolution.outcome === 'error' || !resolution.destination) {
          logger.warn(`auto move refused: rule error for candidate (${resolution.error?.code ?? 'unknown'})`)
          this.readiness.complete(candidate.path)
          return
        }
        destPath = resolution.destination
        ruleKind = resolution.ruleKind === 'none' ? 'default' : resolution.ruleKind
        ruleId = resolution.ruleId
        ruleLabel = resolution.ruleLabel
        explanation = resolution.explanation.summary
      }

      if (isDir && destPath && !sameVolume(candidate.path, destPath)) {
        this.readiness.complete(candidate.path)
        return
      }

      if (!destPath) {
        this.readiness.complete(candidate.path)
        return
      }

      const validation = await validateDestination(
        'absolute',
        destPath,
        this.destinationContext({ sourceFolderId: folder.id, sourceFolderPath: folder.path })
      )
      if (!validation.ok) {
        logger.info(`auto move deferred: ${validation.code}`)
        this.readiness.scheduleBackoff(candidate.path)
        return
      }
      const result = await this.execute({
        operationId: randomUUID(),
        initiatedBy: 'auto',
        folderId: folder.id,
        sourcePath: candidate.path,
        fileName: candidate.fileName,
        destDir: validation.path,
        destName: candidate.fileName,
        rule: {
          kind: ruleKind,
          id: ruleId,
          label: ruleLabel,
          explanation,
        },
        fingerprint,
      })
      this.handleExecuteResult(result, candidate.path)
    } catch (e) {
      logger.error(`auto move failed unexpectedly: ${(e as Error).message}`)
      this.readiness.scheduleBackoff(candidate.path)
    }
  }

  private handleExecuteResult(result: ExecuteResult, sourcePath: string): void {
    const op = this.deps.repos.operations.get(result.operationId)
    if (op) this.deps.events.operationUpdated(op)
    switch (result.status) {
      case 'completed':
        this.readiness.complete(sourcePath)
        if (result.finalDestPath) {
          this.recentlyMoved.set(result.finalDestPath.toLowerCase(), Date.now())
          this.pruneLedger()
        }
        break
      case 'failed':
        if (result.error?.code === 'BUSY' || result.error?.code === 'PERMISSION_DENIED') {
          this.readiness.scheduleBackoff(sourcePath)
        } else {
          this.readiness.complete(sourcePath)
          this.notifyOperationFailed(op)
        }
        break
      case 'skipped':
        if (result.error?.code === 'NOT_READY') this.readiness.releaseToWaiting(sourcePath)
        else this.readiness.complete(sourcePath)
        break
      case 'needs_review':
        this.readiness.complete(sourcePath)
        this.notifyOperationFailed(op)
        break
    }
    this.scheduleStatus()
  }

  private notifyOperationFailed(op: FileOperation | null): void {
    const pref = this.deps.settingsService.get().notifications
    if (pref === 'none' || !op) return
    this.deps.events.notify(
      'failure',
      `Could not organize ${op.fileName}`,
      op.error?.message ?? 'The file was left untouched.'
    )
  }

  private pruneLedger(): void {
    const cutoff = Date.now() - LEDGER_TTL_MS
    for (const [key, at] of this.recentlyMoved) {
      if (at < cutoff) this.recentlyMoved.delete(key)
    }
  }

  private isRecentlyMoved(filePath: string): boolean {
    const at = this.recentlyMoved.get(filePath.toLowerCase())
    return at !== undefined && at >= Date.now() - LEDGER_TTL_MS
  }

  // ------------------------------------------------------------------
  // Execution wrapper
  // ------------------------------------------------------------------

  private execute(
    input: Omit<ExecuteInput, 'validateDestinationPath'> & { allowPaths?: string[] }
  ): Promise<ExecuteResult> {
    const { allowPaths, ...rest } = input
    return executeOperation(
      { fs: this.deps.fs, journal: this.deps.repos.operations },
      {
        ...rest,
        validateDestinationPath: async (destDir: string) => {
          const v = await validateDestination(
            'absolute',
            destDir,
            this.destinationContext({
              allowPaths: allowPaths ?? [],
              sourceFolderId: rest.folderId ?? null,
            })
          )
          return v.ok ? { ok: true } : v
        },
      }
    )
  }

  destinationContext(opts: {
    sourceFolderId?: number | null
    sourceFolderPath?: string | null
    allowPaths?: string[]
  } = {}): DestinationContext {
    return {
      reader: this.deps.fs,
      destinationRoot: this.deps.settingsService.get().destinationRoot,
      sortFolders: this.deps.settingsService.get().sortFolders,
      destinationSubfolders: this.combinedDestinationSubfolders(),
      monitoredFolders: this.deps.repos.folders.list().map((f) => ({
        id: f.id,
        path: f.path,
        enabled: f.enabled,
      })),
      sourceFolderId: opts.sourceFolderId ?? null,
      sourceFolderPath: opts.sourceFolderPath ?? null,
      denyPaths: this.deps.denyPaths,
      allowPaths: opts.allowPaths ?? [],
    }
  }

  // ------------------------------------------------------------------
  // Reconciliation
  // ------------------------------------------------------------------

  async reconcile(row: FolderRow): Promise<void> {
    const rt = this.runtimes.get(row.id)
    try {
      void this.recordParentSnapshot(row) // rename tracking: where the folder's parent stood now
      const entries = await listTopLevel(this.deps.fs, row.path)
      if (row.mode === 'auto') {
        const sinceMs = row.auto_since ? Date.parse(row.auto_since) : 0
        for (const full of entries) {
          const name = path.basename(full)
          if (!checkNameEligibility(name).eligible) continue
          let stat
          try {
            stat = await this.deps.fs.lstat(full)
          } catch {
            continue
          }
          if (stat.isDirectory) {
            if (isDangerousDirName(name)) continue
            if (!this.deps.settingsService.get().sortFolders) continue
            if (this.combinedDestinationSubfolders().includes(name)) continue
          }
          if (this.isRecentlyMoved(full)) continue
          if (!checkStatEligibility(stat).eligible) continue
          if (stat.birthtimeMs < sinceMs) continue // files older than auto_since stay untouched
          if (this.deps.repos.operations.hasActiveOperation(full)) continue
          if (this.deps.repos.operations.wasRecentlyCompleted(full, new Date(Date.now() - 3600_000).toISOString())) {
            continue
          }
          void this.readiness.add(full)
        }
      }
      this.deps.repos.folders.touchReconciled(row.id)
      if (rt) {
        rt.lastScanAt = new Date().toISOString()
        if (rt.state === 'unavailable' || rt.state === 'error') {
          if (rt.state === 'error') {
            // recovered by scan; watcher restart is handled separately
          }
        }
      }
    } catch (e) {
      if (rt) {
        rt.state = 'unavailable'
        rt.lastError = toAppError(e)
      }
    }
    this.scheduleStatus()
  }

  // ------------------------------------------------------------------
  // Preview and apply
  // ------------------------------------------------------------------

  async preview(folderId: number): Promise<OrganizationPlan> {
    const row = this.deps.repos.folders.get(folderId)
    if (!row) throw appError('NOT_FOUND', 'folder not found')
    const plan = await buildPlan(this.deps.fs, {
      folderId: row.id,
      folderPath: row.path,
      rules: this.deps.rulesService.ruleContext(),
      destinationContext: this.destinationContext({
        sourceFolderId: row.id,
        sourceFolderPath: row.path,
      }),
    })
    this.plans.set(plan.planId, { plan, createdAtMs: Date.now() })
    this.prunePlans()
    logger.info(`preview built: ${plan.items.length} items, ${plan.skipped.length} skipped`)
    return plan
  }

  private prunePlans(): void {
    const cutoff = Date.now() - PLAN_TTL_MS
    for (const [k, v] of this.plans) {
      if (v.createdAtMs < cutoff) this.plans.delete(k)
    }
  }

  async applyPlan(planId: string, itemIds: string[]): Promise<PreviewApplyResult> {
    const cached = this.plans.get(planId)
    if (!cached || Date.now() - cached.createdAtMs > PLAN_TTL_MS) {
      this.plans.delete(planId)
      throw appError('NOT_FOUND', 'this preview has expired; please run a new preview')
    }
    const folder = this.deps.repos.folders.get(cached.plan.folderId)
    if (!folder) throw appError('NOT_FOUND', 'the monitored folder no longer exists')

    const batchId = randomUUID()
    const results: OperationResult[] = []
    for (const itemId of itemIds) {
      const item = cached.plan.items.find((i) => i.itemId === itemId)
      if (!item) {
        results.push({
          operationId: '',
          status: 'skipped',
          error: appError('NOT_FOUND', 'this item is not part of the preview'),
        })
        continue
      }
      // Time has passed since the preview: re-check everything from scratch.
      const fingerprint = await confirmStable(this.deps.fs, item.sourcePath)
      if (!fingerprint) {
        results.push({
          operationId: '',
          status: 'skipped',
          error: appError('NOT_READY', 'the file is still changing or no longer exists'),
        })
        continue
      }
      const resolution = resolveRule(item.fileName, this.deps.rulesService.ruleContext())
      if (resolution.outcome === 'no_action' || !resolution.destination) {
        results.push({
          operationId: '',
          status: 'skipped',
          error: appError('RULE_INVALID', 'no rule applies to this file any more'),
        })
        continue
      }
      const validation = await validateDestination(
        'absolute',
        resolution.destination,
        this.destinationContext({ sourceFolderId: folder.id, sourceFolderPath: folder.path })
      )
      if (!validation.ok) {
        results.push({
          operationId: '',
          status: 'skipped',
          error: appError(validation.code, validation.message),
        })
        continue
      }
      const result = await this.execute({
        operationId: randomUUID(),
        initiatedBy: 'manual',
        folderId: folder.id,
        batchId,
        sourcePath: item.sourcePath,
        fileName: item.fileName,
        destDir: validation.path,
        destName: item.fileName,
        rule: {
          kind: resolution.ruleKind,
          id: resolution.ruleId,
          label: resolution.ruleLabel,
          explanation: resolution.explanation.summary,
        },
        fingerprint,
        recordPreFlight: true,
      })
      this.readiness.complete(item.sourcePath)
      const op = this.deps.repos.operations.get(result.operationId)
      if (op) this.deps.events.operationUpdated(op)
      results.push({
        operationId: result.operationId,
        status: result.status,
        ...(result.finalDestPath ? { finalDestPath: result.finalDestPath } : {}),
        ...(result.error ? { error: result.error } : {}),
      })
    }
    this.notifyBatch(results)
    this.scheduleStatus()
    return { batchId, results }
  }

  private notifyBatch(results: OperationResult[]): void {
    const pref = this.deps.settingsService.get().notifications
    if (pref !== 'summaries') return
    const done = results.filter((r) => r.status === 'completed').length
    const failed = results.filter((r) => r.status === 'failed' || r.status === 'needs_review').length
    if (results.length === 0) return
    this.deps.events.notify(
      'summary',
      'Organization finished',
      `${done} file${done === 1 ? '' : 's'} organized${failed > 0 ? `, ${failed} need${failed === 1 ? 's' : ''} attention` : ''}.`
    )
  }

  // ------------------------------------------------------------------
  // Retry and undo
  // ------------------------------------------------------------------

  async retry(operationId: string): Promise<OperationResult> {
    const op = this.deps.repos.operations.get(operationId)
    if (!op) throw appError('NOT_FOUND', 'operation not found')
    if (!['failed', 'skipped', 'needs_review'].includes(op.status)) {
      throw appError('CONFLICT', 'only failed, skipped or needs-review operations can be retried')
    }
    const fingerprint = await confirmStable(this.deps.fs, op.sourcePath)
    if (!fingerprint) {
      return {
        operationId,
        status: 'skipped',
        error: appError('NOT_READY', 'the file is still changing or no longer exists'),
      }
    }
    const folder = this.folderForPath(op.sourcePath)
    const result = await this.execute({
        operationId: randomUUID(),
        initiatedBy: 'retry',
        folderId: folder?.id ?? null,
        batchId: op.batchId,
        sourcePath: op.sourcePath,
        fileName: op.fileName,
        destDir: path.dirname(op.plannedDestPath),
      destName: path.basename(op.plannedDestPath),
      rule: { kind: op.ruleKind, id: null, label: op.ruleLabel, explanation: op.explanation },
      fingerprint,
      recordPreFlight: true,
    })
    const updated = this.deps.repos.operations.get(result.operationId)
    if (updated) this.deps.events.operationUpdated(updated)
    this.scheduleStatus()
    return {
      operationId: result.operationId,
      status: result.status,
      ...(result.finalDestPath ? { finalDestPath: result.finalDestPath } : {}),
      ...(result.error ? { error: result.error } : {}),
    }
  }

  async undo(operationId: string, restoreWithNewName = false): Promise<UndoResult> {
    const row = this.deps.repos.operations.getUndoRow(operationId)
    if (!row) throw appError('NOT_FOUND', 'operation not found')
    const folder = this.folderForPath(row.sourcePath)
    const result = await runUndo(this.deps.fs, row, {
      folderId: folder?.id ?? null,
      undoWindowDays: this.deps.settingsService.get().undoWindowDays,
      restoreWithNewName,
      journal: {
        setUndoStatus: (id, status, blockCode) => this.deps.repos.operations.setUndoStatus(id, status, blockCode),
      },
      executeMove: async ({ operationId: undoOpId, sourcePath, destDir, destName, undoOf, folderId, fingerprint }) =>
        this.execute({
          operationId: undoOpId,
          initiatedBy: 'undo',
          undoOf,
          folderId,
          sourcePath,
          destDir,
          destName,
          rule: {
            kind: 'default',
            id: null,
            label: 'Undo',
            explanation: `Undo of the operation on ${row.fileName}`,
          },
          fingerprint,
          recordPreFlight: true,
          allowPaths: [destDir],
        }),
    })
    const undoOp = result.undoOperationId
      ? this.deps.repos.operations.get(result.undoOperationId)
      : null
    if (undoOp) this.deps.events.operationUpdated(undoOp)
    this.scheduleStatus()
    return {
      operationId,
      ...(result.undoOperationId ? { undoOperationId: result.undoOperationId } : {}),
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    }
  }

  testRules(fileName: string): RuleTestResult {
    return this.deps.rulesService.test(fileName)
  }

  /** IPC-triggered rule change: push the fresh list to every window. */
  emitRulesChanged(): void {
    this.deps.events.rulesChanged()
  }

  /** Recreates watchers (used after the destination root or settings change). */
  async refreshMonitors(): Promise<void> {
    await this.syncRootTracking()
    for (const rt of this.runtimes.values()) {
      if (rt.monitor) {
        await this.stopRuntime(rt)
        rt.monitor = null
        if (this.state === 'running') await this.ensureRuntime(rt.row)
      }
    }
  }
}

/**
 * Manual apply / retry stability confirmation: two identical stats a short time
 * apart, so a file that is still being written is never moved.
 */
export async function confirmStable(
  fs: FsWriter,
  filePath: string,
  intervalMs = PLAN_APPLY_STABILITY_MS
): Promise<Fingerprint | null> {
  let a
  try {
    a = await fs.lstat(filePath)
  } catch {
    return null
  }
  if (!a.isFile || a.isSymlink || a.size === 0) return null
  await new Promise((r) => setTimeout(r, intervalMs))
  let b
  try {
    b = await fs.lstat(filePath)
  } catch {
    return null
  }
  if (!b.isFile || b.size !== a.size || b.mtimeMs !== a.mtimeMs) return null
  return { size: b.size, mtimeMs: b.mtimeMs }
}

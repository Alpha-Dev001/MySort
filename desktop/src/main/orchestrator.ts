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
  OverviewStats,
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

import {
  checkNameEligibility,
  checkStatEligibility,
  validateDestination,
  type DestinationContext,
} from '../engine/pathSafety'
import { resolveRule } from '../engine/rules'
import { SETTINGS_KEY_RULES_SEEDED, SEED_RULES } from '../engine/defaultRules'
import { SettingsService } from './settingsService'
import { RulesService } from './rulesService'
import { logger } from './logger'

export interface OrchestratorEvents {
  monitoringStatus(status: MonitoringStatus): void
  operationUpdated(op: FileOperation): void
  rulesChanged(): void
  settingsChanged(s: ApplicationSettings): void
  notify(kind: 'failure' | 'summary', title: string, body: string): void
}

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

export class Orchestrator {
  private readonly readiness: ReadinessChecker
  private readonly runtimes = new Map<number, FolderRuntime>()
  private readonly recentlyMoved = new Map<string, number>()
  private state: 'stopped' | 'starting' | 'running' | 'paused' | 'error' = 'stopped'
  private since: string | null = null
  private disposed = false
  private statusEmitScheduled = false
  private retentionTimer: ReturnType<typeof setInterval> | null = null

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
  // Monitoring lifecycle
  // ------------------------------------------------------------------

  async startMonitoring(): Promise<MonitoringStatus> {
    if (this.disposed) return this.status()
    this.state = 'starting'
    this.since = new Date().toISOString()
    this.emitStatus()
    const enabled = this.deps.repos.folders.listEnabled()
    for (const row of enabled) {
      await this.ensureRuntime(row)
    }
    this.state = 'running'
    this.emitStatus()
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
    this.emitStatus()
    return this.status()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.retentionTimer) clearInterval(this.retentionTimer)
    for (const rt of this.runtimes.values()) await this.stopRuntime(rt)
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
    if (this.state === 'running' || this.state === 'starting') await this.ensureRuntime(row)
    void this.reconcile(row)
    this.emitStatus()
    return this.toMonitoredFolder(row)
  }

  async removeFolder(folderId: number): Promise<void> {
    const rt = this.runtimes.get(folderId)
    if (rt) {
      await this.stopRuntime(rt)
      this.runtimes.delete(folderId)
    }
    this.deps.repos.folders.remove(folderId) // never touches files
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
      recent: this.deps.repos.operations.list({ limit: 6 }).items,
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
    return new FolderMonitor({
      folderPath: row.path,
      ignoredPaths: [this.deps.settingsService.get().destinationRoot],
      events: {
        onAdd: (p) => {
          void this.readiness.add(p)
        },
        onChange: (p) => this.readiness.change(p),
        onUnlink: (p) => this.readiness.remove(p),
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
      const validation = await validateDestination(
        'absolute',
        resolution.destination,
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
          kind: resolution.ruleKind,
          id: resolution.ruleId,
          label: resolution.ruleLabel,
          explanation: resolution.explanation.summary,
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
      const entries = await listTopLevel(this.deps.fs, row.path)
      if (row.mode === 'auto') {
        const sinceMs = row.auto_since ? Date.parse(row.auto_since) : 0
        for (const full of entries) {
          const name = path.basename(full)
          if (!checkNameEligibility(name).eligible) continue
          if (this.isRecentlyMoved(full)) continue
          let stat
          try {
            stat = await this.deps.fs.lstat(full)
          } catch {
            continue
          }
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

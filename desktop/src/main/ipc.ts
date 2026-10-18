/**
 * IPC handlers: one per channel, each validating its payload with the shared
 * zod schemas and returning a Result envelope. Nothing here trusts the
 * renderer: ids are opaque references, absolute paths only ever arrive through
 * the folder picker grants.
 */

import { app, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { existsSync, promises as fsp, statSync, openSync, readSync, closeSync } from 'node:fs'
import { z } from 'zod'
import { CHANNELS, type ApplicationSettings, type FolderGrant } from '../shared/types'
import { appError, ok, toAppError, type AppError, type Result } from '../shared/errors'
import {
  folderAddSchema,
  folderIdSchema,
  folderPickSchema,
  folderSetModeSchema,
  historyListSchema,
  operationIdSchema,

  rendererErrorSchema,
  ruleIdSchema,
  ruleInputSchema,
  ruleReorderSchema,
  ruleSetEnabledSchema,
  ruleTestSchema,
  ruleUpdateSchema,
  settingsPatchSchema,
  settingsResetSchema,
  showInFolderSchema,
  themePreferenceSchema,
} from '../shared/schemas'
import { validateDestination } from '../engine/pathSafety'
import type { Orchestrator } from './orchestrator'
import type { SettingsService } from './settingsService'
import type { RulesService, ResolvedRuleWrite } from './rulesService'
import type { GrantStore } from './grants'
import { logger } from './logger'
import type { OperationsRepo } from '../db/repositories/operationsRepo'
import type { FoldersRepo } from '../db/repositories/foldersRepo'
import type { SettingsRepo } from '../db/repositories/settingsRepo'

export interface IpcContext {
  orchestrator: Orchestrator
  settingsService: SettingsService
  rulesService: RulesService
  grants: GrantStore
  repos: {
    settings: SettingsRepo
    folders: FoldersRepo
    operations: OperationsRepo
  }
  getWindow: () => Electron.BrowserWindow | null
  applySettingsSideEffects(next: ApplicationSettings, previous: ApplicationSettings): void
}

async function envelope<T>(fn: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return ok(await fn())
  } catch (e) {
    const err: AppError = toAppError(e)
    if (err.code === 'INTERNAL') logger.error(`ipc internal error: ${err.message}`)
    return { ok: false, error: err }
  }
}



function parse<S extends z.ZodType>(schema: S, payload: unknown): z.infer<S> {
  const result = schema.safeParse(payload)
  if (!result.success) {
    const first = result.error.issues[0]
    throw appError(
      'VALIDATION_FAILED',
      `${first?.path.join('.') || 'payload'}: ${first?.message ?? 'invalid input'}`
    )
  }
  return result.data
}

function resolveDestinationInput(
  grants: GrantStore,
  inputDest: { kind: 'relative'; value: string } | { kind: 'absolute'; grantId: string }
): { kind: 'relative' | 'absolute'; value: string } {
  if (inputDest.kind === 'relative') return { kind: 'relative', value: inputDest.value }
  return { kind: 'absolute', value: grants.consume(inputDest.grantId, 'destination') }
}

export function registerIpcHandlers(ctx: IpcContext): void {
  const handle = <R>(channel: string, fn: (payload: unknown) => Promise<R> | R): void => {
    ipcMain.handle(channel, async (_event, payload: unknown) => envelope(() => fn(payload)))
  }
  const handleParsed = <S extends z.ZodType, R>(
    channel: string,
    schema: S,
    fn: (input: z.infer<S>) => Promise<R> | R
  ): void => {
    ipcMain.handle(channel, async (_event, payload: unknown) => envelope(() => fn(parse(schema, payload))))
  }
  const rulesChanged = (): void => { void ctx.orchestrator.emitRulesChanged() }

  // ---------- app info / diagnostics / log ----------
  handle(CHANNELS.appGetInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataFolder: app.getName(),
    userDataPath: app.getPath('userData'),
  }))

  handleParsed(CHANNELS.appSetTheme, z.object({ theme: themePreferenceSchema }), (input) => {
    // Setting the source flips nativeTheme, which re-tints the frameless
    // window's caption overlay through the watcher in window.ts.
    nativeTheme.themeSource = input.theme
    return null
  })

  handle(CHANNELS.diagnosticsExport, async () => {
    const opts = {
      title: 'Export diagnostics',
      defaultPath: `mysort-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    const win = ctx.getWindow()
    const result = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return { saved: false }
    await fsp.writeFile(result.filePath, JSON.stringify(buildDiagnostics(ctx), null, 2), 'utf8')
    logger.info('diagnostics exported')
    return { saved: true }
  })

  handleParsed(CHANNELS.logRendererError, rendererErrorSchema, (input) => {
    logger.error(`renderer: ${input.message}${input.stack ? `\n${input.stack}` : ''}`)
    return null
  })

  // ---------- settings ----------
  handle(CHANNELS.settingsGet, () => ctx.settingsService.get())

  handleParsed(CHANNELS.settingsUpdate, settingsPatchSchema, async (patch) => {
    const previous = ctx.settingsService.get()
    let destinationRoot = previous.destinationRoot
    if (patch.destinationRootGrantId) {
      const granted = ctx.grants.consume(patch.destinationRootGrantId, 'destination')
      const validation = await validateDestination('absolute', granted, ctx.orchestrator.destinationContext())
      if (!validation.ok) throw appError(validation.code, validation.message)
      destinationRoot = granted
    }
    const { destinationRootGrantId: _ignore, ...rest } = patch
    const next = ctx.settingsService.update({ ...rest, destinationRoot })
    ctx.applySettingsSideEffects(next, previous)
    if (patch.destinationRootGrantId) void ctx.orchestrator.refreshMonitors()
    return next
  })

  handleParsed(CHANNELS.settingsResetAll, settingsResetSchema, async (input) => {
    if (input.confirm !== 'RESET') throw appError('VALIDATION_FAILED', 'type RESET to confirm')
    const previous = ctx.settingsService.get()
    for (const f of ctx.repos.folders.list()) await ctx.orchestrator.removeFolder(f.id)
    ctx.repos.operations.deleteAll()
    void ctx.orchestrator.pauseMonitoring()
    ctx.repos.settings.deleteAll()
    const next = ctx.settingsService.get()
    ctx.applySettingsSideEffects(next, previous)
    return next
  })

  // ---------- folders ----------
  handleParsed(CHANNELS.foldersPick, folderPickSchema, async (input): Promise<FolderGrant> => {
    const grant = await ctx.grants.pick(input.purpose, ctx.getWindow())
    if (!grant) throw appError('VALIDATION_FAILED', 'no folder was selected')
    return grant
  })

  handle(CHANNELS.foldersList, () => ctx.orchestrator.listFolders())

  handleParsed(CHANNELS.foldersAdd, folderAddSchema, (input) => {
    const folderPath = ctx.grants.consume(input.grantId, 'monitor')
    return ctx.orchestrator.addFolder(folderPath, input.mode)
  })

  handleParsed(CHANNELS.foldersSetMode, folderSetModeSchema, (input) =>
    ctx.orchestrator.setFolderMode(input.folderId, input.mode)
  )

  handleParsed(CHANNELS.foldersRemove, folderIdSchema, async (input) => {
    await ctx.orchestrator.removeFolder(input.folderId)
    return null
  })

  // ---------- monitoring / overview ----------
  handle(CHANNELS.monitoringGetStatus, () => ctx.orchestrator.status())
  handle(CHANNELS.monitoringStart, () => ctx.orchestrator.startMonitoring())
  handle(CHANNELS.monitoringPause, () => ctx.orchestrator.pauseMonitoring())
  handle(CHANNELS.overviewGet, () => ctx.orchestrator.overview())

  // ---------- rules ----------
  handle(CHANNELS.rulesList, () => ctx.rulesService.list())

  handleParsed(CHANNELS.rulesCreate, ruleInputSchema, (input) => {
    const write: ResolvedRuleWrite = {
      name: input.name,
      extensions: [...input.extensions],
      namePattern: input.namePattern && input.namePattern.length > 0 ? input.namePattern : null,
      destination: resolveDestinationInput(ctx.grants, input.destination),
      enabled: input.enabled,
    }
    const row = ctx.rulesService.create(write)
    const rule = ctx.rulesService.list().find((r) => r.id === row.id)!
    rulesChanged()
    return rule
  })

  handleParsed(CHANNELS.rulesUpdate, ruleUpdateSchema, (input) => {
    // "keep" re-uses the rule's current destination so editing anything else
    // about a grant-protected (absolute) rule needs no fresh folder pick.
    let destination: ResolvedRuleWrite['destination']
    if (input.destination.kind === 'keep') {
      const existing = ctx.rulesService.list().find((r) => r.id === input.ruleId)
      if (!existing) throw appError('NOT_FOUND', 'the rule no longer exists')
      destination = { kind: existing.destination.kind, value: existing.destination.value }
    } else {
      destination = resolveDestinationInput(ctx.grants, input.destination)
    }
    const write: ResolvedRuleWrite = {
      name: input.name,
      extensions: [...input.extensions],
      namePattern: input.namePattern && input.namePattern.length > 0 ? input.namePattern : null,
      destination,
      enabled: input.enabled,
    }
    ctx.rulesService.update(input.ruleId, write)
    const rule = ctx.rulesService.list().find((r) => r.id === input.ruleId)!
    rulesChanged()
    return rule
  })

  handleParsed(CHANNELS.rulesDelete, ruleIdSchema, (input) => {
    ctx.rulesService.remove(input.ruleId)
    rulesChanged()
    return null
  })

  handleParsed(CHANNELS.rulesSetEnabled, ruleSetEnabledSchema, (input) => {
    const rule = ctx.rulesService.setEnabled(input.ruleId, input.enabled)
    rulesChanged()
    return rule
  })

  handleParsed(CHANNELS.rulesReorder, ruleReorderSchema, (input) => {
    const rules = ctx.rulesService.reorder(input.orderedIds)
    rulesChanged()
    return rules
  })

  handleParsed(CHANNELS.rulesTest, ruleTestSchema, (input) => ctx.orchestrator.testRules(input.fileName))

  // ---------- history ----------
  handleParsed(CHANNELS.historyList, historyListSchema, (input) => ctx.repos.operations.list(input))
  handleParsed(CHANNELS.historyRetry, operationIdSchema, (input) => ctx.orchestrator.retry(input.operationId))
  handleParsed(CHANNELS.historyUndo, operationIdSchema, (input) => ctx.orchestrator.undo(input.operationId))

  handleParsed(CHANNELS.historyShowInFolder, showInFolderSchema, (input) => {
    const op = ctx.repos.operations.get(input.operationId)
    if (!op) throw appError('NOT_FOUND', 'operation not found')
    const target = input.which === 'destination' ? (op.finalDestPath ?? op.plannedDestPath) : op.sourcePath
    if (!target || !existsSync(target)) throw appError('NOT_FOUND', 'the file is no longer there')
    shell.showItemInFolder(target)
    return null
  })
}

/** Last 128 KB of the log file, or a marker if it cannot be read at all. */
function readLogTail(): string {
  try {
    const file = logger.transports.file.getFile().path
    const stat = statSync(file)
    const start = Math.max(0, stat.size - 128 * 1024)
    const buf = Buffer.alloc(Math.min(128 * 1024, stat.size - start))
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return '(log file not readable)'
  }
}

function buildDiagnostics(ctx: IpcContext): object {
  const s = ctx.settingsService.get()
  const logTail = readLogTail()
  return {
    generatedAt: new Date().toISOString(),
    app: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
    },
    settings: { ...s, destinationRoot: '[redacted]' },
    counts: {
      folders: ctx.repos.folders.list().length,
      rules: ctx.rulesService.list().length,
      needsAttention: ctx.repos.operations.countAttention(),
    },
    monitoring: ctx.orchestrator.status(),
    logTail,
  }
}

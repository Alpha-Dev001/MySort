/**
 * App entry: single-instance lock, database + services wiring, window/tray
 * lifecycle, recovery on boot, and the settings side effects that belong to
 * the shell (login item, log level, monitor refresh).
 */

import { app, BrowserWindow, dialog } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/database'
import { SettingsRepo } from '../db/repositories/settingsRepo'
import { FoldersRepo } from '../db/repositories/foldersRepo'
import { OperationsRepo } from '../db/repositories/operationsRepo'
import { RulesRepo } from '../db/repositories/rulesRepo'
import { NodeFs } from '../engine/fs'
import { buildDefaultDenyPaths } from '../engine/pathSafety'
import type { ApplicationSettings, Category } from '../shared/types'
import { Orchestrator } from './orchestrator'
import { SettingsService } from './settingsService'
import { RulesService } from './rulesService'
import { GrantStore } from './grants'
import { TrayController } from './tray'
import { createMainWindow, hardenSession, loadRenderer, watchWindowTheme } from './window'
import { notifyUser } from './notifications'
import { configureLogging, logger, maybeRevertDebug } from './logger'
import { registerIpcHandlers } from './ipc'

// Module state must be declared before main() runs: main() executes
// synchronously up to its first `await`, and any `let` below this block would
// be re-initialized afterwards, wiping values it had already assigned.
let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let orchestrator: Orchestrator | null = null
let db: Database.Database | null = null
let quitting = false
let settingsService: SettingsService

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  app.setAppUserModelId('com.mysort.desktop')

  try {
    db = openDatabase(app.getPath('userData') + '/mysort.db')
  } catch (e) {
    logger.error(`cannot open database: ${(e as Error).message}`)
    app.whenReady().then(() => {
      dialog.showErrorBox(
        'MySort cannot start',
        `${(e as Error).message}\n\nRename the file\n${path.join(app.getPath('userData'), 'mysort.db')}\nto move it out of the way.`
      )
      app.quit()
    })
    return
  }

  await app.whenReady()
  hardenSession()
  // Keep the frameless window's native controls tinted to match the UI theme.
  watchWindowTheme()

  const settingsRepo = new SettingsRepo(db)
  const foldersRepo = new FoldersRepo(db)
  const operationsRepo = new OperationsRepo(db)
  const defaultRoot = path.join(app.getPath('documents'), 'MySort')

  settingsService = new SettingsService(settingsRepo, { destinationRoot: defaultRoot })
  const rulesService = new RulesService(
    new RulesRepo(db),
    () => settingsService.get().destinationRoot,
    () => foldersRepo.getCategoryDestinations() as Partial<Record<Category, string>>
  )
  const grants = new GrantStore()

  configureLogging(settingsService.get().logLevel)

  const denyPaths = buildDefaultDenyPaths({
    windowsDir: process.env['WINDIR'],
    programFiles: process.env['ProgramFiles'],
    programFilesX86: process.env['ProgramFiles(x86)'],
    appData: process.env['APPDATA'],
    localAppData: process.env['LOCALAPPDATA'],
    userData: app.getPath('userData'),
    startupDirs: [
      path.join(process.env['APPDATA'] ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
      path.join(process.env['PROGRAMDATA'] ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    ].filter(Boolean),
  })

  orchestrator = new Orchestrator({
    repos: { settings: settingsRepo, folders: foldersRepo, operations: operationsRepo },
    settingsService,
    rulesService,
    fs: new NodeFs(),
    denyPaths,
    events: {
      monitoringStatus: (s) => {
        tray?.setStatus(s)
        broadcast('monitoring:status', s)
      },
      operationUpdated: (op) => broadcast('operation:updated', op),
      recoverySummary: (s) => broadcast('recovery:summary', s),
      rulesChanged: () => broadcast('rules:changed', rulesService.list()),
      settingsChanged: (s) => broadcast('settings:changed', s),
      notify: (kind, title, body) => {
        const pref = settingsService.get().notifications
        if (pref === 'none') return
        if (kind === 'summary' && pref !== 'summaries') return
        notifyUser(title, body)
      },
    },
  })

  registerIpcHandlers({
    orchestrator,
    settingsService,
    rulesService,
    grants,
    repos: { settings: settingsRepo, folders: foldersRepo, operations: operationsRepo },
    getWindow: () => mainWindow,
    applySettingsSideEffects,
  })

  tray = new TrayController({
    openWindow: showMainWindow,
    toggleMonitoring: () => {
      const s = orchestrator?.status()
      if (s?.state === 'running') void orchestrator?.pauseMonitoring()
      else void orchestrator?.startMonitoring()
    },
    organizeNow: () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createAndLoadWindow(settingsService)
      }
      mainWindow?.show()
      mainWindow?.focus()
    },
    openSettings: () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createAndLoadWindow(settingsService)
      }
      mainWindow?.show()
      mainWindow?.focus()
    },
    quit: () => {
      quitting = true
      app.quit()
    },
  })
  tray.create()

  orchestrator.boot()

  const settings = settingsService.get()
  if (settings.resumeMonitoringOnLaunch) {
    const summary = await orchestrator.runRecovery()
    if (summary.checked > 0 || summary.needsReview > 0) {
      showMainWindow()
    }
    void orchestrator.startMonitoring()
  }

  createAndLoadWindow(settingsService)

  app.on('second-instance', () => showMainWindow())
  app.on('activate', () => showMainWindow())

  const revertTimer = setInterval(() => maybeRevertDebug(), 30 * 60 * 1000)
  revertTimer.unref?.()

  app.on('before-quit', () => {
    quitting = true
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && quitting) void shutdown()
  })
  app.on('quit', () => {
    void shutdown()
  })
}

function createAndLoadWindow(settingsSvc: SettingsService): void {
  mainWindow = createMainWindow()
  mainWindow.on('close', (event) => {
    const behavior = (settingsSvc?.get().closeButtonBehavior) ?? 'tray'
    if (!quitting && behavior === 'tray') {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  void loadRenderer(mainWindow)
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  createAndLoadWindow(settingsService)
}

function applySettingsSideEffects(next: ApplicationSettings, previous: ApplicationSettings): void {
  if (next.logLevel !== previous.logLevel) {
    configureLogging(next.logLevel)
  }
  if (next.startWithWindows !== previous.startWithWindows) {
    app.setLoginItemSettings({
      openAtLogin: next.startWithWindows,
      path: process.execPath,
      args: process.defaultApp ? [pathToFileURL(process.argv[1] ?? '').href] : ['--hidden'],
    })
  }
  void orchestrator?.refreshMonitors().catch((e: unknown) => {
    logger.warn(`monitor refresh failed: ${(e as Error).message}`)
  })
}


function broadcast(channel: string, payload: unknown): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  tray?.destroy()
  tray = null
  try {
    await orchestrator?.dispose()
    orchestrator = null
    db?.close()
    db = null
  } catch (e) {
    logger.error(`shutdown error: ${(e as Error).message}`)
  }
}

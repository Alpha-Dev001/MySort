/**
 * App entry: single-instance lock, database + services wiring, window/tray
 * lifecycle, recovery on boot, and the settings side effects that belong to
 * the shell (login item, log level, monitor refresh).
 */

import { app, BrowserWindow, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { openDatabase } from '../db/database'
import { SettingsRepo } from '../db/repositories/settingsRepo'
import { FoldersRepo } from '../db/repositories/foldersRepo'
import { OperationsRepo } from '../db/repositories/operationsRepo'
import { RulesRepo } from '../db/repositories/rulesRepo'
import { IndexRepo } from '../db/repositories/indexRepo'
import { CollectionsRepo } from '../db/repositories/collectionsRepo'
import { RecommendationsRepo } from '../db/repositories/recommendationsRepo'
import { NodeFs } from '../engine/fs'
import { buildDefaultDenyPaths } from '../engine/pathSafety'
import type { ApplicationSettings, Category } from '../shared/types'
import { Orchestrator } from './orchestrator'
import { SettingsService } from './settingsService'
import { RulesService } from './rulesService'
import { SearchService } from './searchService'
import { DuplicateService } from './duplicateService'
import { RecommendationService } from './recommendationService'
import { CollectionService } from './collectionService'
import { GrantStore } from './grants'
import { TrayController } from './tray'
import { createMainWindow, hardenSession, watchWindowTheme } from './window'
import { notifyUser } from './notifications'
import { configureLogging, logger, maybeRevertDebug } from './logger'
import { registerIpcHandlers } from './ipc'

// Module state must be declared before main() runs: main() executes
// synchronously up to its first `await`, and any `let` below this block would
// be re-initialized afterwards, wiping values it had already assigned.
let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let orchestrator: Orchestrator | null = null
let searchService: SearchService | null = null
let db: Database.Database | null = null
let quitting = false
let settingsService: SettingsService

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  void main()
}

/** Launched at login with `--hidden`: the window stays hidden, only the tray appears. */
const launchedHidden = process.argv.includes('--hidden')

/** Register/unregister the login item. Idempotent; use for both toggles and boot sync. */
function syncLoginItem(startWithWindows: boolean): void {
  // Linux has no single standard login-item API; use the XDG autostart entry.
  if (process.platform === 'linux') {
    const home = process.env['HOME'] ?? app.getPath('home')
    const dir = path.join(home, '.config', 'autostart')
    const file = path.join(dir, 'MySort.desktop')
    try {
      if (!startWithWindows) {
        fs.rmSync(file, { force: true })
        return
      }
      fs.mkdirSync(dir, { recursive: true })
      const exec = process.defaultApp
        ? `${process.execPath} ${pathToFileURL(process.argv[1] ?? '').href}`
        : `${process.execPath} --hidden`
      fs.writeFileSync(
        file,
        `[Desktop Entry]\nType=Application\nName=MySort\nExec=${exec}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`
      )
    } catch (e) {
      logger.warn(`could not update Linux autostart entry: ${(e as Error).message}`)
    }
    return
  }
  app.setLoginItemSettings({
    openAtLogin: startWithWindows,
    path: process.execPath,
    args: process.defaultApp ? [pathToFileURL(process.argv[1] ?? '').href] : ['--hidden'],
  })
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
  const indexRepo = new IndexRepo(db)
  const collectionsRepo = new CollectionsRepo(db)
  const recommendationsRepo = new RecommendationsRepo(db)
  const defaultRoot = app.getPath('downloads')

  settingsService = new SettingsService(settingsRepo, { destinationRoot: defaultRoot })
  const rulesService = new RulesService(
    new RulesRepo(db),
    () => settingsService.get().destinationRoot,
    () => foldersRepo.getCategoryDestinations() as Partial<Record<Category, string>>
  )
  const grants = new GrantStore()

  configureLogging(settingsService.get().logLevel)

  const home = process.env['HOME'] ?? app.getPath('home')
  const denyPaths = buildDefaultDenyPaths({
    windowsDir: process.env['WINDIR'],
    programFiles: process.env['ProgramFiles'],
    programFilesX86: process.env['ProgramFiles(x86)'],
    appData: process.env['APPDATA'] ?? (process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : process.platform === 'linux'
        ? (process.env['XDG_CONFIG_HOME'] || path.join(home, '.config'))
        : undefined),
    localAppData: process.env['LOCALAPPDATA'] ?? (process.platform === 'darwin'
      ? path.join(home, 'Library', 'Caches')
      : process.platform === 'linux'
        ? path.join(home, '.local', 'share')
        : undefined),
    userData: app.getPath('userData'),
    startupDirs: process.platform === 'win32'
      ? [
          path.join(process.env['APPDATA'] ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
          path.join(process.env['PROGRAMDATA'] ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
        ].filter(Boolean)
      : [],
  })

  const nodeFs = new NodeFs()
  const search = new SearchService({
    indexRepo,
    settingsRepo,
    fs: nodeFs,
    // The default index scope follows the folders MySort already watches.
    defaultRoots: () => {
      const roots = new Set<string>()
      for (const folder of foldersRepo.listEnabled()) roots.add(folder.path)
      roots.add(settingsService.get().destinationRoot)
      return [...roots].filter((r) => r.length > 0)
    },
    // The renderer shows indexing progress, so the status is pushed to it.
    onStatus: (status) => broadcast('index:status', status),
  })
  const duplicateService = new DuplicateService({ indexRepo, fs: nodeFs })
  const recommendationService = new RecommendationService({
    recommendationsRepo,
    operationsRepo,
    rulesService,
    searchService: search,
    settingsService,
  })
  const collectionService = new CollectionService({
    collectionsRepo,
    indexRepo,
    searchService: search,
    fs: nodeFs,
  })
  searchService = search

  orchestrator = new Orchestrator({
    repos: { settings: settingsRepo, folders: foldersRepo, operations: operationsRepo },
    settingsService,
    rulesService,
    fs: nodeFs,
    denyPaths,
    onFileEvent: (event) => {
      void search.applyFileEvent(event.type, event.path)
    },
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

  // First install: seed Downloads as the watched folder (sort in place) so the
  // user does not have to pick a folder, and mark onboarding complete.
  if (foldersRepo.list().length === 0) {
    try {
      foldersRepo.insert({ path: app.getPath('downloads'), mode: 'auto', autoSince: null })
      settingsService.update({ onboardingCompleted: true })
    } catch (e) {
      logger.warn(`first-install seed failed: ${(e as Error).message}`)
    }
  }

  registerIpcHandlers({
    orchestrator,
    settingsService,
    rulesService,
    grants,
    searchService,
    duplicateService,
    recommendationService,
    collectionService,
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
    // Settle anything a previous run left half-finished before watching again.
    const summary = await orchestrator.runRecovery()
    if (summary.checked > 0 || summary.needsReview > 0) {
      showMainWindow()
    }
    void orchestrator.startMonitoring()
  }

  // "Always start with the computer" is the default; the login item only
  // exists if something actually registered it, so boot syncs it too. Dev runs
  // must not claim the login item themselves.
  if (settings.startWithWindows && !process.defaultApp) syncLoginItem(true)

  createAndLoadWindow(settingsService, !launchedHidden)

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

function createAndLoadWindow(settingsSvc: SettingsService, show = true): void {
  // `createMainWindow` loads the renderer itself; loading it a second time
  // would abort the first request and leave the window blank.
  mainWindow = createMainWindow(show)
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
    syncLoginItem(next.startWithWindows)
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
    // Stop any running index pass before the database goes away.
    await searchService?.drain()
    await orchestrator?.dispose()
    orchestrator = null
    db?.close()
    db = null
  } catch (e) {
    logger.error(`shutdown error: ${(e as Error).message}`)
  }
}

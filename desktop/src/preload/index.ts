/**
 * Preload: the only bridge between the sandboxed renderer and main.
 *
 * Every request channel returns a Result envelope (never throws across the
 * bridge); every event subscription returns its own unsubscribe function so
 * React cleanup cannot remove someone else's listener.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  CHANNELS,
  EVENT_CHANNELS,
  type ApplicationSettings,
  type FileOperation,
  type FileRule,
  type HistoryQuery,
  type MonitoringStatus,
  type MySortApi,
  type RuleInput,
  type SettingsPatch,
  type Unsubscribe,
} from '../shared/types'

const invoke = (channel: string, payload: unknown): Promise<unknown> =>
  ipcRenderer.invoke(channel, payload)

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: MySortApi = {
  app: {
    getInfo: () => invoke(CHANNELS.appGetInfo, null) as ReturnType<MySortApi['app']['getInfo']>,
    setTheme: (theme) => invoke(CHANNELS.appSetTheme, { theme }) as ReturnType<MySortApi['app']['setTheme']>,
  },
  settings: {
    get: () => invoke(CHANNELS.settingsGet, null) as ReturnType<MySortApi['settings']['get']>,
    update: (patch: SettingsPatch) =>
      invoke(CHANNELS.settingsUpdate, patch) as ReturnType<MySortApi['settings']['update']>,
    resetAll: (confirm: string) =>
      invoke(CHANNELS.settingsResetAll, { confirm }) as ReturnType<MySortApi['settings']['resetAll']>,
  },
  folders: {
    pick: (purpose) => invoke(CHANNELS.foldersPick, { purpose }) as ReturnType<MySortApi['folders']['pick']>,
    list: () => invoke(CHANNELS.foldersList, null) as ReturnType<MySortApi['folders']['list']>,
    add: (input) => invoke(CHANNELS.foldersAdd, input) as ReturnType<MySortApi['folders']['add']>,
    setMode: (input) => invoke(CHANNELS.foldersSetMode, input) as ReturnType<MySortApi['folders']['setMode']>,
    remove: (input) => invoke(CHANNELS.foldersRemove, input) as ReturnType<MySortApi['folders']['remove']>,
  },
  monitoring: {
    getStatus: () =>
      invoke(CHANNELS.monitoringGetStatus, null) as ReturnType<MySortApi['monitoring']['getStatus']>,
    start: () => invoke(CHANNELS.monitoringStart, null) as ReturnType<MySortApi['monitoring']['start']>,
    pause: () => invoke(CHANNELS.monitoringPause, null) as ReturnType<MySortApi['monitoring']['pause']>,
  },
  rules: {
    list: () => invoke(CHANNELS.rulesList, null) as ReturnType<MySortApi['rules']['list']>,
    create: (input: RuleInput) => invoke(CHANNELS.rulesCreate, input) as ReturnType<MySortApi['rules']['create']>,
    update: (input) => invoke(CHANNELS.rulesUpdate, input) as ReturnType<MySortApi['rules']['update']>,
    remove: (input) => invoke(CHANNELS.rulesDelete, input) as ReturnType<MySortApi['rules']['remove']>,
    setEnabled: (input) => invoke(CHANNELS.rulesSetEnabled, input) as ReturnType<MySortApi['rules']['setEnabled']>,
    reorder: (input) => invoke(CHANNELS.rulesReorder, input) as ReturnType<MySortApi['rules']['reorder']>,
    test: (input) => invoke(CHANNELS.rulesTest, input) as ReturnType<MySortApi['rules']['test']>,
  },
  history: {
    list: (input: HistoryQuery) => invoke(CHANNELS.historyList, input) as ReturnType<MySortApi['history']['list']>,
    retry: (input) => invoke(CHANNELS.historyRetry, input) as ReturnType<MySortApi['history']['retry']>,
    undo: (input) => invoke(CHANNELS.historyUndo, input) as ReturnType<MySortApi['history']['undo']>,
    showInFolder: (input) =>
      invoke(CHANNELS.historyShowInFolder, input) as ReturnType<MySortApi['history']['showInFolder']>,
  },
  overview: {
    get: () => invoke(CHANNELS.overviewGet, null) as ReturnType<MySortApi['overview']['get']>,
  },
  diagnostics: {
    export: () => invoke(CHANNELS.diagnosticsExport, null) as ReturnType<MySortApi['diagnostics']['export']>,
  },
  log: {
    rendererError: (input) =>
      invoke(CHANNELS.logRendererError, input) as ReturnType<MySortApi['log']['rendererError']>,
  },

  onMonitoringStatus: (cb: (s: MonitoringStatus) => void) =>
    subscribe(EVENT_CHANNELS.monitoringStatus, cb),
  onOperationUpdated: (cb: (op: FileOperation) => void) =>
    subscribe(EVENT_CHANNELS.operationUpdated, cb),
  onRulesChanged: (cb: (rules: FileRule[]) => void) => subscribe(EVENT_CHANNELS.rulesChanged, cb),
  onSettingsChanged: (cb: (s: ApplicationSettings) => void) =>
    subscribe(EVENT_CHANNELS.settingsChanged, cb),
}

try {
  contextBridge.exposeInMainWorld('api', api)
} catch {
  // Reload after renderer crash: the bridge may already exist. Ignore.
}

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
  type CollectionRule,
  type FileOperation,
  type FileRule,
  type HistoryQuery,
  type IndexScope,
  type IndexStatus,
  type MonitoringStatus,
  type MySortApi,
  type RuleInput,
  type SearchQuery,
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

  search: {
    query: (input: SearchQuery) =>
      invoke(CHANNELS.searchQuery, input) as ReturnType<MySortApi['search']['query']>,
    recent: (limit?: number) =>
      invoke(CHANNELS.searchRecent, { limit }) as ReturnType<MySortApi['search']['recent']>,
    scope: () => invoke(CHANNELS.searchScope, null) as ReturnType<MySortApi['search']['scope']>,
    setScope: (input: { scope: IndexScope }) =>
      invoke(CHANNELS.searchSetScope, input) as ReturnType<MySortApi['search']['setScope']>,
    status: () => invoke(CHANNELS.searchStatus, null) as ReturnType<MySortApi['search']['status']>,
    start: (input?: { rebuild?: boolean }) =>
      invoke(CHANNELS.searchStart, input ?? {}) as ReturnType<MySortApi['search']['start']>,
    cancel: () => invoke(CHANNELS.searchCancel, null) as ReturnType<MySortApi['search']['cancel']>,
    clear: () => invoke(CHANNELS.searchClear, null) as ReturnType<MySortApi['search']['clear']>,
    open: (input: { path: string }) =>
      invoke(CHANNELS.searchOpen, input) as ReturnType<MySortApi['search']['open']>,
    reveal: (input: { path: string }) =>
      invoke(CHANNELS.searchReveal, input) as ReturnType<MySortApi['search']['reveal']>,
    openFolder: (input: { path: string }) =>
      invoke(CHANNELS.searchOpenFolder, input) as ReturnType<MySortApi['search']['openFolder']>,
  },

  duplicates: {
    scan: (input?: { limit?: number }) =>
      invoke(CHANNELS.duplicatesScan, input ?? {}) as ReturnType<MySortApi['duplicates']['scan']>,
  },

  recommendations: {
    list: () =>
      invoke(CHANNELS.recommendationsList, null) as ReturnType<MySortApi['recommendations']['list']>,
    dismiss: (input: { id: string }) =>
      invoke(CHANNELS.recommendationsDismiss, input) as ReturnType<MySortApi['recommendations']['dismiss']>,
    accept: (input: { id: string }) =>
      invoke(CHANNELS.recommendationsAccept, input) as ReturnType<MySortApi['recommendations']['accept']>,
    preview: (input: { id: string }) =>
      invoke(CHANNELS.recommendationsPreview, input) as ReturnType<MySortApi['recommendations']['preview']>,
    detect: () =>
      invoke(CHANNELS.recommendationsDetect, null) as ReturnType<MySortApi['recommendations']['detect']>,
  },

  collections: {
    list: () => invoke(CHANNELS.collectionsList, null) as ReturnType<MySortApi['collections']['list']>,
    create: (input: { name: string; description?: string }) =>
      invoke(CHANNELS.collectionsCreate, input) as ReturnType<MySortApi['collections']['create']>,
    remove: (input: { id: string }) =>
      invoke(CHANNELS.collectionsRemove, input) as ReturnType<MySortApi['collections']['remove']>,
    setRules: (input: { id: string; rules: CollectionRule[] }) =>
      invoke(CHANNELS.collectionsSetRules, input) as ReturnType<MySortApi['collections']['setRules']>,
    addMember: (input: { id: string; path: string }) =>
      invoke(CHANNELS.collectionsAddMember, input) as ReturnType<MySortApi['collections']['addMember']>,
    removeMember: (input: { id: string; path: string }) =>
      invoke(CHANNELS.collectionsRemoveMember, input) as ReturnType<MySortApi['collections']['removeMember']>,
    members: (input: { id: string }) =>
      invoke(CHANNELS.collectionsMembers, input) as ReturnType<MySortApi['collections']['members']>,
  },

  inbox: {
    plan: (input: { folderId: number }) =>
      invoke(CHANNELS.inboxPlan, input) as ReturnType<MySortApi['inbox']['plan']>,
    apply: (input: { planId: string; itemIds: string[] }) =>
      invoke(CHANNELS.inboxApply, input) as ReturnType<MySortApi['inbox']['apply']>,
  },

  onMonitoringStatus: (cb: (s: MonitoringStatus) => void) =>
    subscribe(EVENT_CHANNELS.monitoringStatus, cb),
  onOperationUpdated: (cb: (op: FileOperation) => void) =>
    subscribe(EVENT_CHANNELS.operationUpdated, cb),
  onRulesChanged: (cb: (rules: FileRule[]) => void) => subscribe(EVENT_CHANNELS.rulesChanged, cb),
  onSettingsChanged: (cb: (s: ApplicationSettings) => void) =>
    subscribe(EVENT_CHANNELS.settingsChanged, cb),
  onIndexStatus: (cb: (s: IndexStatus) => void) => subscribe(EVENT_CHANNELS.indexStatus, cb),
}

try {
  contextBridge.exposeInMainWorld('api', api)
} catch {
  // Reload after renderer crash: the bridge may already exist. Ignore.
}

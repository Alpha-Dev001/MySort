/**
 * Domain types shared across processes.
 *
 * These are the IPC-facing contracts: main produces them, preload forwards them,
 * renderer displays them. Nothing here imports runtime dependencies.
 */

import type { AppError, ErrorCode, Result } from './errors'

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

export type Category = 'images' | 'videos' | 'documents' | 'audio' | 'archives' | 'other'

export const CATEGORIES: readonly Category[] = [
  'images',
  'videos',
  'documents',
  'audio',
  'archives',
  'other',
] as const

export type OperationStatus =
  | 'planned'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'needs_review'

export type UndoStatus = 'not_eligible' | 'available' | 'done' | 'blocked' | 'expired'

export type RuleKind = 'custom' | 'default' | 'none'

export type MoveMethod = 'link_unlink' | 'rename' | 'copy_verify'

export type InitiatedBy = 'auto' | 'manual' | 'retry' | 'recovery' | 'undo'

export type FolderMode = 'manual' | 'auto'

export type MonitoringState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'paused'
  | 'error'
  | 'folder_unavailable'

export type FolderState = 'watching' | 'unavailable' | 'error' | 'paused'

export type NotificationPreference = 'failures' | 'summaries' | 'none'

export type CloseButtonBehavior = 'tray' | 'quit'

/** Appearance preference. `system` follows the OS setting. */
export type ThemePreference = 'light' | 'dark' | 'system'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface RuleDestination {
  kind: 'relative' | 'absolute'
  value: string
}

export interface FileRule {
  id: string
  name: string
  /** Normalized: lowercase, no leading dots, e.g. ['pdf', 'tar.gz']. */
  extensions: string[]
  /** Optional wildcard filename pattern, e.g. 'invoice-*'. '*' and '?' only. */
  namePattern: string | null
  destination: RuleDestination
  enabled: boolean
  /** User order; lower is checked first. */
  position: number
  warnings: RuleWarning[]
  createdAt: string
  updatedAt: string
}

export interface RuleWarning {
  code: 'OVERLAPS' | 'SHADOWED' | 'DEST_UNAVAILABLE'
  otherRuleId?: string
  otherRuleName?: string
}

/** Input for rules:create / rules:update. Absolute destinations must carry a grant. */
export type RuleInput = {
  name: string
  extensions: string[]
  namePattern: string | null
  destination:
    | { kind: 'relative'; value: string }
    | { kind: 'absolute'; grantId: string }
  enabled: boolean
}

/**
 * rules:update may also keep the rule's existing destination untouched
 * (absolute destinations then need no fresh grant).
 */
export type RuleUpdateDestination =
  | RuleInput['destination']
  | { kind: 'keep' }

export type RuleUpdateInput = Omit<RuleInput, 'destination'> & {
  destination: RuleUpdateDestination
}

export type RuleExplanationOutcome = 'custom' | 'default' | 'no_action' | 'error'

export interface RuleExplanation {
  outcome: RuleExplanationOutcome
  summary: string
  considered: {
    ruleId: string | null
    name: string
    result: 'won' | 'shadowed' | 'disabled' | 'no_match' | 'invalid'
  }[]
}

// ---------------------------------------------------------------------------
// Preview / plan
// ---------------------------------------------------------------------------

export interface PlannedMove {
  /** Opaque id; preview:apply takes these instead of paths. */
  itemId: string
  fileName: string
  /** Display only. */
  sourcePath: string
  /** Display only. */
  destPath: string
  sizeBytes: number
  explanation: RuleExplanation
  warnings: PlanWarning[]
}

export type PlanWarning = 'NAME_CONFLICT_WILL_RENAME' | 'CROSS_VOLUME' | 'DEST_FOLDER_WILL_BE_CREATED'

// ---------------------------------------------------------------------------
// Operations / history
// ---------------------------------------------------------------------------

export interface FileOperation {
  id: string
  batchId: string | null
  initiatedBy: InitiatedBy
  undoOf: string | null
  fileName: string
  sourcePath: string
  plannedDestPath: string
  finalDestPath: string | null
  ruleKind: RuleKind
  ruleLabel: string
  explanation: string
  status: OperationStatus
  error: AppError | null
  undo: { status: UndoStatus; blockCode: ErrorCode | null }
  sizeBytes: number | null
  createdAt: string
  finishedAt: string | null
}

export interface OperationResult {
  operationId: string
  status: 'completed' | 'failed' | 'skipped' | 'needs_review'
  finalDestPath?: string
  error?: AppError
}

export interface UndoResult {
  operationId: string
  undoOperationId?: string
  status: 'done' | 'blocked' | 'failed'
  error?: AppError
}

/**
 * One page of history.
 *
 * `total` is the size of the *filtered* result set, not of the table, so the
 * renderer can show real page numbers instead of guessing whether more exists.
 */
export interface HistoryPage {
  items: FileOperation[]
  total: number
  /** Counts per status over the same date/search basis, ignoring the status filter. */
  statusCounts?: Partial<Record<OperationStatus, number>>
}

// ---------------------------------------------------------------------------
// Monitoring / folders
// ---------------------------------------------------------------------------

export interface MonitoredFolder {
  id: number
  path: string
  enabled: boolean
  mode: FolderMode
  autoSince: string | null
  lastReconciledAt: string | null
  createdAt: string
  updatedAt: string
  state: FolderState
  pendingCandidates: number
  lastError: AppError | null
}

export interface MonitoringStatus {
  state: MonitoringState
  since: string | null
  folders: {
    folderId: number
    path: string
    state: FolderState
    pendingCandidates: number
    lastScanAt: string | null
    lastError?: AppError
  }[]
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ApplicationSettings {
  destinationRoot: string
  startWithWindows: boolean
  closeButtonBehavior: CloseButtonBehavior
  resumeMonitoringOnLaunch: boolean
  notifications: NotificationPreference
  previewBeforeAuto: boolean
  historyRetentionDays: number
  undoWindowDays: number
  logLevel: LogLevel
  onboardingCompleted: boolean
  /** Internal tuning knob; not exposed in the UI yet. */
  readinessStableChecks: number
}

// ---------------------------------------------------------------------------
// App info, overview, recovery
// ---------------------------------------------------------------------------

export interface AppInfo {
  version: string
  platform: string
  /** Display name of the app data folder (e.g. "MySort (app data)"). */
  dataFolder: string
  userDataPath: string
}

export interface OverviewStats {
  sortedToday: number
  needsAttention: number
  recent: FileOperation[]
  monitoring: MonitoringStatus
}

// ---------------------------------------------------------------------------
// Folder grants (picker results)
// ---------------------------------------------------------------------------

export interface FolderGrant {
  grantId: string
  displayName: string
}

export type FolderPickPurpose = 'monitor' | 'destination'

// ---------------------------------------------------------------------------
// Renderer-facing bridge API (implemented by preload, typed for renderer)
// ---------------------------------------------------------------------------

export type Unsubscribe = () => void

export interface MySortApi {
  app: {
    getInfo(): Promise<Result<AppInfo>>
    /**
     * Drives `nativeTheme.themeSource` so the frameless window's native
     * minimise/maximise/close overlay stays tinted to the chosen theme.
     */
    setTheme(theme: ThemePreference): Promise<Result<null>>
  }
  settings: {
    get(): Promise<Result<ApplicationSettings>>
    update(patch: SettingsPatch): Promise<Result<ApplicationSettings>>
    resetAll(confirm: string): Promise<Result<ApplicationSettings>>
  }
  folders: {
    pick(purpose: FolderPickPurpose): Promise<Result<FolderGrant>>
    list(): Promise<Result<MonitoredFolder[]>>
    add(input: { grantId: string; mode: FolderMode }): Promise<Result<MonitoredFolder>>
    setMode(input: { folderId: number; mode: FolderMode }): Promise<Result<MonitoredFolder>>
    remove(input: { folderId: number }): Promise<Result<null>>
  }
  monitoring: {
    getStatus(): Promise<Result<MonitoringStatus>>
    start(): Promise<Result<MonitoringStatus>>
    pause(): Promise<Result<MonitoringStatus>>
  }
  rules: {
    list(): Promise<Result<FileRule[]>>
    create(input: RuleInput): Promise<Result<FileRule>>
    update(input: { ruleId: string } & RuleUpdateInput): Promise<Result<FileRule>>
    remove(input: { ruleId: string }): Promise<Result<null>>
    setEnabled(input: { ruleId: string; enabled: boolean }): Promise<Result<FileRule>>
    reorder(input: { orderedIds: string[] }): Promise<Result<FileRule[]>>
    test(input: { fileName: string }): Promise<Result<RuleTestResult>>
  }
  history: {
    list(input: HistoryQuery): Promise<Result<HistoryPage>>
    retry(input: { operationId: string }): Promise<Result<OperationResult>>
    undo(input: { operationId: string }): Promise<Result<UndoResult>>
    showInFolder(input: { operationId: string; which: 'source' | 'destination' }): Promise<Result<null>>
  }
  overview: { get(): Promise<Result<OverviewStats>> }
  diagnostics: { export(): Promise<Result<{ saved: boolean }>> }
  log: { rendererError(input: { message: string; stack?: string }): Promise<Result<null>> }

  onMonitoringStatus(cb: (s: MonitoringStatus) => void): Unsubscribe
  onOperationUpdated(cb: (op: FileOperation) => void): Unsubscribe
  onRulesChanged(cb: (rules: FileRule[]) => void): Unsubscribe
  onSettingsChanged(cb: (s: ApplicationSettings) => void): Unsubscribe
}

export interface SettingsPatch {
  startWithWindows?: boolean
  closeButtonBehavior?: CloseButtonBehavior
  resumeMonitoringOnLaunch?: boolean
  notifications?: NotificationPreference
  previewBeforeAuto?: boolean
  historyRetentionDays?: number
  undoWindowDays?: number
  logLevel?: LogLevel
  onboardingCompleted?: boolean
  /** Absolute destination root, granted through the folder picker. */
  destinationRootGrantId?: string
}

export interface RuleTestResult {
  explanation: RuleExplanation
  destination: string | null
  category: Category | null
}



export interface HistoryQuery {
  query?: string
  status?: OperationStatus | 'all'
  from?: string
  to?: string
  /** Rows to skip. Paging is offset-based so a page number can be requested directly. */
  offset?: number
  limit?: number
}

/** Event channels, main → renderer. */
export const EVENT_CHANNELS = {
  monitoringStatus: 'monitoring:status',
  operationUpdated: 'operation:updated',
  rulesChanged: 'rules:changed',
  settingsChanged: 'settings:changed',
} as const

/** Request channels, renderer → main. */
export const CHANNELS = {
  appGetInfo: 'app:getInfo',
  appSetTheme: 'app:setTheme',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsResetAll: 'settings:resetAll',
  foldersPick: 'folders:pick',
  foldersList: 'folders:list',
  foldersAdd: 'folders:add',
  foldersSetMode: 'folders:setMode',
  foldersRemove: 'folders:remove',
  monitoringGetStatus: 'monitoring:getStatus',
  monitoringStart: 'monitoring:start',
  monitoringPause: 'monitoring:pause',
  overviewGet: 'overview:get',
  rulesList: 'rules:list',
  rulesCreate: 'rules:create',
  rulesUpdate: 'rules:update',
  rulesDelete: 'rules:delete',
  rulesSetEnabled: 'rules:setEnabled',
  rulesReorder: 'rules:reorder',
  rulesTest: 'rules:test',
  historyList: 'history:list',
  historyRetry: 'history:retry',
  historyUndo: 'history:undo',
  historyShowInFolder: 'history:showInFolder',
  diagnosticsExport: 'diagnostics:export',
  logRendererError: 'log:rendererError',
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]

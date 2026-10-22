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

export interface SkippedPlanItem {
  fileName: string
  /** A `SkipReason`, an `ErrorCode`, or 'NOT_READY' / 'NO_EXTENSION'. */
  reason: string
}

/** One read-only pass over a monitored folder: what would happen, and what would not. */
export interface OrganizationPlan {
  /** Opaque id; preview:apply takes these item ids instead of paths. */
  planId: string
  folderId: number
  folderPath: string
  createdAt: string
  items: PlannedMove[]
  skipped: SkippedPlanItem[]
}

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

/** Outcome of applying the approved subset of one plan. */
export interface PreviewApplyResult {
  /** Groups every move made by a single apply so history can batch them. */
  batchId: string
  results: OperationResult[]
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
  /** Whether top-level folders are sorted into a "Folders" bucket. */
  sortFolders: boolean
  historyRetentionDays: number
  undoWindowDays: number
  logLevel: LogLevel
  onboardingCompleted: boolean
  /** How many repeated moves are needed before a rule is suggested. */
  recommendationThreshold: number
  /** Internal tuning knob; not exposed in the UI yet. */
  readinessStableChecks: number
}

// ---------------------------------------------------------------------------
// App info
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
  /** Files finished and waiting for a decision or for auto mode to act. */
  waiting: number
  needsAttention: number
  recent: FileOperation[]
  monitoring: MonitoringStatus
  /** Set at startup when an interrupted move had to be resolved. */
  recovery: RecoverySummary | null
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export type RecoveryOutcome = 'completed' | 'failed' | 'needs_review'

export interface RecoveryItem {
  operationId: string
  fileName: string
  sourcePath: string
  destPath: string
  outcome: RecoveryOutcome
  /** Plain-English account of what was found and what was done. */
  note: string
}

export interface RecoverySummary {
  ranAt: string
  /** Unfinished operations found in the journal. */
  checked: number
  recovered: number
  failed: number
  needsReview: number
  items: RecoveryItem[]
}

// ---------------------------------------------------------------------------
// Folder grants (picker results)
// ---------------------------------------------------------------------------

export interface FolderGrant {
  grantId: string
  displayName: string
}

export type FolderPickPurpose = 'monitor' | 'destination' | 'index'

// ---------------------------------------------------------------------------
// Local file index & search
// ---------------------------------------------------------------------------

export type SearchSort = 'name' | 'modified' | 'size' | 'relevance'
export type SortOrder = 'asc' | 'desc'

/**
 * A search over the local metadata index.
 *
 * This is an explicit filter model, not a natural-language parser: every
 * field maps to a query the index can answer directly. The renderer sends
 * these fields; the main process turns them into a parameterised statement.
 */
export interface SearchQuery {
  /** Filename text. Matched as a substring, or as a fuzzy subsequence. */
  text?: string
  /** When true, `text` may match out of order (e.g. "rpt" in "report.pdf"). */
  fuzzy?: boolean
  /** Extensions without a dot, lowercase. */
  extensions?: string[]
  /** Only files inside this directory (and its subdirectories). */
  parentDir?: string
  sizeMin?: number | null
  sizeMax?: number | null
  /** Epoch milliseconds. */
  modifiedAfter?: number | null
  modifiedBefore?: number | null
  createdAfter?: number | null
  createdBefore?: number | null
  sort?: SearchSort
  order?: SortOrder
  limit?: number
  offset?: number
}

/** How much the index trusts its own record for this file. */
export type VerificationState = 'indexed' | 'hashed' | 'stale'

export interface IndexedFile {
  path: string
  parentDir: string
  name: string
  /** Lowercase, without the dot. Empty when the file has no extension. */
  ext: string
  sizeBytes: number
  modifiedMs: number
  createdMs: number
  /** Content hash, when it has been computed. */
  sha256: string | null
  verification: VerificationState
}

export interface SearchResultPage {
  items: IndexedFile[]
  /** Size of the whole filtered set, not of this page. */
  total: number
  tookMs: number
  /** True when the result set was capped rather than exhausted. */
  truncated: boolean
}

export type IndexPhase = 'idle' | 'scanning' | 'hashing' | 'rebuilding' | 'cancelling' | 'error'

export interface IndexStatus {
  phase: IndexPhase
  running: boolean
  scanned: number
  indexed: number
  skipped: number
  errors: number
  /** Root currently being walked. */
  currentRoot: string | null
  startedAt: string | null
  finishedAt: string | null
  message: string | null
  /** Total files known to the index. */
  totalIndexed: number
}

/**
 * What the indexer is allowed to touch.
 *
 * Everything here is opt-in: the index only ever reads metadata, and it never
 * writes to, moves or deletes a file.
 */
export interface IndexScope {
  /** Absolute directory paths to walk. */
  roots: string[]
  /** How deep to descend from each root. 0 = the root only. */
  maxDepth: number
  /** Absolute path prefixes that are never indexed. */
  excludedPaths: string[]
  /** Lowercase extensions (no dot) that are never indexed. */
  excludedExtensions: string[]
  /** Skip dotfiles and dot-directories. */
  excludeHidden: boolean
}

// ---------------------------------------------------------------------------
// Exact duplicate detection
// ---------------------------------------------------------------------------

export interface DuplicateGroup {
  /** SHA-256 shared by every copy. */
  hash: string
  sizeBytes: number
  copies: number
  /**
   * Bytes that could be reclaimed by keeping exactly one copy:
   * (copies - 1) * size. Conservative — it never counts a copy twice.
   */
  wastedBytes: number
  files: IndexedFile[]
  /** 'verified' when every copy was re-checked against the live file. */
  status: 'verified' | 'uncertain'
  /** Human-readable caveats, e.g. "one copy changed while it was being hashed". */
  notes: string[]
}

export interface DuplicateReport {
  groups: DuplicateGroup[]
  /** Files considered (same size, more than one copy). */
  candidateFiles: number
  /** Files actually hashed. */
  hashedFiles: number
  /** Files skipped because hashing failed or the file changed mid-scan. */
  unverifiableFiles: number
  tookMs: number
  /** True when the scan stopped early (cancelled or capped). */
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Rule recommendations
// ---------------------------------------------------------------------------

export type RecommendationStatus = 'pending' | 'accepted' | 'dismissed'

export interface RuleRecommendation {
  id: string
  /** Stable identity of the pattern, so a dismissed one stays dismissed. */
  fingerprint: string
  /** Rule that would be created. */
  name: string
  extensions: string[]
  namePattern: string | null
  /** Relative destination folder under the destination root. */
  destination: string
  /** Why MySort thinks this is worth suggesting. */
  evidence: string
  /** How many past moves support it. */
  occurrences: number
  /** Earliest and latest supporting move. */
  firstSeenAt: string
  lastSeenAt: string
  status: RecommendationStatus
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export type CollectionRuleKind = 'extension' | 'name_contains' | 'parent' | 'my_sort_rule'

export interface CollectionRule {
  kind: CollectionRuleKind
  value: string
}

export interface FileCollection {
  id: string
  name: string
  description: string
  /** Rule-based membership. */
  rules: CollectionRule[]
  /** Files added by hand. */
  manualPaths: string[]
  createdAt: string
  updatedAt: string
}

export interface CollectionMember {
  path: string
  name: string
  ext: string
  sizeBytes: number
  modifiedMs: number
  /** Why the file is in the collection. */
  reason: string
  /** True when the file no longer exists on disk. */
  missing: boolean
  /** True when the file exists but was changed since it was indexed. */
  changed: boolean
}

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

  /** Local metadata index and search. */
  search: {
    query(input: SearchQuery): Promise<Result<SearchResultPage>>
    recent(limit?: number): Promise<Result<IndexedFile[]>>
    scope(): Promise<Result<IndexScope>>
    setScope(input: { scope: IndexScope }): Promise<Result<IndexScope>>
    status(): Promise<Result<IndexStatus>>
    start(input?: { rebuild?: boolean }): Promise<Result<IndexStatus>>
    cancel(): Promise<Result<IndexStatus>>
    clear(): Promise<Result<IndexStatus>>
    /** Opens the file with its default application. */
    open(input: { path: string }): Promise<Result<null>>
    /** Reveals the file in its containing folder. */
    reveal(input: { path: string }): Promise<Result<null>>
    /** Opens the folder that contains the file. */
    openFolder(input: { path: string }): Promise<Result<null>>
  }

  /** Exact duplicate detection. */
  duplicates: {
    scan(input?: { limit?: number }): Promise<Result<DuplicateReport>>
  }

  /** Suggested rules derived from repeated user-approved moves. */
  recommendations: {
    list(): Promise<Result<RuleRecommendation[]>>
    dismiss(input: { id: string }): Promise<Result<RuleRecommendation[]>>
    accept(input: { id: string }): Promise<Result<FileRule>>
    /** Files that would match a candidate recommendation. */
    preview(input: { id: string }): Promise<Result<SearchResultPage>>
    /** Detects patterns from the operation history. */
    detect(): Promise<Result<RuleRecommendation[]>>
  }

  /** Virtual collections: references to files, never copies. */
  collections: {
    list(): Promise<Result<FileCollection[]>>
    create(input: { name: string; description?: string }): Promise<Result<FileCollection>>
    remove(input: { id: string }): Promise<Result<null>>
    setRules(input: { id: string; rules: CollectionRule[] }): Promise<Result<FileCollection>>
    addMember(input: { id: string; path: string }): Promise<Result<FileCollection>>
    removeMember(input: { id: string; path: string }): Promise<Result<FileCollection>>
    members(input: { id: string }): Promise<Result<CollectionMember[]>>
  }

  /** The review inbox: a read-only plan of what MySort would do next. */
  inbox: {
    plan(input: { folderId: number }): Promise<Result<OrganizationPlan>>
    apply(input: { planId: string; itemIds: string[] }): Promise<Result<PreviewApplyResult>>
  }

  onMonitoringStatus(cb: (s: MonitoringStatus) => void): Unsubscribe
  onOperationUpdated(cb: (op: FileOperation) => void): Unsubscribe
  onRulesChanged(cb: (rules: FileRule[]) => void): Unsubscribe
  onSettingsChanged(cb: (s: ApplicationSettings) => void): Unsubscribe
  onIndexStatus(cb: (s: IndexStatus) => void): Unsubscribe
}

export interface SettingsPatch {
  startWithWindows?: boolean
  closeButtonBehavior?: CloseButtonBehavior
  resumeMonitoringOnLaunch?: boolean
  notifications?: NotificationPreference
  previewBeforeAuto?: boolean
  sortFolders?: boolean
  historyRetentionDays?: number
  undoWindowDays?: number
  logLevel?: LogLevel
  onboardingCompleted?: boolean
  recommendationThreshold?: number
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
  indexStatus: 'index:status',
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

  // Local search and the metadata index.
  searchQuery: 'search:query',
  searchRecent: 'search:recent',
  searchScope: 'search:scope',
  searchSetScope: 'search:setScope',
  searchStatus: 'search:status',
  searchStart: 'search:start',
  searchCancel: 'search:cancel',
  searchClear: 'search:clear',
  searchOpen: 'search:open',
  searchReveal: 'search:reveal',
  searchOpenFolder: 'search:openFolder',

  // Exact duplicate detection.
  duplicatesScan: 'duplicates:scan',

  // Rule recommendations.
  recommendationsList: 'recommendations:list',
  recommendationsDismiss: 'recommendations:dismiss',
  recommendationsAccept: 'recommendations:accept',
  recommendationsPreview: 'recommendations:preview',
  recommendationsDetect: 'recommendations:detect',

  // Virtual collections.
  collectionsList: 'collections:list',
  collectionsCreate: 'collections:create',
  collectionsRemove: 'collections:remove',
  collectionsSetRules: 'collections:setRules',
  collectionsAddMember: 'collections:addMember',
  collectionsRemoveMember: 'collections:removeMember',
  collectionsMembers: 'collections:members',

  // The review inbox.
  inboxPlan: 'inbox:plan',
  inboxApply: 'inbox:apply',
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]

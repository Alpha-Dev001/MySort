/**
 * Presentation-only formatters.
 *
 * Every value the UI shows about a file, a move or a timestamp goes through
 * here, so nothing in the renderer has to invent a placeholder string.
 */

import type { MonitoringState, OperationStatus, RuleExplanationOutcome, UndoStatus } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${UNITS[unit]}`
}

/** Last path segment, for both separators, without pulling in `node:path`. */
export function baseName(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/** Parent directory of a path, or '' when there is none. */
export function dirName(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut <= 0 ? '' : trimmed.slice(0, cut)
}

/**
 * Middle-truncates a long path so both the root and the file name stay
 * readable. Paths are the densest strings in this UI; eliding the middle is
 * the only way to keep them legible in a fixed-width column.
 */
export function shortenPath(filePath: string, max = 52): string {
  if (filePath.length <= max) return filePath
  const name = baseName(filePath)
  const head = filePath.slice(0, filePath.length - name.length)
  if (head.length <= max - name.length - 1) return filePath
  const keep = Math.max(4, max - name.length - 1)
  return `${head.slice(0, keep)}…${name}`
}

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(dot).toLowerCase() : ''
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "just now" / "4 min ago" / "3 hr ago" / "2 days ago" / a real date.
 *
 * Accepts an ISO string or an epoch-millisecond number — the local index
 * stores timestamps as numbers, the history store as ISO strings.
 */
export function formatRelative(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  const then = typeof iso === 'number' ? iso : Date.parse(iso)
  if (Number.isNaN(then)) return '—'
  const delta = now - then
  if (delta < 0) return 'just now'
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} min ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)} hr ago`
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)} day${Math.floor(delta / DAY) === 1 ? '' : 's'} ago`
  return formatDate(then)
}

type DateLike = string | number | Date | null | undefined

export function formatDate(value: DateLike): string {
  if (value === null || value === undefined) return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  return sameDay
    ? `Today, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatDateTime(value: DateLike): string {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return `${formatDate(d)}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

/** Inclusive day range as ISO instants, for history filtering. */
export function dayRange(days: number, now = Date.now()): { from: string; to: string } {
  const to = new Date(now)
  const from = new Date(now - days * DAY)
  from.setHours(0, 0, 0, 0)
  to.setHours(23, 59, 59, 999)
  return { from: from.toISOString(), to: to.toISOString() }
}

// ---------------------------------------------------------------------------
// Domain labels
// ---------------------------------------------------------------------------

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand'

const OPERATION_LABELS: Record<OperationStatus, string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  needs_review: 'Needs review',
}

const OPERATION_TONES: Record<OperationStatus, Tone> = {
  planned: 'neutral',
  in_progress: 'info',
  completed: 'success',
  failed: 'danger',
  skipped: 'neutral',
  needs_review: 'warning',
}

export function operationLabel(status: OperationStatus): string {
  return OPERATION_LABELS[status] ?? status
}

export function operationTone(status: OperationStatus): Tone {
  return OPERATION_TONES[status] ?? 'neutral'
}

const MONITORING_LABELS: Record<MonitoringState, string> = {
  stopped: 'Monitoring is off',
  starting: 'Starting up…',
  running: 'Monitoring is active',
  paused: 'Monitoring is paused',
  error: 'Monitoring hit an error',
  folder_unavailable: 'The watched folder is unavailable',
}

const MONITORING_TONES: Record<MonitoringState, Tone> = {
  stopped: 'neutral',
  starting: 'info',
  running: 'success',
  paused: 'warning',
  error: 'danger',
  folder_unavailable: 'danger',
}

export function monitoringLabel(state: MonitoringState): string {
  return MONITORING_LABELS[state] ?? state
}

/** Short forms for the page-header pill, where the full sentences are too long. */
const MONITORING_SHORT_LABELS: Record<MonitoringState, string> = {
  stopped: 'Monitoring off',
  starting: 'Starting up…',
  running: 'Monitoring active',
  paused: 'Monitoring paused',
  error: 'Monitoring error',
  folder_unavailable: 'Folder unavailable',
}

export function monitoringShortLabel(state: MonitoringState): string {
  return MONITORING_SHORT_LABELS[state] ?? state
}

export function monitoringTone(state: MonitoringState): Tone {
  return MONITORING_TONES[state] ?? 'neutral'
}

const FOLDER_STATE_LABELS: Record<string, string> = {
  watching: 'Watching',
  unavailable: 'Unavailable',
  error: 'Error',
  paused: 'Paused',
}

export function folderStateLabel(state: string): string {
  return FOLDER_STATE_LABELS[state] ?? state
}

export function folderStateTone(state: string): Tone {
  if (state === 'watching') return 'success'
  if (state === 'paused') return 'warning'
  if (state === 'unavailable' || state === 'error') return 'danger'
  return 'neutral'
}

export function modeLabel(mode: 'manual' | 'auto'): string {
  return mode === 'auto' ? 'Automatic' : 'Manual'
}

const EXPLANATION_LABELS: Record<RuleExplanationOutcome, string> = {
  custom: 'Matched a rule',
  default: 'Matched a built-in default',
  no_action: 'No rule applies — left in place',
  error: 'Could not be resolved',
}

export function explanationLabel(outcome: RuleExplanationOutcome): string {
  return EXPLANATION_LABELS[outcome] ?? outcome
}

export function explanationTone(outcome: RuleExplanationOutcome): Tone {
  if (outcome === 'custom') return 'brand'
  if (outcome === 'default') return 'info'
  if (outcome === 'no_action') return 'neutral'
  return 'danger'
}

const UNDO_LABELS: Record<UndoStatus, string> = {
  not_eligible: 'Cannot be undone',
  available: 'Undo available',
  done: 'Undone',
  blocked: 'Undo blocked',
  expired: 'Undo window expired',
}

export function undoLabel(status: UndoStatus): string {
  return UNDO_LABELS[status] ?? status
}

export function canUndo(status: UndoStatus): boolean {
  return status === 'available'
}

const PLAN_WARNING_LABELS: Record<string, string> = {
  NAME_CONFLICT_WILL_RENAME: 'A file with this name already exists — it will be renamed on arrival',
  CROSS_VOLUME: 'Destination is on a different drive, so the file will be copied',
  DEST_FOLDER_WILL_BE_CREATED: 'The destination folder does not exist yet and will be created',
}

export function planWarningLabel(code: string): string {
  return PLAN_WARNING_LABELS[code] ?? code
}

const SKIP_REASON_LABELS: Record<string, string> = {
  EXCLUDED: 'Skipped by a rule',
  TEMP_FILE: 'Still a temporary download',
  NOT_READY: 'Not finished writing yet',
}

export function skipReasonLabel(reason: string): string {
  if (SKIP_REASON_LABELS[reason]) return SKIP_REASON_LABELS[reason]
  // ErrorCode values arrive in SCREAMING_SNAKE; sentence-case them for display.
  const words = reason.toLowerCase().split('_').filter(Boolean)
  if (!words.length) return reason
  const [first, ...rest] = words
  return first.charAt(0).toUpperCase() + first.slice(1) + (rest.length ? ` ${rest.join(' ')}` : '')
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural
}

/** 12345 -> "12,345" */
export function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n)
}
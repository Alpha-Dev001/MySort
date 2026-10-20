/**
 * Path validation and eligibility checks.
 *
 * Order of validation follows the design: structural checks first (null bytes,
 * device/UNC paths, ADS, reserved names, trailing dots, invalid characters),
 * then resolution against the real file system (symlinks/junctions), then
 * containment and deny-list checks. Pure logic takes injected facts; the
 * destination validator uses only the FsReader interface (no writes).
 */

import path from 'node:path'
import type { ErrorCode } from '../shared/errors'
import type { FileStat, FsReader } from './fs'

export type PathValidation =
  | { ok: true; path: string }
  | { ok: false; code: ErrorCode; message: string }

export const okPath = (p: string): PathValidation => ({ ok: true, path: p })
export const badPath = (code: ErrorCode, message: string): PathValidation => ({
  ok: false,
  code,
  message,
})

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------

const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

export function isReservedSegment(segment: string): boolean {
  const base = segment.split('.')[0].toLowerCase().trim()
  return RESERVED.has(base)
}

export function hasControlChars(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(s)
}

export function hasInvalidPathChars(s: string): boolean {
  return /[<>:"|?*]/.test(s) || hasControlChars(s)
}

/** Structural validation for an absolute destination path (no I/O). */
export function checkAbsoluteStructure(raw: string): PathValidation {
  if (raw.length === 0) return badPath('PATH_INVALID', 'path is empty')
  if (raw.length > 32000) return badPath('PATH_INVALID', 'path is too long')
  if (raw.includes('\u0000')) return badPath('PATH_INVALID', 'path contains a null byte')
  if (raw.startsWith('\\\\.\\') || raw.startsWith('\\\\?\\') || raw.startsWith('//./') || raw.startsWith('//?/')) {
    return badPath('PATH_INVALID', 'device and extended paths are not allowed')
  }
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    return badPath('PATH_INVALID', 'network (UNC) paths are not allowed')
  }
  if (!path.isAbsolute(raw)) return badPath('PATH_INVALID', 'path must be absolute')

  // Alternate data streams: more than one colon (drive letter counts once).
  const colons = (raw.match(/:/g) ?? []).length
  if (colons > 1) return badPath('PATH_INVALID', 'alternate data streams are not allowed')

  const rest = raw.replace(/^[A-Za-z]:/, '') // drive letter is not a segment
  const segments = rest.split(/[\\/]+/).filter((s) => s.length > 0)
  for (const seg of segments) {
    if (isReservedSegment(seg)) return badPath('PATH_INVALID', `"${seg}" is a reserved device name`)
    if (/[ .]$/.test(seg)) return badPath('PATH_INVALID', 'segments must not end with a dot or space')
    if (hasInvalidPathChars(seg)) return badPath('PATH_INVALID', 'path contains invalid characters')
  }
  return okPath(raw)
}

/** Structural validation for a destination relative to the destination root. */
export function checkRelativeStructure(raw: string): PathValidation {
  if (raw.length === 0) return badPath('PATH_INVALID', 'destination is empty')
  if (raw.length > 200) return badPath('PATH_INVALID', 'destination is too long')
  if (raw.includes('\u0000')) return badPath('PATH_INVALID', 'destination contains a null byte')
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    return badPath('PATH_INVALID', 'a relative destination must not start with a separator')
  }
  if (/^[A-Za-z]:/.test(raw)) return badPath('PATH_INVALID', 'a relative destination must not contain a drive letter')
  const segments = raw.split(/[\\/]/)
  if (segments.some((s) => s === '..' || s === '.')) {
    return badPath('PATH_INVALID', 'a relative destination must not contain "." or ".."')
  }
  for (const seg of segments) {
    if (seg.length === 0) continue
    if (isReservedSegment(seg)) return badPath('PATH_INVALID', `"${seg}" is a reserved device name`)
    if (/[ .]$/.test(seg)) return badPath('PATH_INVALID', 'segments must not end with a dot or space')
    if (hasInvalidPathChars(seg)) return badPath('PATH_INVALID', 'path contains invalid characters')
  }
  return okPath(raw)
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function normalizePath(p: string): string {
  const resolved = path.normalize(p)
  // Strip trailing separators (but keep drive roots like "C:\").
  if (resolved.length > 1 && /[\\/]$/.test(resolved) && !/^[A-Za-z]:[\\/]$/.test(resolved)) {
    return resolved.replace(/[\\/]+$/, '')
  }
  return resolved
}

/** Case-insensitive, segment-wise containment. "Downloads2" is NOT inside "Downloads". */
export function isInside(child: string, parent: string): boolean {
  const c = normalizePath(child).toLowerCase()
  const p = normalizePath(parent).toLowerCase()
  if (c === p) return false
  const pWithSep = p.endsWith(path.sep) ? p : p + path.sep
  return c.startsWith(pWithSep)
}

export function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase()
}

export function sameVolume(a: string, b: string): boolean {
  return path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase()
}

// ---------------------------------------------------------------------------
// Deny list, real-path resolution, destination validation
// ---------------------------------------------------------------------------

export interface DenyPathInput {
  windowsDir?: string | undefined
  programFiles?: string | undefined
  programFilesX86?: string | undefined
  appData?: string | undefined
  localAppData?: string | undefined
  /** MySort's own user-data folder; never a destination. */
  userData?: string | undefined
  /** Windows + app Startup folders. */
  startupDirs?: string[]
}

/**
 * System locations, app data roots, and Startup folders.
 *
 * Two things are deliberately NOT listed:
 *
 * - Drive roots (`C:\` and friends). isDeniedPath matches with `isInside`,
 *   so a drive root entry denies every path on that drive and the whole deny
 *   list becomes a no-op that refuses to place anything anywhere.
 * - The bare user profile. MySort's own default destination root is
 *   `<Documents>/MySort`, which lives inside the profile; denying the profile
 *   denies the app's own default configuration. The genuinely sensitive parts
 *   of the profile (AppData, LocalAppData, and the app's user-data folder) are
 *   each listed individually below and stay protected.
 */
export function buildDefaultDenyPaths(input: DenyPathInput): string[] {
  const out: string[] = []
  const push = (p: string | undefined): void => {
    if (p && p.length > 0) out.push(normalizePath(p))
  }
  push(input.windowsDir)
  push(input.programFiles)
  push(input.programFilesX86)
  push(input.appData)
  push(input.localAppData)
  push(input.userData)
  for (const s of input.startupDirs ?? []) push(s)
  return [...new Set(out.map((p) => p.toLowerCase()))]
}

export function isDeniedPath(target: string, denyPaths: string[]): boolean {
  const t = normalizePath(target).toLowerCase()
  for (const d of denyPaths) {
    if (t === d || isInside(t, d)) return true
  }
  return false
}

/**
 * Real path of the deepest existing ancestor with the missing tail rejoined.
 * Follows symlinks and junctions so containment checks see the physical target.
 */
export async function resolveRealPath(reader: FsReader, target: string): Promise<string | null> {
  let current = normalizePath(target)
  const tail: string[] = []
  for (;;) {
    if (await reader.exists(current)) {
      const real = await reader.realpath(current)
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    tail.push(path.basename(current))
    current = parent
  }
}

export interface DestinationContext {
  reader: FsReader
  /** Absolute root that relative destinations resolve under. */
  destinationRoot: string
  /** Whether top-level folders are sorted into a "Folders" bucket. */
  sortFolders?: boolean
  /** Top-level names that are destination subfolders; never sort these as candidates. */
  destinationSubfolders?: string[]
  monitoredFolders: { id: number; path: string; enabled: boolean }[]
  /** The watched folder the file came from, when known (preview/executor). */
  sourceFolderId?: number | null
  sourceFolderPath?: string | null
  denyPaths: string[]
  /** Extra paths allowed even when they fall inside a monitored folder (undo). */
  allowPaths?: string[]
}

export async function validateDestination(
  kind: 'relative' | 'absolute',
  value: string,
  ctx: DestinationContext
): Promise<PathValidation> {
  const structural = kind === 'relative' ? checkRelativeStructure(value) : checkAbsoluteStructure(value)
  if (!structural.ok) return structural

  const absolute =
    kind === 'relative' ? path.resolve(ctx.destinationRoot, value.replace(/\//g, '\\')) : path.normalize(value)
  const structuralAbs = checkAbsoluteStructure(absolute)
  if (!structuralAbs.ok) return structuralAbs

  const root = path.parse(absolute).root
  if (!(await ctx.reader.exists(root))) {
    return badPath('DEST_UNAVAILABLE', `drive ${root.trim()} is not available`)
  }

  /**
   * The destination root must exist before a destination inside it passes.
   * Without this, moving a file after the user renamed the destination folder
   * would recreate the old folder tree from nothing. Rename tracking is what
   * updates the root; until it does, nothing may be written under the old one.
   */
  const rootNorm = normalizePath(ctx.destinationRoot)
  const absNorm = normalizePath(absolute)
  if ((pathsEqual(absNorm, rootNorm) || isInside(absNorm, rootNorm)) && !(await ctx.reader.exists(rootNorm))) {
    return badPath('DEST_UNAVAILABLE', 'the destination folder is currently not available')
  }

  const real = await resolveRealPath(ctx.reader, absolute)
  if (real === null) return badPath('PATH_INVALID', 'no existing ancestor for this path')

  const allowed = (ctx.allowPaths ?? []).some((a) => pathsEqual(a, real) || isInside(real, a))
  if (!allowed && isDeniedPath(real, ctx.denyPaths)) {
    return badPath('PATH_DENIED', 'this location is protected and cannot be used as a destination')
  }

  // Monitored-folder checks (loop protection, layer 1 of 3).
  const srcId = ctx.sourceFolderId ?? null
  const srcPath = ctx.sourceFolderPath ?? null
  for (const mf of ctx.monitoredFolders) {
    if (!mf.enabled) continue
    const mfReal = (await resolveRealPath(ctx.reader, mf.path)) ?? mf.path
    if (pathsEqual(real, mf.path) || pathsEqual(real, mfReal)) {
      if (srcId !== null && mf.id === srcId) {
        return badPath('DEST_IS_SOURCE', 'the destination is the monitored folder itself')
      }
      if (allowed) continue
      return badPath('DEST_IS_SOURCE', 'the destination is a monitored folder')
    }
    const isOther = srcId === null || mf.id !== srcId
    if (isOther && !allowed && (isInside(real, mf.path) || isInside(real, mfReal))) {
      return badPath('DEST_LOOP', 'the destination is inside another monitored folder')
    }
  }

  // Moving a file into its own source folder is a no-op (subfolders are fine).
  if (srcPath && (pathsEqual(real, srcPath) || pathsEqual(real, (await resolveRealPath(ctx.reader, srcPath)) ?? srcPath))) {
    return badPath('DEST_IS_SOURCE', 'the destination is the source folder')
  }

  return okPath(absolute)
}

// ---------------------------------------------------------------------------
// Eligibility (what may be moved at all)
// ---------------------------------------------------------------------------

export const TEMP_DOWNLOAD_SUFFIXES = [
  '.crdownload', '.part', '.partial', '.download', '.tmp',
  '.opdownload', '.!ut', '.aria2', '.crswap',
] as const

const ALWAYS_EXCLUDED_NAMES = new Set(['desktop.ini', 'thumbs.db'])

export type SkipReason =
  | 'DIRECTORY'
  | 'SYMLINK'
  | 'EXCLUDED'
  | 'TEMP_FILE'
  | 'HIDDEN'
  | 'ZERO_SIZE'
  | 'NOT_FILE'

export type Eligibility = { eligible: true } | { eligible: false; reason: SkipReason }

/** Cheap, name-only eligibility (no I/O). Covers temp downloads and junk names. */
export function checkNameEligibility(fileName: string): Eligibility {
  const lower = fileName.toLowerCase()
  if (lower.startsWith('~$')) return { eligible: false, reason: 'EXCLUDED' }
  if (lower.startsWith('.')) return { eligible: false, reason: 'EXCLUDED' }
  if (ALWAYS_EXCLUDED_NAMES.has(lower)) return { eligible: false, reason: 'EXCLUDED' }
  for (const suffix of TEMP_DOWNLOAD_SUFFIXES) {
    if (lower.endsWith(suffix)) return { eligible: false, reason: 'TEMP_FILE' }
  }
  return { eligible: true }
}

const DANGEROUS_DIR_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  '$recycle.bin', 'system volume information',
])

/** Names that must never be auto-sorted as folders (system/app folders). */
export function isDangerousDirName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.startsWith('.')) return true
  return DANGEROUS_DIR_NAMES.has(lower)
}

export function checkStatEligibility(stat: FileStat): Eligibility {
  if (stat.isSymlink) return { eligible: false, reason: 'SYMLINK' }
  if (stat.isDirectory) return { eligible: true }
  if (!stat.isFile) return { eligible: false, reason: 'NOT_FILE' }
  if (stat.size === 0) return { eligible: false, reason: 'ZERO_SIZE' }
  return { eligible: true }
}

/**
 * Destination-name sanitizer: strips control characters and bidi overrides,
 * and rescues reserved device names. Keeps the file recognizable.
 */
export function sanitizeDestName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let out = name.replace(/[\u0000-\u001f\u007f]/g, '')
  out = out.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
  if (out.length === 0) out = 'file'
  if (isReservedSegment(out)) out = `_${out}`
  return out
}

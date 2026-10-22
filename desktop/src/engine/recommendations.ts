/**
 * Rule recommendations: finding repeated, deliberate organisation.
 *
 * The detection is deterministic and explainable: it looks at completed moves
 * that already happened, groups them by file type and destination, and only
 * reports a group when the same choice has been made often enough.
 *
 * A detected pattern is a *suggestion*. It is never turned into a rule
 * without the user asking for it.
 */

import { createHash } from 'node:crypto'
import { extensionOf } from './indexer'

/** One completed move, reduced to what the pattern detector needs. */
export interface MoveSample {
  fileName: string
  /** The extension the file was moved by (lowercase, no dot). */
  extension: string
  /** Destination folder, relative to the destination root. */
  destination: string
  finishedAt: string
  /** 'manual' when the user approved it, 'auto' when MySort did it. */
  initiatedBy: 'manual' | 'auto' | 'other'
}

export interface DetectedPattern {
  /** Stable identity of the pattern, so a dismissed one stays dismissed. */
  fingerprint: string
  extensions: string[]
  destination: string
  occurrences: number
  firstSeenAt: string
  lastSeenAt: string
  /** How many of the moves the user approved by hand. */
  manualOccurrences: number
  /** A few example file names, for the evidence line. */
  examples: string[]
  /** Suggested rule name. */
  name: string
}

export const DEFAULT_RECOMMENDATION_THRESHOLD = 3

/** A stable identity for "these extensions into this folder". */
export function fingerprintFor(extensions: string[], destination: string): string {
  const canonical = `${[...extensions].sort().join(',')}::${destination.toLowerCase()}`
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24)
}

/** A readable rule name for a detected group. */
export function suggestName(extensions: string[], destination: string): string {
  const folder = destination.split(/[\\/]/).filter(Boolean).pop() ?? destination
  if (extensions.length === 1) return `${extensions[0].toUpperCase()} files`
  if (extensions.length <= 3) return `${extensions.map((e) => e.toUpperCase()).join(', ')} files`
  return `${folder} files`
}

/**
 * Groups moves into patterns.
 *
 * Only groups at or above `threshold` occurrences are returned, and the
 * result is ordered by how often the pattern occurred.
 */
export function detectPatterns(
  samples: MoveSample[],
  threshold = DEFAULT_RECOMMENDATION_THRESHOLD
): DetectedPattern[] {
  const groups = new Map<string, MoveSample[]>()
  for (const sample of samples) {
    if (sample.extension.length === 0) continue
    if (sample.destination.length === 0) continue
    const key = `${sample.extension}::${sample.destination.toLowerCase()}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(sample)
    else groups.set(key, [sample])
  }

  const patterns: DetectedPattern[] = []
  for (const bucket of groups.values()) {
    if (bucket.length < threshold) continue
    const sorted = [...bucket].sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
    const extensions = [...new Set(sorted.map((s) => s.extension))].sort()
    const destination = sorted[0].destination
    patterns.push({
      fingerprint: fingerprintFor(extensions, destination),
      extensions,
      destination,
      occurrences: sorted.length,
      manualOccurrences: sorted.filter((s) => s.initiatedBy === 'manual').length,
      firstSeenAt: sorted[0].finishedAt,
      lastSeenAt: sorted[sorted.length - 1].finishedAt,
      examples: sorted.slice(-3).map((s) => s.fileName),
      name: suggestName(extensions, destination),
    })
  }

  patterns.sort((a, b) => b.occurrences - a.occurrences || a.fingerprint.localeCompare(b.fingerprint))
  return patterns
}

/**
 * A sentence explaining where the suggestion comes from.
 *
 * The wording states what was observed, never what MySort will do.
 */
export function describePattern(pattern: DetectedPattern): string {
  const exts = pattern.extensions.map((e) => `.${e}`).join(', ')
  const where =
    pattern.manualOccurrences > 0
      ? `${pattern.manualOccurrences} of them were moves you approved`
      : 'MySort moved them on your behalf'
  return `${pattern.occurrences} ${exts} file${pattern.occurrences === 1 ? '' : 's'} went to ${pattern.destination} — ${where}.`
}

/** Convenience for callers that only have file names. */
export function extensionOfSample(fileName: string): string {
  return extensionOf(fileName)
}

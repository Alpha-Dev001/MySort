/**
 * Exact duplicate detection.
 *
 * Detection is deliberately conservative:
 *
 * 1. Size is only a *candidate filter*. Files with different sizes are never
 *    duplicates, but files with the same size are only candidates.
 * 2. A candidate becomes a duplicate only when its SHA-256 content hash
 *    matches another candidate's hash. Equal names or equal sizes are never
 *    treated as proof.
 * 3. A hash is only trusted while the file still looks exactly as it did when
 *    it was hashed (same size *and* same modification time). A file that
 *    changed in between is reported as uncertain rather than as a duplicate.
 *
 * Nothing here deletes anything. The report is for the user to act on.
 */

import type { DuplicateGroup, IndexedFile, VerificationState } from '../shared/types'

export interface DuplicateCandidate {
  path: string
  name: string
  ext: string
  sizeBytes: number
  modifiedMs: number
  createdMs: number
  sha256: string | null
  /** Size of the file when it was hashed. */
  hashedSize: number | null
  /** Modification time of the file when it was hashed. */
  hashedMtime: number | null
}

/** Is the cached hash still provably valid for this file? */
export function isHashStillValid(row: DuplicateCandidate): boolean {
  if (!row.sha256) return false
  if (row.hashedSize === null || row.hashedMtime === null) return false
  return row.hashedSize === row.sizeBytes && row.hashedMtime === row.modifiedMs
}

export function verificationState(row: DuplicateCandidate): VerificationState {
  if (!row.sha256) return 'indexed'
  return isHashStillValid(row) ? 'hashed' : 'stale'
}

export function toIndexedFile(row: DuplicateCandidate): IndexedFile {
  return {
    path: row.path,
    parentDir: '',
    name: row.name,
    ext: row.ext,
    sizeBytes: row.sizeBytes,
    modifiedMs: row.modifiedMs,
    createdMs: row.createdMs,
    sha256: row.sha256,
    verification: verificationState(row),
  }
}

/**
 * Groups rows by size and keeps only the sizes that have more than one file.
 *
 * This is the candidate filter — it is cheap and it never decides anything.
 */
export function groupCandidatesBySize(rows: DuplicateCandidate[]): Map<number, DuplicateCandidate[]> {
  const bySize = new Map<number, DuplicateCandidate[]>()
  for (const row of rows) {
    // A zero-byte file is not a meaningful duplicate candidate: every
    // zero-byte file has the same "content", which would report nonsense.
    if (row.sizeBytes <= 0) continue
    const bucket = bySize.get(row.sizeBytes)
    if (bucket) bucket.push(row)
    else bySize.set(row.sizeBytes, [row])
  }
  for (const [size, bucket] of bySize) {
    if (bucket.length < 2) bySize.delete(size)
  }
  return bySize
}

/**
 * Bytes that could be reclaimed by keeping exactly one copy.
 *
 * Conservative: it never counts the same byte twice and it never assumes a
 * copy may be removed without the user choosing to.
 */
export function conservativeWastedBytes(sizeBytes: number, copies: number): number {
  if (sizeBytes <= 0 || copies < 2) return 0
  return sizeBytes * (copies - 1)
}

/**
 * Builds the duplicate groups from hashed candidates.
 *
 * Only rows whose hash is still valid are used to form a group. A row whose
 * file changed after hashing is reported separately as uncertain.
 */
export function buildDuplicateGroups(rows: DuplicateCandidate[]): {
  groups: DuplicateGroup[]
  uncertainRows: DuplicateCandidate[]
} {
  const valid: DuplicateCandidate[] = []
  const uncertainRows: DuplicateCandidate[] = []

  for (const row of rows) {
    if (!row.sha256) continue
    if (isHashStillValid(row)) valid.push(row)
    else uncertainRows.push(row)
  }

  const byHash = new Map<string, DuplicateCandidate[]>()
  for (const row of valid) {
    const bucket = byHash.get(row.sha256 as string)
    if (bucket) bucket.push(row)
    else byHash.set(row.sha256 as string, [row])
  }

  const groups: DuplicateGroup[] = []
  for (const [hash, bucket] of byHash) {
    if (bucket.length < 2) continue
    const sizeBytes = bucket[0].sizeBytes
    // Guard against a hash collision producing a mixed-size group.
    if (bucket.some((r) => r.sizeBytes !== sizeBytes)) continue
    groups.push({
      hash,
      sizeBytes,
      copies: bucket.length,
      wastedBytes: conservativeWastedBytes(sizeBytes, bucket.length),
      files: bucket.map(toIndexedFile),
      status: 'verified',
      notes: [],
    })
  }

  // Largest reclaimable space first — that is what the user cares about.
  groups.sort((a, b) => b.wastedBytes - a.wastedBytes || a.hash.localeCompare(b.hash))

  return { groups, uncertainRows }
}

export interface HashJobOptions {
  /** Computes the hash of one file. Returning null means "could not hash". */
  hash: (path: string) => Promise<string | null>
  /** How many files may be hashed at the same time. */
  concurrency?: number
  token?: { cancelled: boolean }
  onProgress?: (done: number, total: number, path: string) => void
  /** Called for every file, with the hash that was computed (or null). */
  onResult?: (path: string, hash: string | null) => void
}

export interface HashJobResult {
  hashed: number
  failed: number
  cancelled: boolean
}

/**
 * Hashes a list of candidates with a bounded number of parallel workers.
 *
 * The work happens off the renderer's thread entirely — this runs in the main
 * process and never blocks the UI.
 */
export async function hashCandidates(
  paths: string[],
  options: HashJobOptions
): Promise<HashJobResult> {
  const concurrency = Math.max(options.concurrency ?? 2, 1)
  const token = options.token
  let hashed = 0
  let failed = 0
  let cancelled = false
  let done = 0

  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (token?.cancelled) {
        cancelled = true
        return
      }
      const index = cursor++
      if (index >= paths.length) return
      const filePath = paths[index]
      let hash: string | null
      try {
        hash = await options.hash(filePath)
      } catch {
        hash = null
      }
      if (hash) hashed++
      else failed++
      done++
      options.onResult?.(filePath, hash)
      options.onProgress?.(done, paths.length, filePath)
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(concurrency, paths.length); i++) {
    workers.push(worker())
  }
  await Promise.all(workers)

  return { hashed, failed, cancelled }
}

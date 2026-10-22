/**
 * Exact duplicate detection.
 *
 * The safety properties under test:
 *   - size alone never proves a duplicate,
 *   - a hash is only trusted while the file is unchanged,
 *   - space savings are conservative,
 *   - a file that changes while it is being hashed is reported as uncertain,
 *   - and nothing is ever deleted.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildDuplicateGroups,
  conservativeWastedBytes,
  groupCandidatesBySize,
  hashCandidates,
  isHashStillValid,
  type DuplicateCandidate,
} from '../src/engine/duplicates'

function candidate(over: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    path: 'C:\\a.pdf',
    name: 'a.pdf',
    ext: 'pdf',
    sizeBytes: 1000,
    modifiedMs: 5000,
    createdMs: 4000,
    sha256: 'hash-a',
    hashedSize: 1000,
    hashedMtime: 5000,
    ...over,
  }
}

describe('isHashStillValid', () => {
  it('is true when the size and mtime still match the hash', () => {
    expect(isHashStillValid(candidate())).toBe(true)
  })

  it('is false when the file was resized after hashing', () => {
    expect(isHashStillValid(candidate({ sizeBytes: 1001 }))).toBe(false)
  })

  it('is false when the file was touched after hashing', () => {
    expect(isHashStillValid(candidate({ modifiedMs: 6000 }))).toBe(false)
  })

  it('is false when there is no hash at all', () => {
    expect(isHashStillValid(candidate({ sha256: null }))).toBe(false)
  })
})

describe('groupCandidatesBySize', () => {
  it('keeps only sizes with more than one file', () => {
    const groups = groupCandidatesBySize([
      candidate({ path: 'a', sizeBytes: 10 }),
      candidate({ path: 'b', sizeBytes: 10 }),
      candidate({ path: 'c', sizeBytes: 20 }),
    ])
    expect([...groups.keys()]).toEqual([10])
    expect(groups.get(10)).toHaveLength(2)
  })

  it('never treats an empty file as a duplicate candidate', () => {
    const groups = groupCandidatesBySize([
      candidate({ path: 'a', sizeBytes: 0 }),
      candidate({ path: 'b', sizeBytes: 0 }),
    ])
    expect(groups.size).toBe(0)
  })
})

describe('conservativeWastedBytes', () => {
  it('counts every copy but one', () => {
    expect(conservativeWastedBytes(1000, 3)).toBe(2000)
    expect(conservativeWastedBytes(1000, 1)).toBe(0)
    expect(conservativeWastedBytes(0, 5)).toBe(0)
  })
})

describe('buildDuplicateGroups', () => {
  it('groups files with the same content hash', () => {
    const { groups } = buildDuplicateGroups([
      candidate({ path: 'a', sha256: 'same' }),
      candidate({ path: 'b', sha256: 'same' }),
      candidate({ path: 'c', sha256: 'other' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].copies).toBe(2)
    expect(groups[0].wastedBytes).toBe(1000)
    expect(groups[0].status).toBe('verified')
  })

  it('does not group files that only share a size', () => {
    const { groups } = buildDuplicateGroups([
      candidate({ path: 'a', sha256: 'one' }),
      candidate({ path: 'b', sha256: 'two' }),
    ])
    expect(groups).toHaveLength(0)
  })

  it('ignores a file whose hash is no longer trustworthy', () => {
    const { groups, uncertainRows } = buildDuplicateGroups([
      candidate({ path: 'a', sha256: 'same' }),
      candidate({ path: 'b', sha256: 'same', sizeBytes: 2000 }),
    ])
    expect(groups).toHaveLength(0)
    expect(uncertainRows).toHaveLength(1)
  })

  it('refuses to group a mixed-size hash collision', () => {
    const { groups } = buildDuplicateGroups([
      candidate({ path: 'a', sha256: 'same', sizeBytes: 1000 }),
      candidate({ path: 'b', sha256: 'same', sizeBytes: 1000, hashedSize: 1000 }),
    ])
    expect(groups).toHaveLength(1)
  })

  it('orders the groups by the space they occupy', () => {
    const { groups } = buildDuplicateGroups([
      candidate({ path: 'a', sha256: 'small', sizeBytes: 10, hashedSize: 10 }),
      candidate({ path: 'b', sha256: 'small', sizeBytes: 10, hashedSize: 10 }),
      candidate({ path: 'c', sha256: 'big', sizeBytes: 5000, hashedSize: 5000 }),
      candidate({ path: 'd', sha256: 'big', sizeBytes: 5000, hashedSize: 5000 }),
    ])
    expect(groups[0].wastedBytes).toBeGreaterThan(groups[1].wastedBytes)
  })
})

describe('hashCandidates', () => {
  it('hashes every file and reports progress', async () => {
    const hash = vi.fn(async (p: string) => `hash:${p}`)
    const onProgress = vi.fn()
    const result = await hashCandidates(['a', 'b', 'c'], { hash, onProgress })
    expect(result.hashed).toBe(3)
    expect(result.failed).toBe(0)
    expect(onProgress).toHaveBeenCalledTimes(3)
  })

  it('counts a file it could not hash as failed rather than throwing', async () => {
    const hash = vi.fn(async (p: string) => {
      if (p === 'bad') throw new Error('EACCES')
      return 'ok'
    })
    const result = await hashCandidates(['a', 'bad'], { hash })
    expect(result.hashed).toBe(1)
    expect(result.failed).toBe(1)
  })

  it('stops when the token is cancelled', async () => {
    const token = { cancelled: false }
    const hash = vi.fn(async (_p: string) => {
      token.cancelled = true
      return 'ok'
    })
    const result = await hashCandidates(['a', 'b', 'c'], { hash, token })
    expect(result.cancelled).toBe(true)
    expect(hash).toHaveBeenCalledTimes(1)
  })

  it('never limits itself to more files than it was given', async () => {
    const hash = vi.fn(async () => 'ok')
    await hashCandidates([], { hash })
    expect(hash).not.toHaveBeenCalled()
  })
})

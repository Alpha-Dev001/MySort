import { describe, expect, it } from 'vitest'
import { RenamePairer, inferOfflineRename, pathKey, snapshotNames } from '../src/engine/renameTracking'
import { validateDestination } from '../src/engine/pathSafety'
import type { DestinationContext } from '../src/engine/pathSafety'

describe('rename tracking: live pairing', () => {
  it('pairs a removal with a recent appearance of a differently named dir', () => {
    const pairer = new RenamePairer(5000)
    expect(pairer.noteAdded('C:\\P\\Beta', 1000)).toBeNull() // appears first
    const m = pairer.noteRemoved('C:\\P\\Alpha', 1100)
    expect(m).toEqual({ from: 'C:\\P\\Alpha', to: 'C:\\P\\Beta' })
  })

  it('pairs in the opposite arrival order', () => {
    const pairer = new RenamePairer(5000)
    expect(pairer.noteRemoved('C:\\P\\Alpha', 1000)).toBeNull()
    const m = pairer.noteAdded('C:\\P\\Beta', 1100)
    expect(m).toEqual({ from: 'C:\\P\\Alpha', to: 'C:\\P\\Beta' })
  })

  it('is case-insensitive on Windows', () => {
    const pairer = new RenamePairer(5000)
    pairer.noteRemoved('C:\\P\\Alpha', 1000)
    const m = pairer.noteAdded('C:\\p\\BETA', 1100)
    expect(m).not.toBeNull()
  })

  it('does not pair same-named removal and recreation', () => {
    const pairer = new RenamePairer(5000)
    pairer.noteRemoved('C:\\P\\Alpha', 1000)
    expect(pairer.noteAdded('C:\\P\\Alpha', 1100)).toBeNull()
  })

  it('does not pair events outside the window', () => {
    const pairer = new RenamePairer(100)
    pairer.noteRemoved('C:\\P\\Alpha', 0)
    expect(pairer.noteAdded('C:\\P\\Beta', 200)).toBeNull()
  })

  it('expires unpaired removals', () => {
    const pairer = new RenamePairer(100)
    pairer.noteRemoved('C:\\P\\Alpha', 0)
    expect(pairer.expire(200)).toContain('C:\\P\\Alpha')
  })

  it('does not report a paired removal as vanished', () => {
    const pairer = new RenamePairer(5000)
    pairer.noteRemoved('C:\\P\\Alpha', 0)
    pairer.noteAdded('C:\\P\\Beta', 10)
    expect(pairer.expire(5000)).not.toContain('C:\\P\\Alpha')
  })
})

describe('rename tracking: offline pairing', () => {
  it('reports ok when the watched folder is still present', () => {
    expect(inferOfflineRename('Alpha', ['Alpha', 'Beta'], ['Alpha', 'Beta'])).toEqual({ status: 'ok' })
  })

  it('follows a rename when exactly one dir disappeared and one appeared', () => {
    const res = inferOfflineRename('Alpha', ['Alpha', 'Beta'], ['Beta', 'Gamma'])
    expect(res).toEqual({ status: 'renamed', to: 'Gamma' })
  })

  it('returns unknown when there is no snapshot to evidence', () => {
    expect(inferOfflineRename('Alpha', null, ['Beta', 'Gamma'])).toEqual({ status: 'unknown' })
  })

  it('returns unknown when more than one dir changed', () => {
    const res = inferOfflineRename('Alpha', ['Alpha', 'Beta'], ['Gamma', 'Delta'])
    expect(res).toEqual({ status: 'unknown' })
  })

  it('reports ok when the watched folder is still present even if siblings changed', () => {
    expect(inferOfflineRename('Alpha', ['Alpha', 'Beta'], ['Alpha', 'Gamma'])).toEqual({ status: 'ok' })
  })

  it('snapshotNames sorts and de-duplicates', () => {
    expect(snapshotNames(['b', 'a', 'b'])).toEqual(['a', 'b'])
  })

  it('pathKey is case-insensitive and trims trailing separators', () => {
    expect(pathKey('C:\\Foo\\')).toBe(pathKey('c:\\foo'))
  })
})

// (removed unused helper)


describe('rename tracking: destination root guard', () => {
  it('rejects destinations inside a missing destination root', async () => {
    const root = 'C:\\nope\\MySort'
    const ctx: DestinationContext = {
      reader: {
        lstat: async () => ({ isFile: false, isDirectory: true, isSymlink: false, size: 0, mtimeMs: 0, birthtimeMs: 0 }),
        readdir: async () => [],
        realpath: async (p: string) => p,
        exists: async (p: string) => p === 'C:\\',
        mkdir: async () => undefined,
        link: async () => undefined,
        unlink: async () => undefined,
        renameNoReplace: async () => undefined,
        copyExclusive: async () => undefined,
      } as any,
      destinationRoot: root,
      monitoredFolders: [],
      sourceFolderId: null,
      sourceFolderPath: null,
      denyPaths: [],
      allowPaths: [],
    }
    const r = await validateDestination('relative', 'Images', ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('DEST_UNAVAILABLE')
  })

  it('allows destinations inside an existing destination root', async () => {
    const root = 'C:\\exists\\MySort'
    const ctx: DestinationContext = {
      reader: {
        lstat: async () => ({ isFile: false, isDirectory: true, isSymlink: false, size: 0, mtimeMs: 0, birthtimeMs: 0 }),
        readdir: async () => [],
        realpath: async (p: string) => p,
        exists: async (p: string) => p === 'C:\\' || p === root,
        mkdir: async () => undefined,
        link: async () => undefined,
        unlink: async () => undefined,
        renameNoReplace: async () => undefined,
        copyExclusive: async () => undefined,
      } as any,
      destinationRoot: root,
      monitoredFolders: [],
      sourceFolderId: null,
      sourceFolderPath: null,
      denyPaths: [],
      allowPaths: [],
    }
    const r = await validateDestination('relative', 'Images', ctx)
    expect(r.ok).toBe(true)
  })
})
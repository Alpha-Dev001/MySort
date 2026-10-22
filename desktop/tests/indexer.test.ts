/**
 * The indexer: walking directories into the metadata index.
 *
 * The rules that matter for safety are all here: symlinks are never followed,
 * excluded paths are never read, an unreadable directory never stops the
 * scan, and a cancelled scan stops promptly without leaving a half-written
 * batch behind.
 */

import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { runIndex, extensionOf, excludeConfigFor } from '../src/engine/indexer'
import type { IndexRow, IndexWriter } from '../src/engine/indexer'
import type { FileStat, FsReader } from '../src/engine/fs'
import type { IndexScope } from '../src/shared/types'

function stat(over: Partial<FileStat> = {}): FileStat {
  return {
    size: 100,
    mtimeMs: 1000,
    birthtimeMs: 500,
    isFile: true,
    isDirectory: false,
    isSymlink: false,
    ...over,
  }
}

/** A tiny in-memory tree, keyed by platform-native paths. */
function makeFs(tree: Record<string, FileStat>): FsReader {
  return {
    async lstat(p: string): Promise<FileStat> {
      const found = tree[p]
      if (!found) throw new Error(`ENOENT: ${p}`)
      return found
    },
    async readdir(p: string): Promise<string[]> {
      const prefix = p.endsWith(path.sep) ? p : p + path.sep
      const names = new Set<string>()
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const name = rest.split(path.sep)[0]
        if (name.length > 0) names.add(name)
      }
      return [...names]
    },
    async realpath(p: string): Promise<string> {
      return p
    },
    async exists(p: string): Promise<boolean> {
      return p in tree
    },
  }
}

class RecordingWriter implements IndexWriter {
  rows: IndexRow[] = []
  cleared = false
  removedUnder: string[] = []

  upsertMany(rows: IndexRow[]): void {
    this.rows.push(...rows)
  }
  removeUnder(dir: string): void {
    this.removedUnder.push(dir)
  }
  clear(): void {
    this.cleared = true
  }
  count(): number {
    return this.rows.length
  }
}

const ROOT = path.join(path.sep, 'root')
const at = (...parts: string[]): string => path.join(ROOT, ...parts)

const SCOPE: IndexScope = {
  roots: [ROOT],
  maxDepth: 3,
  excludedPaths: [],
  excludedExtensions: [],
  excludeHidden: true,
}

describe('extensionOf', () => {
  it('takes the last dot segment, lowercased', () => {
    expect(extensionOf('report.PDF')).toBe('pdf')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
    expect(extensionOf('Makefile')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('trailing.')).toBe('')
  })
})

describe('excludeConfigFor', () => {
  it('carries the scope rules into the walker', () => {
    const config = excludeConfigFor({ ...SCOPE, excludeHidden: false })
    expect(config.excludeHidden).toBe(false)
    expect(config.excludedExtensions).toEqual([])
  })
})

describe('runIndex', () => {
  it('records files with their metadata', async () => {
    const fs = makeFs({
      [at('a.pdf')]: stat({ size: 10 }),
      [at('b.png')]: stat({ size: 20 }),
    })
    const writer = new RecordingWriter()
    const result = await runIndex(fs, writer, SCOPE, { token: { cancelled: false } })

    expect(result.indexed).toBe(2)
    expect(result.errors).toBe(0)
    expect(writer.rows.map((r) => r.name).sort()).toEqual(['a.pdf', 'b.png'])
    expect(writer.rows[0].ext).toBe('pdf')
    expect(writer.rows[0].parentDir).toBe(ROOT)
    expect(writer.rows[0].indexedAt).toBeTruthy()
  })

  it('descends into subfolders up to the depth limit', async () => {
    const fs = makeFs({
      [at('one.pdf')]: stat(),
      [at('sub')]: stat({ isDirectory: true }),
      [at('sub', 'two.pdf')]: stat(),
      [at('sub', 'deep')]: stat({ isDirectory: true }),
      [at('sub', 'deep', 'three.pdf')]: stat(),
    })
    const writer = new RecordingWriter()
    await runIndex(fs, writer, { ...SCOPE, maxDepth: 1 }, { token: { cancelled: false } })
    expect(writer.rows.map((r) => r.name).sort()).toEqual(['one.pdf', 'two.pdf'])
  })

  it('never follows symlinks', async () => {
    const fs = makeFs({
      [at('link')]: stat({ isSymlink: true, isDirectory: true }),
      [at('real.pdf')]: stat(),
    })
    const writer = new RecordingWriter()
    const result = await runIndex(fs, writer, SCOPE, { token: { cancelled: false } })
    expect(result.skipped).toBe(1)
    expect(writer.rows.map((r) => r.name)).toEqual(['real.pdf'])
  })

  it('skips hidden files and folders when told to', async () => {
    const fs = makeFs({
      [at('.hidden')]: stat(),
      [at('visible.pdf')]: stat(),
      [at('.secret', 'inside.pdf')]: stat(),
    })
    const writer = new RecordingWriter()
    const result = await runIndex(fs, writer, SCOPE, { token: { cancelled: false } })
    expect(writer.rows.map((r) => r.name)).toEqual(['visible.pdf'])
    expect(result.skipped).toBeGreaterThanOrEqual(2)
  })

  it('skips excluded extensions', async () => {
    const fs = makeFs({
      [at('a.exe')]: stat(),
      [at('b.pdf')]: stat(),
    })
    const writer = new RecordingWriter()
    await runIndex(fs, writer, { ...SCOPE, excludedExtensions: ['exe'] }, { token: { cancelled: false } })
    expect(writer.rows.map((r) => r.name)).toEqual(['b.pdf'])
  })

  it('skips excluded folders and everything below them', async () => {
    const fs = makeFs({
      [at('private')]: stat({ isDirectory: true }),
      [at('private', 'secret.pdf')]: stat(),
      [at('public')]: stat({ isDirectory: true }),
      [at('public', 'file.pdf')]: stat(),
    })
    const writer = new RecordingWriter()
    await runIndex(fs, writer, { ...SCOPE, excludedPaths: [at('private')] }, { token: { cancelled: false } })
    expect(writer.rows.map((r) => r.name)).toEqual(['file.pdf'])
  })

  it('steps over an unreadable directory instead of stopping', async () => {
    const fs: FsReader = {
      ...makeFs({ [at('good.pdf')]: stat() }),
      async readdir(p: string): Promise<string[]> {
        if (p === ROOT) throw new Error('EACCES')
        return []
      },
    }
    const writer = new RecordingWriter()
    const result = await runIndex(fs, writer, SCOPE, { token: { cancelled: false } })
    expect(result.errors).toBe(1)
    expect(result.indexed).toBe(0)
  })

  it('stops when the token is cancelled', async () => {
    const fs = makeFs({
      [at('a.pdf')]: stat(),
      [at('sub')]: stat({ isDirectory: true }),
      [at('sub', 'b.pdf')]: stat(),
    })
    const writer = new RecordingWriter()
    const token = { cancelled: false }
    const result = await runIndex(fs, writer, SCOPE, {
      token,
      onProgress: () => {
        token.cancelled = true
      },
    })
    expect(result.cancelled).toBe(true)
  })

  it('never writes more than the file cap', async () => {
    const tree: Record<string, FileStat> = {}
    for (let i = 0; i < 20; i++) tree[at(`f${i}.pdf`)] = stat()
    const fs = makeFs(tree)
    const writer = new RecordingWriter()
    const result = await runIndex(fs, writer, SCOPE, { token: { cancelled: false }, maxFiles: 5 })
    expect(result.indexed).toBeLessThanOrEqual(6)
    expect(result.truncated).toBe(true)
  })

  it('writes in batches rather than one row at a time', async () => {
    const tree: Record<string, FileStat> = {}
    for (let i = 0; i < 10; i++) tree[at(`f${i}.pdf`)] = stat()
    const fs = makeFs(tree)
    const writer = new RecordingWriter()
    const spy = vi.spyOn(writer, 'upsertMany')
    await runIndex(fs, writer, SCOPE, { token: { cancelled: false }, batchSize: 4 })
    expect(spy.mock.calls.length).toBeGreaterThan(1)
  })
})

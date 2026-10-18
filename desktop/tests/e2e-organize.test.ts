/**
 * End-to-end engine integration: real files, real SQLite journal, real path
 * validation. Proves the plan -> execute pipeline actually places files, which
 * unit tests with mocked file systems cannot.
 */

import Database from 'better-sqlite3'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync as readText } from 'node:fs'
import { OperationsRepo } from '../src/db/repositories/operationsRepo'
import { buildPlan } from '../src/engine/planner'
import { executeOperation } from '../src/engine/executor'
import { buildDefaultDenyPaths, validateDestination } from '../src/engine/pathSafety'
import { resolveRule } from '../src/engine/rules'
import type { DestinationContext } from '../src/engine/pathSafety'
import type { RuleContext } from '../src/engine/rules'

const SCHEMA = readText(
  new URL('../src/db/migrations/0001_init.sql', import.meta.url),
  'utf8'
)

let root = ''
let downloads = ''
let destination = ''
let db: Database.Database
let ops: OperationsRepo

const DENY = buildDefaultDenyPaths({
  windowsDir: 'C:\\Windows',
  programFiles: 'C:\\Program Files',
  appData: 'C:\\Users\\Alex\\AppData\\Roaming',
  localAppData: 'C:\\Users\\Alex\\AppData\\Local',
  userData: 'C:\\Users\\Alex\\AppData\\Roaming\\MySort',
})

/** Built lazily: `destination` is only assigned in beforeEach. */
function ruleContext(): RuleContext {
  return {
    rules: [
      {
        id: 'r-img',
        name: 'Images',
        extensions: ['png', 'jpg'],
        namePattern: null,
        destination: { kind: 'relative', value: 'Pictures' },
        enabled: true,
        position: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    destinationRoot: destination,
    categoryDestinations: {},
  }
}

function destContext(sourceFolderId: number | null = 1): DestinationContext {
  return {
    reader: nodeFsLike(),
    destinationRoot: destination,
    monitoredFolders: [{ id: 1, path: downloads, enabled: true }],
    sourceFolderId,
    sourceFolderPath: downloads,
    denyPaths: DENY,
    allowPaths: [],
  }
}

/** Minimal FsWriter over real disk, matching the engine's interface. */
function nodeFsLike() {
  // Required lazily because this helper stands in for the engine's injected fs
  // port, and the test file is loaded before the module graph is resolved.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { promises: fsp } = require('node:fs') as typeof import('node:fs')
  const map = (s: import('node:fs').Stats) => ({
    size: s.size,
    mtimeMs: s.mtimeMs,
    birthtimeMs: s.birthtimeMs,
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymlink: s.isSymbolicLink(),
  })
  return {
    lstat: async (p: string) => map(await fsp.lstat(p)),
    readdir: (p: string) => fsp.readdir(p),
    realpath: (p: string) => fsp.realpath(p),
    exists: async (p: string) => {
      try {
        await fsp.access(p)
        return true
      } catch {
        return false
      }
    },
    mkdir: (p: string) => fsp.mkdir(p, { recursive: true }),
    link: (a: string, b: string) => fsp.link(a, b),
    unlink: (p: string) => fsp.unlink(p),
    renameNoReplace: async (from: string, to: string) => {
      try {
        await fsp.access(to)
        const e = new Error('exists') as NodeJS.ErrnoException
        e.code = 'EEXIST'
        throw e
      } catch {
        /* fallthrough */
      }
      await fsp.rename(from, to)
    },
    copyExclusive: async (from: string, to: string) => {
      const { constants } = await import('node:fs')
      await fsp.copyFile(from, to, constants.COPYFILE_EXCL)
    },
  }
}

const fsImpl = nodeFsLike()

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mysort-e2e-'))
  downloads = path.join(root, 'Downloads')
  destination = path.join(root, 'Sorted')
  mkdirSync(downloads, { recursive: true })
  mkdirSync(destination, { recursive: true })

  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  // operations.monitored_folder_id is a real FK; seed the folder it points at.
  db.prepare(
    `INSERT INTO monitored_folders (id, path, enabled, mode, created_at, updated_at)
     VALUES (1, ?, 1, 'auto', ?, ?)`
  ).run(downloads, new Date().toISOString(), new Date().toISOString())
  ops = new OperationsRepo(db)
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('end-to-end organization', () => {
  it('plans, applies, and moves a downloaded file to its category folder', async () => {
    // Simulate a finished download appearing in the watched folder.
    const src = path.join(downloads, 'holiday.png')
    writeFileSync(src, 'pretend-png-bytes')

    const plan = await buildPlan(fsImpl as never, {
      folderId: 1,
      folderPath: downloads,
      rules: ruleContext(),
      destinationContext: destContext(),
    })

    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]
    expect(item.fileName).toBe('holiday.png')
    // The destination must not be blocked by the deny list.
    expect(path.dirname(item.destPath)).toBe(path.join(destination, 'Pictures'))

    const stat = await fsImpl.lstat(src)
    const result = await executeOperation(
      { fs: fsImpl as never, journal: ops },
      {
        operationId: 'op-1',
        initiatedBy: 'auto',
        folderId: 1,
        sourcePath: src,
        fileName: 'holiday.png',
        destDir: path.dirname(item.destPath),
        destName: path.basename(item.destPath),
        rule: { kind: 'custom', id: 'r-img', label: 'Images', explanation: 'matched Images rule' },
        fingerprint: { size: stat.size, mtimeMs: stat.mtimeMs },
        validateDestinationPath: async (destDir) => {
          const v = await validateDestination('absolute', destDir, destContext())
          return v.ok ? { ok: true as const } : { ok: false as const, code: v.code, message: v.message }
        },
      }
    )

    expect(result.status, JSON.stringify(result.error)).toBe('completed')
    expect(existsSync(src)).toBe(false)
    const moved = path.join(destination, 'Pictures', 'holiday.png')
    expect(existsSync(moved)).toBe(true)
    expect(readFileSync(moved, 'utf8')).toBe('pretend-png-bytes')

    // The journal recorded it and offers undo.
    const op = ops.get('op-1')
    expect(op?.status).toBe('completed')
    expect(op?.undo.status).toBe('available')
  })

  it('refuses a destination inside the monitored folder (loop protection still works)', async () => {
    const v = await validateDestination('absolute', path.join(downloads, 'sub'), destContext(2))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe('DEST_LOOP')
  })

  it('still refuses a protected system location', async () => {
    const v = await validateDestination('absolute', 'C:\\Windows\\System32\\x', destContext())
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe('PATH_DENIED')
  })

  it('never overwrites an existing file; it auto-renames instead', async () => {
    const taken = path.join(destination, 'Pictures', 'dup.png')
    mkdirSync(path.dirname(taken), { recursive: true })
    writeFileSync(taken, 'ORIGINAL-CONTENT')

    const src = path.join(downloads, 'dup.png')
    writeFileSync(src, 'NEW-CONTENT')

    const stat = await fsImpl.lstat(src)
    const res = await resolveRule('dup.png', ruleContext())
    expect(res.outcome).toBe('custom')
    const result = await executeOperation(
      { fs: fsImpl as never, journal: ops },
      {
        operationId: 'op-2',
        initiatedBy: 'auto',
        folderId: 1,
        sourcePath: src,
        destDir: path.join(destination, 'Pictures'),
        destName: 'dup.png',
        rule: { kind: 'custom', id: 'r-img', label: 'Images', explanation: 'x' },
        fingerprint: { size: stat.size, mtimeMs: stat.mtimeMs },
        validateDestinationPath: async () => ({ ok: true as const }),
      }
    )

    expect(result.status, JSON.stringify(result.error)).toBe('completed')
    expect(readFileSync(taken, 'utf8')).toBe('ORIGINAL-CONTENT')
    expect(result.finalDestPath).not.toBe(taken)
    expect(readFileSync(result.finalDestPath as string, 'utf8')).toBe('NEW-CONTENT')
  })
})
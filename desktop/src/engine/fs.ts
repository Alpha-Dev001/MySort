/**
 * File-system interfaces used by the whole engine. The executor and planner only
 * see these, which is what makes fault injection and preview-read-only a
 * compile-time property (FsReader has no mutating methods).
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fsp } from 'node:fs'

export interface FileStat {
  size: number
  mtimeMs: number
  /** Windows creation time (used by the auto_since filter). */
  birthtimeMs: number
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
}

export interface FsReader {
  lstat(p: string): Promise<FileStat>
  /** Names only, including dotfiles and hidden entries; caller joins paths. */
  readdir(p: string): Promise<string[]>
  realpath(p: string): Promise<string>
  exists(p: string): Promise<boolean>
}

export interface FsWriter extends FsReader {
  mkdir(p: string): Promise<void>
  /** Atomic create; fails with EEXIST when the name is taken. */
  link(existingPath: string, newPath: string): Promise<void>
  unlink(p: string): Promise<void>
  /** Check-then-rename fallback for file systems without link support. */
  renameNoReplace(from: string, to: string): Promise<void>
  /** Copy that fails with EEXIST if the destination exists. */
  copyExclusive(from: string, to: string): Promise<void>
}

function mapStat(s: {
  size: number
  mtimeMs: number
  birthtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}): FileStat {
  return {
    size: s.size,
    mtimeMs: s.mtimeMs,
    birthtimeMs: s.birthtimeMs,
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymlink: s.isSymbolicLink(),
  }
}

export class NodeFs implements FsWriter {
  async lstat(p: string): Promise<FileStat> {
    return mapStat(await fsp.lstat(p))
  }

  async readdir(p: string): Promise<string[]> {
    return fsp.readdir(p)
  }

  async realpath(p: string): Promise<string> {
    return fsp.realpath(p)
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fsp.access(p)
      return true
    } catch {
      return false
    }
  }

  async mkdir(p: string): Promise<void> {
    await fsp.mkdir(p, { recursive: true })
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await fsp.link(existingPath, newPath)
  }

  async unlink(p: string): Promise<void> {
    await fsp.unlink(p)
  }

  async renameNoReplace(from: string, to: string): Promise<void> {
    if (await this.exists(to)) {
      const err = new Error(`destination already exists: ${to}`) as NodeJS.ErrnoException
      err.code = 'EEXIST'
      throw err
    }
    await fsp.rename(from, to)
  }

  async copyExclusive(from: string, to: string): Promise<void> {
    const { constants } = await import('node:fs')
    await fsp.copyFile(from, to, constants.COPYFILE_EXCL)
  }
}

/**
 * SHA-256 of a file, or null when the file is larger than `maxBytes`
 * (callers fall back to size + mtime checks).
 */
export async function hashFile(p: string, maxBytes: number): Promise<string | null> {
  const st = await fsp.stat(p)
  if (st.size > maxBytes) return null
  return await new Promise<string | null>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(p)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Best-effort Windows hidden/system attribute probe via attrib.exe.
 * Node's fs does not expose FILE_ATTRIBUTE_HIDDEN, so we ask the OS.
 * Failures (network paths, timeouts) are treated as "not hidden" — the name-based
 * exclusions still apply.
 */
export async function windowsAttributes(p: string): Promise<{ hidden: boolean; system: boolean }> {
  if (process.platform !== 'win32') return { hidden: false, system: false }
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile('attrib', [p], { timeout: 2000, windowsHide: true }, (err, stdout) => {
        if (err && typeof err.code !== 'number') reject(err)
        else resolve(stdout)
      })
      child.on('error', reject)
    })
    // Output looks like: "A AHR C:\path\file.txt"; flag columns precede the path.
    const head = out.slice(0, 12)
    return { hidden: head.includes('H'), system: head.includes('S') }
  } catch {
    return { hidden: false, system: false }
  }
}

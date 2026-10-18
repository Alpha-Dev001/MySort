/**
 * Folder grants: absolute paths may only enter the system through the OS folder
 * picker. The picker returns a single-use grant that expires in five minutes;
 * later calls (folders:add, rule destinations, destination root) reference the
 * grant id instead of a typed path. This is what keeps typed rule destinations
 * relative-only.
 */

import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { dialog } from 'electron'
import { appError } from '../shared/errors'
import type { FolderGrant, FolderPickPurpose } from '../shared/types'

const GRANT_TTL_MS = 5 * 60 * 1000

interface StoredGrant {
  purpose: FolderPickPurpose
  path: string
  displayName: string
  expiresAt: number
  used: boolean
}

export class GrantStore {
  private readonly grants = new Map<string, StoredGrant>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Opens the OS folder picker; validates writability with a temp-file test. */
  async pick(purpose: FolderPickPurpose, win: Electron.BrowserWindow | null): Promise<FolderGrant | null> {
    const opts: Electron.OpenDialogOptions = {
      title: purpose === 'monitor' ? 'Choose a folder to monitor' : 'Choose a destination folder',
      properties: ['openDirectory'],
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0]
    await this.writeTest(chosen)
    const grantId = randomUUID()
    this.grants.set(grantId, {
      purpose,
      path: chosen,
      displayName: chosen,
      expiresAt: this.now() + GRANT_TTL_MS,
      used: false,
    })
    return { grantId, displayName: chosen }
  }

  /** Consumes a grant (single use). Throws GRANT_EXPIRED / NOT_FOUND. */
  consume(grantId: string, purpose: FolderPickPurpose): string {
    const grant = this.grants.get(grantId)
    if (!grant || grant.used || grant.purpose !== purpose) {
      this.grants.delete(grantId)
      throw appError('GRANT_EXPIRED', 'this folder selection has expired; please pick the folder again')
    }
    grant.used = true
    this.grants.delete(grantId)
    return grant.path
  }

  private async writeTest(dir: string): Promise<void> {
    const probe = path.join(dir, `.mysort-write-test-${randomUUID().slice(0, 8)}.tmp`)
    try {
      await fsp.writeFile(probe, 'mysort')
    } catch (e) {
      throw appError('PERMISSION_DENIED', `MySort cannot write to this folder (${(e as Error).message})`)
    } finally {
      await fsp.rm(probe, { force: true }).catch(() => undefined)
    }
  }
}

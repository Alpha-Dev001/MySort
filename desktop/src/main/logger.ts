/**
 * Logging: electron-log, rotating files in the user-data logs folder.
 * At info level we log operation ids, status transitions, error codes and
 * durations — never file names or full paths. debug (user-enabled, 24h) adds
 * names for troubleshooting.
 */

import log from 'electron-log/main'
import type { LogLevel } from '../shared/types'

export const logger = log

let debugExpiresAt = 0

export function configureLogging(level: LogLevel, now = Date.now()): void {
  const file = log.transports.file
  file.level = level
  file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}]: {text}'
  file.maxSize = 5 * 1024 * 1024
  const withMaxFiles = file as unknown as { maxLogFiles?: number }
  if ('maxLogFiles' in file || 'maxLogFiles' in withMaxFiles) withMaxFiles.maxLogFiles = 3

  if (level === 'debug') {
    // debug reverts to info after 24 hours so troubleshooting never sticks forever
    debugExpiresAt = now + 24 * 60 * 60 * 1000
  } else {
    debugExpiresAt = 0
  }
}

/** Call on the daily timer; reverts debug logging after 24 hours. */
export function maybeRevertDebug(now = Date.now()): void {
  if (debugExpiresAt > 0 && now > debugExpiresAt) {
    log.transports.file.level = 'info'
    debugExpiresAt = 0
  }
}

export function logOperation(event: string, operationId: string, detail?: string): void {
  log.info(`[op] ${event} ${operationId}${detail ? ` ${detail}` : ''}`)
}

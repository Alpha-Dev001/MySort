/**
 * Error model shared by main, preload and renderer.
 *
 * Expected failures (blocked undo, invalid rule, busy file) are returned as
 * `Result<T>` failures with a specific code. The renderer maps codes to friendly
 * copy; messages are English and intended for logs.
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHORIZED_SENDER',
  'NOT_FOUND',
  'CONFLICT',
  'GRANT_EXPIRED',
  'PATH_INVALID',
  'PATH_DENIED',
  'DEST_UNAVAILABLE',
  'DEST_IS_SOURCE',
  'DEST_LOOP',
  'PERMISSION_DENIED',
  'BUSY',
  'DISK_FULL',
  'SOURCE_GONE',
  'SOURCE_CHANGED',
  'NOT_READY',
  'NO_EXTENSION',
  'INTERRUPTED',
  'RULE_INVALID',
  'DB_ERROR',
  'UNDO_BLOCKED',
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface AppError {
  code: ErrorCode
  /** English, for logs; the UI shows friendly copy chosen by the code. */
  message: string
  /** Never file contents. */
  details?: Record<string, string | number>
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }

export function appError(
  code: ErrorCode,
  message: string,
  details?: Record<string, string | number>
): AppError {
  return details ? { code, message, details } : { code, message }
}

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function fail<T>(code: ErrorCode, message: string): Result<T> {
  return { ok: false, error: appError(code, message) }
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    typeof (value as AppError).code === 'string' &&
    typeof (value as AppError).message === 'string'
  )
}

/** Map any thrown value to an AppError. Unexpected exceptions become INTERNAL. */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e
  if (e instanceof Error) {
    const syscode = (e as Error & { code?: string | number }).code
    return appError('INTERNAL', `${e.name}: ${e.message}`, {
      ...(syscode ? { syscode } : {}),
    })
  }
  return appError('INTERNAL', 'Unknown error')
}

/** Map a Node errno to our error model; falls back to the given default. */
export function fromErrno(e: unknown, fallback: ErrorCode, message: string): AppError {
  const code = (e as { code?: string | number } | null | undefined)?.code
  const mapped: ErrorCode =
    code === 'EACCES' || code === 'EPERM'
      ? 'PERMISSION_DENIED'
      : code === 'EBUSY' || code === 'ETXTBSY'
        ? 'BUSY'
        : code === 'ENOSPC'
          ? 'DISK_FULL'
          : code === 'EXDEV'
            ? 'DEST_UNAVAILABLE'
            : code === 'ENOENT'
              ? 'SOURCE_GONE'
              : fallback
  return appError(mapped, `${message}${code ? ` (${code})` : ''}`)
}

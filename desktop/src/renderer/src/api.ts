/*
 * Renderer API: a typed wrapper over the preload bridge.
 *
 * window.api is declared on Window and implemented by preload/index.ts.
 * Every method returns a Result<T> envelope (ok: true | false).
 */

import type {
  ApplicationSettings,
  FileOperation,
  FileRule,
  MonitoringStatus,
  MySortApi,
} from '../../shared/types'

declare global {
  interface Window {
    api: MySortApi
  }
}

/**
 * The preload bridge, captured as a real runtime value.
 * (`export declare const` would be erased by the compiler and leave screens
 * importing a name that does not exist at runtime.)
 */
export const api: MySortApi = window.api

export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: Record<string, string | number> } }

export interface Unsubscribe {
  (): void
}

// ------------------------------------------------------------------
// Event subscriptions (main → renderer)
// ------------------------------------------------------------------

export function onMonitoringStatus(cb: (s: MonitoringStatus) => void): Unsubscribe {
  return api.onMonitoringStatus(cb)
}

export function onOperationUpdated(cb: (op: FileOperation) => void): Unsubscribe {
  return api.onOperationUpdated(cb)
}

export function onRulesChanged(cb: (rules: FileRule[]) => void): Unsubscribe {
  return api.onRulesChanged(cb)
}

export function onSettingsChanged(cb: (s: ApplicationSettings) => void): Unsubscribe {
  return api.onSettingsChanged(cb)
}


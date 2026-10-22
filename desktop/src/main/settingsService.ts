/**
 * Settings service: typed view over the key-value rows, with defaults.
 * Applied side effects (log level, login item) live in the callers that own
 * those systems; this module only stores and validates.
 */

import type { ApplicationSettings, CloseButtonBehavior, LogLevel, NotificationPreference, SettingsPatch } from '../shared/types'
import type { SettingsRepo } from '../db/repositories/settingsRepo'

export const SETTINGS_KEYS = {
  destinationRoot: 'destinationRoot',
  startWithWindows: 'startWithWindows',
  closeButtonBehavior: 'closeButtonBehavior',
  resumeMonitoringOnLaunch: 'resumeMonitoringOnLaunch',
  notifications: 'notifications',
  previewBeforeAuto: 'previewBeforeAuto',
  sortFolders: 'sortFolders',
  historyRetentionDays: 'historyRetentionDays',
  undoWindowDays: 'undoWindowDays',
  logLevel: 'logLevel',
  onboardingCompleted: 'onboardingCompleted',
  recommendationThreshold: 'recommendationThreshold',
  readinessStableChecks: 'readinessStableChecks',
} as const

export class SettingsService {
  constructor(
    private readonly repo: SettingsRepo,
    private readonly defaults: { destinationRoot: string }
  ) {}

  get(): ApplicationSettings {
    const r = this.repo
    return {
      destinationRoot: r.getString(SETTINGS_KEYS.destinationRoot, this.defaults.destinationRoot),
      // The application sorts downloads in the background; it starts with the
      // computer by default and can be turned off in settings.
      startWithWindows: r.getBool(SETTINGS_KEYS.startWithWindows, true),
      closeButtonBehavior: r.getString(SETTINGS_KEYS.closeButtonBehavior, 'tray') as CloseButtonBehavior,
      resumeMonitoringOnLaunch: r.getBool(SETTINGS_KEYS.resumeMonitoringOnLaunch, true),
      notifications: r.getString(SETTINGS_KEYS.notifications, 'failures') as NotificationPreference,
      previewBeforeAuto: r.getBool(SETTINGS_KEYS.previewBeforeAuto, false),
      // Moving whole folders is the riskiest thing MySort can do on its own,
      // so it is opt-in. Users who explicitly turn it on keep that choice:
      // only the fallback for "never configured" changes here.
      sortFolders: r.getBool(SETTINGS_KEYS.sortFolders, false),
      historyRetentionDays: r.getNumber(SETTINGS_KEYS.historyRetentionDays, 90),
      undoWindowDays: r.getNumber(SETTINGS_KEYS.undoWindowDays, 30),
      logLevel: r.getString(SETTINGS_KEYS.logLevel, 'info') as LogLevel,
      onboardingCompleted: r.getBool(SETTINGS_KEYS.onboardingCompleted, false),
      recommendationThreshold: r.getNumber(SETTINGS_KEYS.recommendationThreshold, 3),
      readinessStableChecks: r.getNumber(SETTINGS_KEYS.readinessStableChecks, 3),
    }
  }

  /** Applies a patch; `destinationRoot` must already be validated by the caller. */
  update(patch: SettingsPatch & { destinationRoot?: string }): ApplicationSettings {
    const entries: [string, unknown][] = []
    if (patch.startWithWindows !== undefined) entries.push([SETTINGS_KEYS.startWithWindows, patch.startWithWindows])
    if (patch.closeButtonBehavior !== undefined) entries.push([SETTINGS_KEYS.closeButtonBehavior, patch.closeButtonBehavior])
    if (patch.resumeMonitoringOnLaunch !== undefined) entries.push([SETTINGS_KEYS.resumeMonitoringOnLaunch, patch.resumeMonitoringOnLaunch])
    if (patch.notifications !== undefined) entries.push([SETTINGS_KEYS.notifications, patch.notifications])
    if (patch.previewBeforeAuto !== undefined) entries.push([SETTINGS_KEYS.previewBeforeAuto, patch.previewBeforeAuto])
    if (patch.sortFolders !== undefined) entries.push([SETTINGS_KEYS.sortFolders, patch.sortFolders])
    if (patch.historyRetentionDays !== undefined) entries.push([SETTINGS_KEYS.historyRetentionDays, patch.historyRetentionDays])
    if (patch.undoWindowDays !== undefined) entries.push([SETTINGS_KEYS.undoWindowDays, patch.undoWindowDays])
    if (patch.logLevel !== undefined) entries.push([SETTINGS_KEYS.logLevel, patch.logLevel])
    if (patch.onboardingCompleted !== undefined) entries.push([SETTINGS_KEYS.onboardingCompleted, patch.onboardingCompleted])
    if (patch.recommendationThreshold !== undefined) entries.push([SETTINGS_KEYS.recommendationThreshold, patch.recommendationThreshold])
    if (patch.destinationRoot !== undefined) entries.push([SETTINGS_KEYS.destinationRoot, patch.destinationRoot])
    for (const [key, value] of entries) this.repo.set(key, value)
    return this.get()
  }
}

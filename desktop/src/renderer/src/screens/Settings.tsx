import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppInfo,
  ApplicationSettings,
  MonitoredFolder,
  SettingsPatch,
} from '../../../shared/types'
import type { SettingsTab } from '../routes'
import { DEFAULT_SETTINGS_TAB } from '../routes'
import SettingsNav from './SettingsNav'
import FoldersTab from './SettingsFoldersTab'
import BehaviourTab from './SettingsBehaviourTab'
import NotificationsTab from './SettingsNotificationsTab'
import StartupTab from './SettingsStartupTab'
import DiagnosticsTab from './SettingsDiagnosticsTab'
import ResetTab from './SettingsResetTab'
import PageHeader from '../components/PageHeader'
import Panel from '../components/Panel'
import { LoadingState, ErrorState } from '../components/States'
import { useConfirm } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { api } from '../api'
import { modeLabel } from '../lib/format'
import styles from './Settings.module.css'

export interface SettingsScreenProps {
  /** Currently open tab, from the location (`#/settings/<tab>`). */
  tab?: SettingsTab
  /** Reports tab changes so the shell can carry them in the hash. */
  onTabChange?: (tab: SettingsTab) => void
}

/**
 * Settings as six short pages behind one tab row, instead of one long scroll.
 *
 * This screen is the coordinator only: it owns data loading, the save
 * pipeline and per-tab callbacks; each tab page owns its rows. The open tab
 * is part of the address (`#/settings/<tab>`), so a tab is deep-linkable the
 * same way a rule page is.
 */
const SettingsScreen: React.FC<SettingsScreenProps> = ({ tab: tabProp, onTabChange }) => {
  const toast = useToast()
  const confirm = useConfirm()

  const [settings, setSettings] = useState<ApplicationSettings | null>(null)
  const [folders, setFolders] = useState<MonitoredFolder[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [tab, setTab] = useState<SettingsTab>(tabProp ?? DEFAULT_SETTINGS_TAB)

  // The shell owns the address; follow it when it changes (deep link, tab
  // click routed back down). The seed value is handled by useState above.
  useEffect(() => {
    if (tabProp && tabProp !== tab) setTab(tabProp)
  }, [tabProp])

  // Sends exactly the field that changed, as a typed patch. The previous
  // implementation replayed a whole accumulated "dirty" object, so editing one
  // field could silently re-write older values.
  const save = useCallback(
    async (patch: SettingsPatch, label: string) => {
      setPending(String(Object.keys(patch)[0]))
      const res = await api.settings.update(patch)
      setPending(null)
      if (res.ok) {
        setSettings(res.data)
      } else {
        toast.push({ kind: 'error', title: `Could not save ${label.toLowerCase()}`, description: res.error.message })
      }
    },
    [toast],
  )

  const loadFolders = useCallback(async () => {
    const res = await api.folders.list()
    if (res.ok) setFolders(res.data)
  }, [])

  const load = useCallback(async () => {
    const [s, f, a] = await Promise.all([api.settings.get(), api.folders.list(), api.app.getInfo()])
    if (s.ok) {
      setSettings(s.data)
      setError(null)
    } else {
      setError(s.error.message)
    }
    if (f.ok) setFolders(f.data)
    if (a.ok) setInfo(a.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Subscribing once: the handler identity is stable and the effect no longer
  // depends on `settings`, so a change event cannot re-trigger the effect and
  // loop.
  useEffect(() => {
    const unsub = api.onSettingsChanged((next) => setSettings(next))
    return unsub
  }, [])

  const pickMonitorFolder = useCallback(async () => {
    const grant = await api.folders.pick('monitor')
    if (!grant.ok) return
    const res = await api.folders.add({ grantId: grant.data.grantId, mode: folders[0]?.mode ?? 'auto' })
    if (res.ok) {
      await loadFolders()
      toast.push({ kind: 'success', title: 'Folder added', description: res.data.path })
    } else {
      toast.push({ kind: 'error', title: 'Could not watch that folder', description: res.error.message })
    }
  }, [folders, loadFolders, toast])

  const removeFolder = useCallback(
    async (folder: MonitoredFolder) => {
      const ok = await confirm({
        title: 'Stop watching this folder?',
        description: `MySort will no longer look at ${folder.path}. Files already moved stay where they are.`,
        confirmLabel: 'Stop watching',
        tone: 'danger',
      })
      if (!ok) return
      const res = await api.folders.remove({ folderId: folder.id })
      if (res.ok) {
        await loadFolders()
        toast.push({ kind: 'info', title: 'Folder removed' })
      } else {
        toast.push({ kind: 'error', title: 'Could not remove the folder', description: res.error.message })
      }
    },
    [confirm, loadFolders, toast],
  )

  const setFolderMode = useCallback(
    async (folder: MonitoredFolder, mode: 'manual' | 'auto') => {
      const res = await api.folders.setMode({ folderId: folder.id, mode })
      if (res.ok) {
        await loadFolders()
        toast.push({ kind: 'success', title: `${folder.path.split(/[\\/]/).pop()} set to ${modeLabel(mode)}` })
      } else {
        toast.push({ kind: 'error', title: 'Could not change the mode', description: res.error.message })
      }
    },
    [loadFolders, toast],
  )

  const pickDestinationRoot = useCallback(async () => {
    const grant = await api.folders.pick('destination')
    if (!grant.ok) return
    const res = await api.settings.update({ destinationRootGrantId: grant.data.grantId })
    if (res.ok) {
      setSettings(res.data)
      toast.push({ kind: 'success', title: 'Destination root updated', description: res.data.destinationRoot })
    } else {
      toast.push({ kind: 'error', title: 'Could not use that folder', description: res.error.message })
    }
  }, [toast])

  const exportDiagnostics = useCallback(async () => {
    setExporting(true)
    try {
      const res = await api.diagnostics.export()
      if (res.ok && res.data.saved) {
        toast.push({ kind: 'success', title: 'Diagnostics exported', description: 'Saved where you chose. Nothing was sent anywhere.' })
      }
    } finally {
      setExporting(false)
    }
  }, [toast])

  const resetAll = useCallback(async () => {
    const ok = await confirm({
      title: 'Reset everything?',
      description:
        'This clears your rules, folder list, settings and the entire move history. Files already moved stay where they are, but nothing about them will be recorded. This cannot be undone.',
      confirmLabel: 'Reset everything',
      tone: 'danger',
    })
    if (!ok) return
    const res = await api.settings.resetAll('RESET')
    if (res.ok) {
      setSettings(res.data)
      await loadFolders()
      toast.push({ kind: 'success', title: 'MySort has been reset', description: 'Start again from the setup screen.' })
    } else {
      toast.push({ kind: 'error', title: 'Could not reset', description: res.error.message })
    }
  }, [confirm, loadFolders, toast])

  // One consistent status affordance for every setting that writes on change.
  // It rides the row's label line, so appearing never shifts the layout.
  const savingFor = useCallback(
    (field: string): React.ReactNode => (pending === field ? <span className={styles.saving}>Saving…</span> : null),
    [pending],
  )

  // Typed adapter for the tab pages' synchronous save callbacks.
  const saveSync = useCallback(
    (patch: SettingsPatch, label: string) => {
      void save(patch, label)
    },
    [save],
  )

  const page = useMemo(() => {
    if (!settings) return null
    switch (tab) {
      case 'folders':
        return (
          <FoldersTab
            settings={settings}
            folders={folders}
            onAddFolder={() => void pickMonitorFolder()}
            onRemoveFolder={(folder) => void removeFolder(folder)}
            onSetFolderMode={(folder, mode) => void setFolderMode(folder, mode)}
            onPickDestinationRoot={() => void pickDestinationRoot()}
          />
        )
      case 'behaviour':
        return <BehaviourTab settings={settings} savingFor={savingFor} save={saveSync} />
      case 'notifications':
        return <NotificationsTab settings={settings} savingFor={savingFor} save={saveSync} />
      case 'startup':
        return <StartupTab settings={settings} savingFor={savingFor} save={saveSync} />
      case 'diagnostics':
        return (
          <DiagnosticsTab
            settings={settings}
            info={info}
            exporting={exporting}
            savingFor={savingFor}
            save={saveSync}
            onExport={() => void exportDiagnostics()}
          />
        )
      case 'reset':
        return <ResetTab onReset={() => void resetAll()} />
      default:
        return null
    }
  }, [
    settings,
    folders,
    info,
    exporting,
    tab,
    savingFor,
    saveSync,
    pickMonitorFolder,
    removeFolder,
    setFolderMode,
    pickDestinationRoot,
    exportDiagnostics,
    resetAll,
  ])

  if (loading) {
    return (
      <>
        <PageHeader description="Configure how MySort behaves." />
        <Panel tone="raised">
          <LoadingState label="Loading settings" />
        </Panel>
      </>
    )
  }

  if (error || !settings) {
    return (
      <>
        <PageHeader />
        <ErrorState message={error} onRetry={() => void load()} />
      </>
    )
  }

  return (
    <>
      <PageHeader description="Folders, safety behaviour and diagnostics. Changes take effect immediately." />
      <SettingsNav
        tab={tab}
        onTabChange={(next) => {
          setTab(next)
          onTabChange?.(next)
        }}
      />
      <section
        className={styles.tabPanel}
        id="settings-tabpanel"
        role="tabpanel"
        key={tab}
        aria-labelledby={`settings-tab-${tab}`}
        tabIndex={-1}
      >
        {page}
      </section>
    </>
  )
}

export default SettingsScreen

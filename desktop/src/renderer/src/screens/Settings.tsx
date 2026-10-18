import React, { useCallback, useEffect, useState } from 'react'
import {
  Clock,
  Download,
  FileDown,
  FolderOpen,
  Info,
  Monitor,
  Plus,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react'
import type {
  AppInfo,
  ApplicationSettings,
  LogLevel,
  MonitoredFolder,
  NotificationPreference,
  SettingsPatch,
} from '../../../shared/types'
import { api } from '../api'
import Button from '../components/Button'
import { FieldRow, Segmented, Select } from '../components/Field'
import PageHeader from '../components/PageHeader'
import Panel, { Section } from '../components/Panel'
import StatusPill from '../components/StatusPill'
import Toggle from '../components/Toggle'
import { EmptyState, ErrorState, LoadingState, Notice } from '../components/States'
import { useConfirm } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { folderStateLabel, folderStateTone, formatDate, modeLabel, shortenPath } from '../lib/format'
import styles from './Settings.module.css'

const SettingsScreen: React.FC = () => {
  const toast = useToast()
  const confirm = useConfirm()

  const [settings, setSettings] = useState<ApplicationSettings | null>(null)
  const [folders, setFolders] = useState<MonitoredFolder[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

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

  // One consistent status affordance for every setting that writes on change.
  // It rides the row's label line, so appearing never shifts the layout.
  const savingFor = (field: string): React.ReactNode =>
    pending === field ? <span className={styles.saving}>Saving…</span> : null

  return (
    <>
      <PageHeader description="Folders, safety behaviour and diagnostics. Changes take effect immediately." />

      {/* ---- folders ---------------------------------------------------- */}
      <Section
        title="Watched folders"
        description="MySort only looks at loose files directly inside these folders."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void pickMonitorFolder()}>
            <Plus size={14} /> Add folder
          </Button>
        }
      >
        {folders.length === 0 ? (
          <EmptyState
            compact
            icon={<FolderOpen size={17} />}
            title="No folders are being watched"
            description="Add a folder and MySort will start sorting finished downloads from it."
            action={
              <Button variant="primary" size="sm" onClick={() => void pickMonitorFolder()}>
                <FolderOpen size={14} /> Choose a folder
              </Button>
            }
          />
        ) : (
          <ul className={styles.folderList}>
            {folders.map((folder) => (
              <li key={folder.id} className={styles.folderRow}>
                <span className={styles.folderIcon} aria-hidden="true">
                  <FolderOpen size={16} />
                </span>
                <div className={styles.folderText}>
                  <span className={styles.folderPath} title={folder.path}>
                    {shortenPath(folder.path, 60)}
                  </span>
                  <span className={styles.folderMeta}>
                    Added {formatDate(folder.createdAt)}
                    {folder.pendingCandidates > 0 && ` · ${folder.pendingCandidates} waiting`}
                  </span>
                </div>
                <StatusPill tone={folderStateTone(folder.state)} size="sm">
                  {folderStateLabel(folder.state)}
                </StatusPill>
                <Segmented
                  ariaLabel={`Mode for ${folder.path}`}
                  value={folder.mode}
                  onChange={(mode) => void setFolderMode(folder, mode)}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'manual', label: 'Manual' },
                  ]}
                />
                <Button
                  variant="quiet"
                  size="sm"
                  iconOnly
                  onClick={() => void removeFolder(folder)}
                  aria-label={`Stop watching ${folder.path}`}
                  title="Stop watching"
                >
                  <X size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <FieldRow label="Destination root" help="Every rule destination is resolved inside this folder.">
          <code className={styles.pathValue} title={settings.destinationRoot}>
            {shortenPath(settings.destinationRoot, 34)}
          </code>
          <Button variant="secondary" onClick={() => void pickDestinationRoot()}>
            Change
          </Button>
        </FieldRow>
      </Section>

      {/* ---- behaviour ---------------------------------------------------- */}
      <Section
        title="Behaviour"
        description="How much MySort does on its own."
      >
        <FieldRow
          label="Review before moving"
          help="When off, finished downloads are organised without waiting for your approval."
          status={savingFor('previewBeforeAuto')}
        >
          <Toggle
            checked={settings.previewBeforeAuto}
            onChange={(next) => void save({ previewBeforeAuto: next }, 'Review setting')}
            label="Review before moving"
          />
        </FieldRow>
        <FieldRow
          label="Keep history for"
          help="Older activity is deleted when this window passes."
          status={savingFor('historyRetentionDays')}
        >
          <Select
            selectSize="sm"
            aria-label="Keep history for"
            value={settings.historyRetentionDays}
            onChange={(e) => void save({ historyRetentionDays: Number(e.target.value) }, 'History retention')}
            options={[
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
              { value: '365', label: '1 year' },
            ]}
          />
        </FieldRow>
        <FieldRow
          label="Undo window"
          help="How long a completed move can be reversed."
          status={savingFor('undoWindowDays')}
        >
          <Select
            selectSize="sm"
            aria-label="Undo window"
            value={settings.undoWindowDays}
            onChange={(e) => void save({ undoWindowDays: Number(e.target.value) }, 'Undo window')}
            options={[
              { value: '1', label: '1 day' },
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
            ]}
          />
        </FieldRow>
      </Section>

      {/* ---- notifications -------------------------------------------------- */}
      <Section title="Notifications" description="When MySort is allowed to interrupt you.">
        <FieldRow label="Notify me about" status={savingFor('notifications')}>
          <Segmented
            ariaLabel="Notification preference"
            value={settings.notifications}
            onChange={(next: NotificationPreference) => void save({ notifications: next }, 'Notification preference')}
            options={[
              { value: 'failures', label: 'Failures only' },
              { value: 'summaries', label: 'Summaries' },
              { value: 'none', label: 'Nothing' },
            ]}
          />
        </FieldRow>
      </Section>

      {/* ---- windows & startup ------------------------------------------------ */}
      <Section title="Windows and startup">
        <FieldRow
          label={
            <>
              <Monitor size={14} aria-hidden="true" /> Keep running in the tray when I close the window
            </>
          }
          help="Closing the window hides it. Use the tray menu to quit completely."
          status={savingFor('closeButtonBehavior')}
        >
          <Toggle
            checked={settings.closeButtonBehavior === 'tray'}
            onChange={(next) =>
              void save({ closeButtonBehavior: next ? 'tray' : 'quit' }, 'Close button behaviour')
            }
            label="Keep running in the tray"
          />
        </FieldRow>
        <FieldRow
          label={
            <>
              <Download size={14} aria-hidden="true" /> Start MySort when Windows starts
            </>
          }
          status={savingFor('startWithWindows')}
        >
          <Toggle
            checked={settings.startWithWindows}
            onChange={(next) => void save({ startWithWindows: next }, 'Start with Windows')}
            label="Start with Windows"
          />
        </FieldRow>
        <FieldRow
          label={
            <>
              <Clock size={14} aria-hidden="true" /> Resume monitoring on launch
            </>
          }
          help="MySort also checks for interrupted moves when it starts."
          status={savingFor('resumeMonitoringOnLaunch')}
        >
          <Toggle
            checked={settings.resumeMonitoringOnLaunch}
            onChange={(next) => void save({ resumeMonitoringOnLaunch: next }, 'Resume on launch')}
            label="Resume monitoring on launch"
          />
        </FieldRow>
      </Section>

      {/* ---- diagnostics -------------------------------------------------------- */}
      <Section
        title="Diagnostics"
        description="Everything here stays on this computer."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void exportDiagnostics()} loading={exporting}>
            <FileDown size={14} /> Export
          </Button>
        }
      >
        <FieldRow
          label="Log level"
          help="Debug records file names and is used for troubleshooting."
          status={savingFor('logLevel')}
        >
          <Select
            selectSize="sm"
            aria-label="Log level"
            value={settings.logLevel}
            onChange={(e) => void save({ logLevel: e.target.value as LogLevel }, 'Log level')}
            options={[
              { value: 'error', label: 'Errors only' },
              { value: 'warn', label: 'Warnings' },
              { value: 'info', label: 'Info' },
              { value: 'debug', label: 'Debug' },
            ]}
          />
        </FieldRow>
        <FieldRow label="Version">
          <span className={styles.version}>{info ? `${info.version} · ${info.platform}` : '—'}</span>
        </FieldRow>
        <Notice tone="info" icon={<Info size={15} />}>
          An exported diagnostics file contains your settings, folder counts and a tail of the log. Folder paths
          are redacted. It is never uploaded.
        </Notice>
      </Section>

      {/* ---- danger zone --------------------------------------------------------- */}
      <section className={styles.dangerZone}>
        <div className={styles.dangerText}>
          <h2 className={styles.dangerTitle}>Reset MySort</h2>
          <p className={styles.dangerDescription}>
            Removes your rules, watched folders, settings and the whole move history. Files already moved are not
            put back — only the record of them is deleted.
          </p>
        </div>
        <Button variant="danger" onClick={() => void resetAll()}>
          <RotateCcw size={14} /> Reset everything
        </Button>
      </section>

      <p className={styles.footnote}>
        <ShieldCheck size={13} aria-hidden="true" />
        <span>
          MySort has no network access, no telemetry and no account. Everything it knows lives in{' '}
          {info && <code className={styles.dataPath}>{info.userDataPath}</code>}
        </span>
      </p>
    </>
  )
}

export default SettingsScreen
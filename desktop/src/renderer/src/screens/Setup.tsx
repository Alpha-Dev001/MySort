import React, { useCallback, useEffect, useState } from 'react'
import {
  CheckCircle2,
  FolderOpen,
  Loader2,
  Play,
  ShieldCheck,
  X,
} from 'lucide-react'
import type { ApplicationSettings, MonitoredFolder } from '../../../shared/types'
import { api } from '../api'
import Button from '../components/Button'
import PageHeader from '../components/PageHeader'
import Panel from '../components/Panel'
import StatusPill from '../components/StatusPill'
import { Notice } from '../components/States'
import { useToast } from '../components/Toast'
import { formatRelative, modeLabel } from '../lib/format'
import styles from './Setup.module.css'

interface SetupScreenProps {
  onDone?: () => void
  onSkip?: () => void
}

/**
 * The whole of MySort's setup, in one screen and one action.
 *
 * The previous build opened a two-step welcome wizard with a decorative hero
 * that repeated the page title. That was 400px of vertical space to reach the
 * only operation that genuinely has to happen — choosing a folder through the
 * OS picker, so the path arrives as a grant rather than as a typed string.
 * That operation is preserved here and nowhere else.
 */
export const SetupScreen: React.FC<SetupScreenProps> = ({ onDone, onSkip }) => {
  const toast = useToast()
  const [folders, setFolders] = useState<MonitoredFolder[]>([])
  const [settings, setSettings] = useState<ApplicationSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [picking, setPicking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [f, s] = await Promise.all([api.folders.list(), api.settings.get()])
    if (f.ok) setFolders(f.data)
    if (s.ok) setSettings(s.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
    const unsub = api.onSettingsChanged(setSettings)
    return unsub
  }, [load])

  const folder = folders[0]

  /** The one irreversible-ish step: an OS-picked folder becomes a grant. */
  const chooseFolder = useCallback(async () => {
    setPicking(true)
    setError(null)
    try {
      const grant = await api.folders.pick('monitor')
      if (!grant.ok) {
        // The user dismissed the picker — that is not an error.
        return
      }
      if (folder) await api.folders.remove({ folderId: folder.id })
      const added = await api.folders.add({ grantId: grant.data.grantId, mode: folder?.mode ?? 'auto' })
      if (!added.ok) {
        setError(added.error.message)
        return
      }
      await load()
      toast.push({ kind: 'success', title: 'Folder added', description: `MySort will watch ${added.data.path}` })
    } finally {
      setPicking(false)
    }
  }, [folder, load, toast])

  const removeFolder = useCallback(async () => {
    if (!folder) return
    setPicking(true)
    try {
      await api.folders.remove({ folderId: folder.id })
      await load()
      toast.push({ kind: 'info', title: 'Folder removed' })
    } finally {
      setPicking(false)
    }
  }, [folder, load, toast])

  const startMonitoring = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      const result = await api.monitoring.start()
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      const marked = await api.settings.update({ onboardingCompleted: true })
      if (marked.ok) setSettings(marked.data)
      toast.push({ kind: 'success', title: 'MySort is watching', description: 'Finished downloads will be sorted from now on.' })
      onDone?.()
    } finally {
      setStarting(false)
    }
  }, [onDone, toast])

  const alreadyOn = settings?.onboardingCompleted === true
  const ready = Boolean(folder)

  const handlePrimary = async (): Promise<void> => {
    if (!ready) {
      await chooseFolder()
      return
    }
    await startMonitoring()
  }

  return (
    <>
      <PageHeader
        description="Choose one folder to watch. MySort sorts finished downloads out of it using your rules — nothing leaves this computer."
        actions={
          <Button variant="ghost" onClick={onSkip}>
            {alreadyOn ? 'Back to overview' : 'Skip for now'}
          </Button>
        }
      />

      <div className={styles.columns}>
        <Panel tone="raised" className={styles.card}>
          <div className={styles.step}>
            <span className={styles.stepIndex} aria-hidden="true">
              1
            </span>
            <div>
              <h2 className={styles.stepTitle}>Folder to watch</h2>
              <p className={styles.stepDescription}>
                MySort only looks at files directly inside this folder. Subfolders, folders themselves, hidden
                files and in-progress downloads are always left alone.
              </p>
            </div>
          </div>

          {folder ? (
            <div className={styles.folderCard}>
              <span className={styles.folderIcon} aria-hidden="true">
                <FolderOpen size={17} />
              </span>
              <div className={styles.folderText}>
                <span className={styles.folderLabel}>{modeLabel(folder.mode)}</span>
                <span className={styles.folderPath} title={folder.path}>
                  {folder.path}
                </span>
              </div>
              <StatusPill tone={folder.state === 'watching' ? 'success' : folder.state === 'paused' ? 'warning' : 'danger'} size="sm">
                {folder.state === 'watching' ? 'Watching' : folder.state === 'paused' ? 'Paused' : folder.state}
              </StatusPill>
              <Button
                variant="quiet"
                size="sm"
                iconOnly
                onClick={() => void removeFolder()}
                disabled={picking}
                aria-label="Stop watching this folder"
                title="Stop watching this folder"
              >
                <X size={14} />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.picker}
              onClick={() => void chooseFolder()}
              disabled={picking || loading}
            >
              {picking ? <Loader2 size={17} className={styles.spin} /> : <FolderOpen size={17} />}
              <span>
                <span className={styles.pickerTitle}>{picking ? 'Waiting for the folder picker…' : 'Choose a folder'}</span>
                <span className={styles.pickerHint}>Opens the standard Windows folder dialog</span>
              </span>
            </button>
          )}

          {folder && (
            <Button variant="ghost" size="sm" onClick={() => void chooseFolder()} disabled={picking}>
              <FolderOpen size={13} /> Watch a different folder
            </Button>
          )}

          {error && <Notice tone="danger" icon={<X size={15} />}>{error}</Notice>}

          <div className={styles.actions}>
            <Button
              variant="primary"
              size="lg"
              onClick={() => void handlePrimary()}
              loading={starting || (picking && ready)}
              disabled={picking && !ready}
            >
              {!ready ? (
                <>
                  <FolderOpen size={16} /> Choose a folder
                </>
              ) : (
                <>
                  <Play size={16} /> {alreadyOn ? 'Resume monitoring' : 'Start monitoring'}
                </>
              )}
            </Button>
            {ready && (
              <span className={styles.actionsHint}>
                {folder.pendingCandidates > 0
                  ? `${folder.pendingCandidates} finished download${folder.pendingCandidates === 1 ? '' : 's'} already waiting`
                  : `Added ${formatRelative(folder.createdAt)}`}
              </span>
            )}
          </div>
        </Panel>

        <div className={styles.sideColumn}>
          <Panel tone="raised" title="What MySort will do">
            <ul className={styles.facts}>
              <li>
                <CheckCircle2 size={14} aria-hidden="true" />
                <div>
                  <strong>Waits for downloads to finish</strong>
                  <p>Files still being written are never touched.</p>
                </div>
              </li>
              <li>
                <CheckCircle2 size={14} aria-hidden="true" />
                <div>
                  <strong>Shows you before it moves anything</strong>
                  <p>Review the plan, then approve the files you want moved.</p>
                </div>
              </li>
              <li>
                <CheckCircle2 size={14} aria-hidden="true" />
                <div>
                  <strong>Can always be undone</strong>
                  <p>Every move is logged and reversible from History.</p>
                </div>
              </li>
            </ul>
          </Panel>

          <Panel tone="raised" title="What it will never do">
            <ul className={[styles.facts, styles.factsMuted].join(' ')}>
              <li>
                <X size={14} aria-hidden="true" />
                <div>
                  <strong>Touch folders or hidden files</strong>
                  <p>Only loose files in the chosen folder are considered.</p>
                </div>
              </li>
              <li>
                <X size={14} aria-hidden="true" />
                <div>
                  <strong>Move anything outside the destination root</strong>
                  <p>System and app folders are blocked outright.</p>
                </div>
              </li>
              <li>
                <X size={14} aria-hidden="true" />
                <div>
                  <strong>Send data anywhere</strong>
                  <p>No network access, no telemetry, no cloud sync.</p>
                </div>
              </li>
            </ul>
          </Panel>

          <p className={styles.privacy}>
            <ShieldCheck size={14} aria-hidden="true" />
            {alreadyOn
              ? 'Setup is complete. You can revisit this page at any time.'
              : 'Setup takes one step. You can change the folder later in Settings.'}
          </p>
        </div>
      </div>
    </>
  )
}

export default SetupScreen
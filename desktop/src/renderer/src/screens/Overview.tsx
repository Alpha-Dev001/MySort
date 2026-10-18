import React, { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpRight,
  FolderInput,
  FolderOpen,
  Inbox,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react'
import type { ApplicationSettings, OverviewStats } from '../../../shared/types'
import type { Route } from '../routes'
import { api } from '../api'
import Button from '../components/Button'
import DataTable, { type Column } from '../components/DataTable'
import PageHeader from '../components/PageHeader'
import Panel, { Stat } from '../components/Panel'
import StatusPill from '../components/StatusPill'
import { EmptyState, ErrorState, LoadingState, Notice, SkeletonCards } from '../components/States'
import {
  fileExtension,
  folderStateLabel,
  folderStateTone,
  formatCount,
  formatRelative,
  monitoringShortLabel,
  monitoringTone,
  operationLabel,
  operationTone,
  pluralize,
  shortenPath,
} from '../lib/format'
import styles from './Overview.module.css'

const Overview: React.FC<{ onNavigate?: (route: Route) => void }> = ({ onNavigate }) => {
  const [stats, setStats] = useState<OverviewStats | null>(null)
  const [settings, setSettings] = useState<ApplicationSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true)
    const res = await api.overview.get()
    if (res.ok) {
      setStats(res.data)
      setError(null)
    } else {
      setError(res.error.message)
    }
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    void load()
    void (async () => {
      const s = await api.settings.get()
      if (s.ok) setSettings(s.data)
    })()

    const unsubs = [
      api.onMonitoringStatus(() => void load(true)),
      api.onOperationUpdated(() => void load(true)),
    ]
    return () => unsubs.forEach((u) => u())
  }, [load])

  const monitoring = stats?.monitoring ?? null
  const folders = monitoring?.folders ?? []
  const watching = folders.filter((f) => f.state === 'watching')
  const unwatched = folders.length - watching.length
  const emptyFolders = folders.length === 0
  const needsSetup = settings !== null && !settings.onboardingCompleted
  const attention = stats?.needsAttention ?? 0

  const recentColumns: Column<OverviewStats['recent'][number]>[] = [
    {
      key: 'file',
      header: 'File',
      width: '34%',
      cell: (op) => (
        <span className={styles.fileCell}>
          <span className={styles.ext} aria-hidden="true">
            {(fileExtension(op.fileName).slice(1) || 'file').toUpperCase().slice(0, 4)}
          </span>
          <span className={styles.fileName} title={op.fileName}>
            {op.fileName}
          </span>
        </span>
      ),
    },
    {
      key: 'dest',
      header: 'Moved to',
      width: '34%',
      cell: (op) => (
        <span className={styles.destCell} title={op.finalDestPath ?? op.plannedDestPath}>
          {shortenPath(op.finalDestPath ?? op.plannedDestPath, 40)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '16%',
      cell: (op) => (
        <StatusPill tone={operationTone(op.status)} size="sm">
          {operationLabel(op.status)}
        </StatusPill>
      ),
    },
    {
      key: 'when',
      header: 'When',
      width: '16%',
      align: 'end',
      cell: (op) => (
        <span className={styles.muted}>{formatRelative(op.finishedAt ?? op.createdAt)}</span>
      ),
    },
  ]

  // The header always keeps its two controls: the secondary slot is the
  // always-available refresh, the primary slot appears only when there is
  // something that needs a decision, so the button row stays balanced without
  // ever showing two "do nothing" buttons.
  const headerAction = (
    <>
      <Button variant="secondary" onClick={() => void load(true)} loading={refreshing}>
        <RefreshCw size={14} /> Refresh
      </Button>
      {attention > 0 && (
        <Button variant="primary" onClick={() => onNavigate?.('history')}>
          <ScanSearch size={15} /> Review {formatCount(attention)} {pluralize(attention, 'file')}
        </Button>
      )}
    </>
  )

  const today = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

  if (loading) {
    return (
      <>
        <PageHeader description="What MySort has been doing." />
        <SkeletonCards count={3} height={96} />
        <Panel tone="raised" flush title="Recent activity" description="The last few moves MySort made.">
          <LoadingState label="Loading your activity" />
        </Panel>
      </>
    )
  }

  if (error || !stats || !monitoring) {
    return (
      <>
        <PageHeader />
        <ErrorState title="MySort could not load your overview" message={error} onRetry={() => void load()} />
      </>
    )
  }

  return (
    <>
      <PageHeader
        description={
          attention > 0
            ? 'Some files need a decision from you.'
            : 'Everything is up to date.'
        }
        meta={
          <>
            <StatusPill tone={monitoringTone(monitoring.state)} size="sm">
              {monitoringShortLabel(monitoring.state)}
            </StatusPill>
            <span className={styles.metaText}>
              {folders.length === 0
                ? `No folders yet · ${today}`
                : `${formatCount(folders.length)} ${pluralize(folders.length, 'folder')} watched · ${today}`}
            </span>
          </>
        }
        actions={headerAction}
      />

      {/* ---- first run: the only genuinely required setup step ---------- */}
      {needsSetup && (
        <Notice
          tone="brand"
          icon={<FolderOpen size={16} />}
          title="MySort isn't watching a folder yet"
          action={
            <Button variant="primary" size="sm" onClick={() => onNavigate?.('onboarding')}>
              Choose a folder
            </Button>
          }
        >
          Pick the folder MySort should watch and it will start sorting finished downloads automatically.
        </Notice>
      )}

      {/* ---- summary row ------------------------------------------------------
           Three distinct tiles in one row: what happened today, what is
           wrong, and what is being watched. The fact tiles stay still; the
           tiles that map to a next step are buttons. */}
      <div className={styles.stats}>
        <Stat
          label="Sorted today"
          value={formatCount(stats.sortedToday)}
          hint={stats.sortedToday === 1 ? 'file' : 'files'}
          tone="brand"
          icon={<FolderInput size={13} />}
        />
        <Stat
          label="Needs attention"
          value={formatCount(attention)}
          hint={attention === 0 ? 'nothing to fix' : 'failed or unreviewed'}
          tone={attention > 0 ? 'warning' : 'neutral'}
          icon={<AlertTriangle size={13} />}
          onClick={attention > 0 ? () => onNavigate?.('history') : undefined}
        />
        <Stat
          label="Watched folders"
          value={emptyFolders ? '—' : `${formatCount(watching.length)}/${formatCount(folders.length)}`}
          hint={
            emptyFolders
              ? 'none yet'
              : unwatched === 0
                ? 'all watching'
                : `${formatCount(unwatched)} paused or offline`
          }
          icon={<FolderOpen size={13} />}
          onClick={() => onNavigate?.(emptyFolders ? 'onboarding' : 'settings')}
        />
      </div>

      {/* ---- primary content ---------------------------------------------- */}
      <Panel
        tone="raised"
        flush
        title="Recent activity"
        description="The last few moves MySort made."
        actions={
          <Button variant="ghost" size="sm" onClick={() => onNavigate?.('history')}>
            View all <ArrowUpRight size={13} />
          </Button>
        }
      >
        <DataTable
          caption="Recent file activity"
          columns={recentColumns}
          rows={stats.recent}
          rowKey={(op) => op.id}
          onRowClick={() => onNavigate?.('history')}
          empty={
            <EmptyState
              tone="brand"
              icon={<Inbox size={20} />}
              title="No files have been sorted yet"
              description={
                folders.length === 0
                  ? 'Choose a folder to watch, then finished downloads will appear here.'
                  : 'Finished downloads will show up here as MySort moves them into place.'
              }
              action={
                folders.length === 0 ? (
                  <Button variant="primary" size="sm" onClick={() => onNavigate?.('onboarding')}>
                    Choose a folder
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => onNavigate?.('rules')}>
                    Review your rules
                  </Button>
                )
              }
            />
          }
        />
      </Panel>

      {/* ---- watched folders ----------------------------------------------- */}
      <Panel tone="raised" title="Watched folders">
        {emptyFolders ? (
          <EmptyState
            tone="brand"
            icon={<FolderOpen size={20} />}
            title="No folders are being watched"
            description="Pick the folder MySort should watch and sorting starts automatically."
            action={
              <Button variant="primary" size="sm" onClick={() => onNavigate?.('onboarding')}>
                Choose a folder
              </Button>
            }
          />
        ) : (
          <ul className={styles.folderList}>
            {folders.map((f) => (
              <li key={f.folderId} className={styles.folderRow}>
                <FolderOpen size={14} className={styles.folderIcon} aria-hidden="true" />
                <span className={styles.folderPath} title={f.path}>
                  {shortenPath(f.path, 58)}
                </span>
                {f.pendingCandidates > 0 && (
                  <span className={styles.folderPending}>
                    {formatCount(f.pendingCandidates)} waiting
                  </span>
                )}
                <StatusPill tone={folderStateTone(f.state)} size="sm">
                  {folderStateLabel(f.state)}
                </StatusPill>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ---- local-first reassurance --------------------------------------- */}
      <p className={styles.footnote}>
        <ShieldCheck size={13} aria-hidden="true" />
        MySort works entirely on this computer. Nothing is uploaded, and the app never makes a network request.
      </p>
    </>
  )
}

export default React.memo(Overview)

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  ExternalLink,
  FolderOpen,
  Info,
  Lock,
  RefreshCw,
  RotateCcw,
  TimerOff,
  Undo2,
} from 'lucide-react'
import type { FileOperation, HistoryPage, OperationStatus } from '../../../shared/types'
import type { Route } from '../routes'
import { api } from '../api'
import Button from '../components/Button'
import DataTable, { type Column } from '../components/DataTable'
import { SearchInput, Segmented } from '../components/Field'
import PageHeader from '../components/PageHeader'
import Pagination from '../components/Pagination'
import Panel from '../components/Panel'
import StatusPill from '../components/StatusPill'
import { DetailRow, Drawer } from '../components/Dialog'
import { EmptyState, ErrorState, LoadingState, Notice } from '../components/States'
import { useConfirm } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { useDebounced } from '../lib/hooks'
import {
  canUndo,
  dirName,
  fileExtension,
  formatBytes,
  formatCount,
  formatDateTime,
  formatRelative,
  operationLabel,
  operationTone,
  pluralize,
  shortenPath,
  undoLabel,
} from '../lib/format'
import styles from './History.module.css'

type Filter = OperationStatus | 'all'
type Range = '7' | '30' | '90' | 'all'

const RANGE_DAYS: Record<Range, number | null> = { '7': 7, '30': 30, '90': 90, all: null }

const DEFAULT_PAGE_SIZE = 10
const PAGE_SIZES = [10, 25, 50, 100]

const HistoryScreen: React.FC<{ onNavigate?: (route: Route) => void }> = ({ onNavigate }) => {
  const toast = useToast()
  const confirm = useConfirm()

  const [page, setPage] = useState<HistoryPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounced(query, 260)
  const [status, setStatus] = useState<Filter>('all')
  const [range, setRange] = useState<Range>('30')

  const [detail, setDetail] = useState<FileOperation | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pageIndex, setPageIndex] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  /** Moves that arrived while the user was reading a later page. */
  const [newerCount, setNewerCount] = useState(0)

  const tableRef = useRef<HTMLDivElement>(null)

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (opts.silent) setRefreshing(true)
      else setLoading(true)

      const res = await api.history.list({
        query: debouncedQuery.trim() || undefined,
        status,
        ...dateWindow(RANGE_DAYS[range]),
        offset: (pageIndex - 1) * pageSize,
        limit: pageSize,
      })

      if (res.ok) {
        const data = res.data as HistoryPage
        // The page we asked for can stop existing: retention prunes old rows, or
        // a filter narrows. Step back to the last real page instead of showing
        // an empty table that looks like the history was deleted.
        const lastPage = Math.max(1, Math.ceil(data.total / pageSize))
        if (pageIndex > lastPage) {
          setPageIndex(lastPage)
        } else {
          setPage(data)
          setError(null)
        }
      } else {
        setError(res.error.message)
      }
      setLoading(false)
      setRefreshing(false)
    },
    [debouncedQuery, status, range, pageIndex, pageSize],
  )

  useEffect(() => {
    void load()
  }, [load])

  // Any filter change invalidates the page number: page 7 of the old result set
  // means nothing in the new one. Reset here, at the point of change, so the
  // two state updates land in one render and cost a single request.
  const changeQuery = useCallback((next: string) => {
    setQuery(next)
    setPageIndex(1)
    setNewerCount(0)
  }, [])
  const changeStatus = useCallback((next: Filter) => {
    setStatus(next)
    setPageIndex(1)
    setNewerCount(0)
  }, [])
  const changeRange = useCallback((next: Range) => {
    setRange(next)
    setPageIndex(1)
    setNewerCount(0)
  }, [])
  const changePageSize = useCallback((next: number) => {
    setPageSize(next)
    setPageIndex(1)
  }, [])

  /**
   * Refs so the live subscription is registered once.
   *
   * As a plain effect dependency `load` changes on every keystroke and every
   * filter change, which tore down and rebuilt the IPC listener each time.
   */
  const loadRef = useRef(load)
  loadRef.current = load
  const pageIndexRef = useRef(pageIndex)
  pageIndexRef.current = pageIndex

  // Keep the list live without moving it under the reader. On the first page
  // new moves belong at the top anyway, so a silent refresh is invisible. On a
  // later page, refreshing would shift every row and re-read what they already
  // read — so they get a count and a button instead.
  useEffect(() => {
    let queued: ReturnType<typeof setTimeout> | null = null
    const unsub = api.onOperationUpdated(() => {
      if (queued) clearTimeout(queued)
      queued = setTimeout(() => {
        if (pageIndexRef.current === 1) void loadRef.current({ silent: true })
        else setNewerCount((n) => n + 1)
      }, 600)
    })
    return () => {
      if (queued) clearTimeout(queued)
      unsub()
    }
  }, [])

  /** Page change: start the new page at its first row, and keep it in view. */
  const goToPage = useCallback((next: number) => {
    setPageIndex(next)
    setNewerCount(0)
    tableRef.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  const showNewest = useCallback(() => {
    setNewerCount(0)
    setPageIndex(1)
    tableRef.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  const retry = useCallback(
    async (op: FileOperation) => {
      setBusyId(op.id)
      const res = await api.history.retry({ operationId: op.id })
      setBusyId(null)
      if (res.ok) {
        toast.push({ kind: 'success', title: 'Move completed', description: op.fileName })
        setDetail(null)
        await load({ silent: true })
      } else {
        toast.push({
          kind: 'error',
          title: 'Could not finish that move',
          description: res.error.message,
        })
      }
    },
    [load, toast],
  )

  const undo = useCallback(
    async (op: FileOperation) => {
      const ok = await confirm({
        title: `Undo the move of “${op.fileName}”?`,
        description: 'The file goes back where it came from. If something already occupies the original name, MySort renames the returning file instead of overwriting anything.',
        confirmLabel: 'Undo move',
      })
      if (!ok) return
      setBusyId(op.id)
      const res = await api.history.undo({ operationId: op.id })
      setBusyId(null)
      if (res.ok) {
        const r = res.data
        if (r.status === 'done') {
          toast.push({ kind: 'success', title: 'Move undone', description: op.fileName })
        } else {
          toast.push({
            kind: 'warning',
            title: 'Undo was blocked',
            description: r.error?.message ?? 'The file has changed since it was moved.',
          })
        }
        setDetail(null)
        await load({ silent: true })
      } else {
        toast.push({ kind: 'error', title: 'Could not undo', description: res.error.message })
      }
    },
    [confirm, load, toast],
  )

  const reveal = useCallback(
    async (op: FileOperation, which: 'source' | 'destination') => {
      const res = await api.history.showInFolder({ operationId: op.id, which })
      if (!res.ok) {
        toast.push({ kind: 'warning', title: 'Cannot show that file', description: res.error.message })
      }
    },
    [toast],
  )

  const items = page?.items ?? []
  const total = page?.total ?? 0

  /**
   * The status chips double as the status filter and always describe the
   * whole date/search window — so "Completed 96 · Failed 1" reads as a normal
   * week at a glance instead of an alarm. Statuses with nothing in them stay
   * invisible: an empty page should never advertise problems it does not have.
   */
  const chips = useMemo(() => {
    const statusCounts = page?.statusCounts
    const allTotal = statusCounts
      ? Object.values(statusCounts).reduce<number>((a, b) => a + (b ?? 0), 0)
      : status === 'all'
        ? total
        : undefined
    const list: { value: Filter; label: string; count?: number; attention?: boolean }[] = [
      { value: 'all', label: 'All', count: allTotal },
    ]
    const shown: OperationStatus[] = ['completed', 'needs_review', 'failed', 'skipped']
    for (const s of shown) {
      const n = statusCounts?.[s]
      if ((n !== undefined && n > 0) || status === s) {
        list.push({ value: s, label: operationLabel(s), count: n, attention: s === 'failed' })
      }
    }
    return list
  }, [page, status, total])

  const columns: Column<FileOperation>[] = [
    {
      key: 'file',
      header: 'File',
      width: '30%',
      cell: (op) => (
        <div className={styles.fileCell}>
          <span className={styles.ext} aria-hidden="true">
            {(fileExtension(op.fileName).slice(1) || 'file').toUpperCase().slice(0, 4)}
          </span>
          <span className={styles.fileText}>
            <span className={styles.fileName}>{op.fileName}</span>
            <span className={styles.fileFrom}>{dirName(op.sourcePath) || '—'}</span>
          </span>
        </div>
      ),
    },
    {
      key: 'to',
      header: 'Moved to',
      width: '26%',
      cell: (op) => (
        <code className={styles.dest} title={op.finalDestPath ?? op.plannedDestPath}>
          {shortenPath(op.finalDestPath ?? op.plannedDestPath, 38)}
        </code>
      ),
    },
    {
      key: 'rule',
      header: 'Rule',
      width: '13%',
      cell: (op) => <span className={styles.rule}>{op.ruleLabel || 'Default'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: '11%',
      cell: (op) => (
        <StatusPill tone={operationTone(op.status)} size="sm">
          {operationLabel(op.status)}
        </StatusPill>
      ),
    },
    {
      key: 'when',
      header: 'When',
      width: '9%',
      align: 'end',
      cell: (op) => (
        <span className={styles.muted} title={formatDateTime(op.finishedAt ?? op.createdAt)}>
          {formatRelative(op.finishedAt ?? op.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      width: '18%',
      align: 'end',
      cell: (op) => (
        <div className={styles.actions}>
          {op.status === 'failed' && (
            <Button variant="secondary" size="sm" onClick={() => void retry(op)} loading={busyId === op.id}>
              <RotateCcw size={12} /> Retry
            </Button>
          )}
          {op.status === 'completed' && canUndo(op.undo.status) && (
            <Button variant="secondary" size="sm" onClick={() => void undo(op)} loading={busyId === op.id}>
              <Undo2 size={12} /> Undo
            </Button>
          )}
          {op.status === 'completed' && !canUndo(op.undo.status) && (
            <span className={styles.noUndo} title={undoLabel(op.undo.status)}>
              {op.undo.status === 'done' ? <Undo2 size={13} aria-hidden="true" /> : null}
              {op.undo.status === 'not_eligible' ? <Lock size={13} aria-hidden="true" /> : null}
              {op.undo.status === 'expired' || op.undo.status === 'blocked' ? (
                <TimerOff size={13} aria-hidden="true" />
              ) : null}
            </span>
          )}
          <Button variant="quiet" size="sm" iconOnly onClick={() => setDetail(op)} aria-label={`Details for ${op.fileName}`} title="Details">
            <Info size={13} />
          </Button>
        </div>
      ),
    },
  ]

  const filtering = debouncedQuery.trim() !== '' || status !== 'all' || range !== 'all'

  return (
    <>
      <PageHeader
        description="Every move MySort has made, newest first. Anything undone or retried stays here for the record."
        meta={
          total > 0 ? (
            <StatusPill tone="neutral" size="sm">
              {formatCount(total)} recorded {pluralize(total, 'move')}
            </StatusPill>
          ) : undefined
        }
      />

      <Panel tone="raised" flush>
        {/* ---- status summary + filter: the same quiet chips ------------- */}
        <div className={styles.statsRow} role="group" aria-label="Filter history by status">
          {chips.map((chip) => (
            <button
              key={chip.value}
              type="button"
              className={styles.statChip}
              data-active={status === chip.value || undefined}
              aria-pressed={status === chip.value}
              onClick={() => changeStatus(chip.value)}
            >
              <span className={styles.statLabel}>{chip.label}</span>
              {chip.count !== undefined && (
                <span className={styles.statCount} data-attention={chip.attention || undefined}>
                  {formatCount(chip.count)}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className={styles.toolbar}>
          <SearchInput
            className={styles.search}
            value={query}
            onValueChange={changeQuery}
            placeholder="Search by file name…"
            aria-label="Search history"
          />
          <Segmented
            ariaLabel="Filter by date"
            value={range}
            onChange={changeRange}
            options={[
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
              { value: 'all', label: 'All' },
            ]}
          />
          <Button
            variant="ghost"
            size="sm"
            className={styles.refresh}
            onClick={() => void load({ silent: true })}
            loading={refreshing}
            aria-label="Refresh history"
          >
            {!refreshing && <RefreshCw size={14} />}
            Refresh
          </Button>
        </div>

        {newerCount > 0 && (
          <div className={styles.newerBar} role="status">
            <span>
              {formatCount(newerCount)} newer {pluralize(newerCount, 'move')} since you opened this page
            </span>
            <Button variant="secondary" size="sm" onClick={showNewest}>
              <ArrowUp size={13} /> Show them
            </Button>
          </div>
        )}

        <div ref={tableRef} className={loading && page ? styles.tableBusy : undefined} aria-busy={loading || undefined}>
          {loading && !page ? (
            <div className={styles.tableWrap}>
              <LoadingState label="Loading history" />
            </div>
          ) : error ? (
            <div className={styles.tableWrap}>
              <ErrorState message={error} onRetry={() => void load()} />
            </div>
          ) : (
            <>
              <DataTable
                caption="File move history"
                columns={columns}
                rows={items}
                rowKey={(op) => op.id}
                onRowClick={(op) => setDetail(op)}
                maxHeight="min(64vh, 560px)"
                resetScrollKey={`${pageIndex}-${status}-${range}-${debouncedQuery}`}
                empty={
                  <EmptyState
                    icon={<FolderOpen size={17} />}
                    title={filtering ? 'Nothing matches those filters' : 'No moves recorded yet'}
                    description={
                      filtering
                        ? 'Try a different search term, or widen the status and date filters.'
                        : 'Once MySort starts moving files, each move will appear here with the option to undo it.'
                    }
                    action={
                      filtering ? (
                        <Button
                          variant="secondary"
                          onClick={() => {
                            changeQuery('')
                            changeStatus('all')
                            changeRange('all')
                          }}
                        >
                          Clear filters
                        </Button>
                      ) : (
                        <Button variant="primary" onClick={() => onNavigate?.('rules')}>
                          Go to rules
                        </Button>
                      )
                    }
                  />
                }
              />

              <Pagination
                page={pageIndex}
                pageSize={pageSize}
                pageSizeOptions={PAGE_SIZES}
                total={total}
                itemCount={items.length}
                unit="move"
                busy={loading || refreshing}
                onPageChange={goToPage}
                onPageSizeChange={changePageSize}
              />
            </>
          )}
        </div>
      </Panel>

      <Drawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.fileName ?? ''}
        description={detail ? `${operationLabel(detail.status)} · ${formatDateTime(detail.finishedAt ?? detail.createdAt)}` : undefined}
        footer={
          detail && (
            <>
              {detail.status === 'completed' && (
                <Button variant="secondary" onClick={() => void reveal(detail, 'destination')}>
                  <ExternalLink size={14} /> Show in folder
                </Button>
              )}
              {detail.status !== 'completed' && (
                <Button variant="primary" onClick={() => void retry(detail)} loading={busyId === detail.id}>
                  <RotateCcw size={14} /> Retry this move
                </Button>
              )}
            </>
          )
        }
      >
        {detail && (
          <>
            {detail.error && (
              <Notice tone="danger" icon={<AlertTriangle size={15} />} title={detail.error.code}>
                {detail.error.message}
              </Notice>
            )}

            <dl className={styles.details}>
              <DetailRow label="Status">
                <StatusPill tone={operationTone(detail.status)} size="sm">
                  {operationLabel(detail.status)}
                </StatusPill>
              </DetailRow>
              <DetailRow label="Size">{formatBytes(detail.sizeBytes)}</DetailRow>
              <DetailRow label="Rule">{detail.ruleLabel || 'Default'}</DetailRow>
              <DetailRow label="Trigger">{detail.initiatedBy}</DetailRow>
              <DetailRow label="Undo">{undoLabel(detail.undo.status)}</DetailRow>
              {detail.explanation && <DetailRow label="Reason">{detail.explanation}</DetailRow>}
              <DetailRow label="From" mono>
                {detail.sourcePath}
              </DetailRow>
              <DetailRow label="Planned to" mono>
                {detail.plannedDestPath}
              </DetailRow>
              {detail.finalDestPath && (
                <DetailRow label="Actually at" mono>
                  {detail.finalDestPath}
                </DetailRow>
              )}
            </dl>

            <div className={styles.drawerActions}>
              <Button variant="ghost" size="sm" onClick={() => void reveal(detail, 'source')}>
                <FolderOpen size={13} /> Show original
              </Button>
              {detail.status === 'completed' && canUndo(detail.undo.status) && (
                <Button variant="secondary" size="sm" onClick={() => void undo(detail)}>
                  <Undo2 size={13} /> Undo this move
                </Button>
              )}
            </div>
          </>
        )}
      </Drawer>
    </>
  )
}

function dateWindow(days: number | null): { from?: string; to?: string } {
  if (days === null) return {}
  const to = new Date()
  to.setHours(23, 59, 59, 999)
  const from = new Date(to.getTime() - days * 86_400_000)
  from.setHours(0, 0, 0, 0)
  return { from: from.toISOString(), to: to.toISOString() }
}

export default HistoryScreen

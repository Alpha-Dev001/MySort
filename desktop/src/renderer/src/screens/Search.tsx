import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FolderOpen,
  FileSearch,
  FolderSearch,
  RefreshCw,
  Trash2,
  Info,
  HardDriveDownload,
  Square,
  X,
} from 'lucide-react'
import type { IndexedFile, IndexScope, IndexStatus, SearchQuery, SearchSort, SortOrder } from '../../../shared/types'
import { api } from '../api'
import Button from '../components/Button'
import DataTable, { type Column } from '../components/DataTable'
import { Field, SearchInput, Segmented, Select, TextInput } from '../components/Field'
import { Drawer, DetailRow } from '../components/Dialog'
import PageHeader from '../components/PageHeader'
import Pagination from '../components/Pagination'
import Panel, { Section } from '../components/Panel'
import StatusPill from '../components/StatusPill'
import { EmptyState, ErrorState, LoadingState, Notice } from '../components/States'
import Toggle from '../components/Toggle'
import { useToast } from '../components/Toast'
import { useDebounced } from '../lib/hooks'
import { formatBytes, formatCount, formatDateTime, formatRelative, pluralize, shortenPath } from '../lib/format'
import styles from './Search.module.css'

const PAGE_SIZE = 25

/** File types that are commonly worth keeping out of a metadata index. */
const COMMON_EXCLUSIONS = ['exe', 'msi', 'iso', 'zip', '7z', 'rar', 'mp4', 'mkv', 'mov'] as const

type DateFilter = 'any' | 'today' | 'week' | 'month' | 'quarter' | 'year'

const DATE_FILTERS: readonly { value: DateFilter; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
  { value: 'quarter', label: 'Last 3 months' },
  { value: 'year', label: 'Last year' },
]

const SORT_OPTIONS: readonly { value: SearchSort; label: string }[] = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'name', label: 'Name' },
  { value: 'modified', label: 'Date modified' },
  { value: 'size', label: 'Size' },
]

/** Start of the relative period, in epoch milliseconds. */
function periodStart(period: DateFilter): number | null {
  if (period === 'any') return null
  const now = new Date()
  const start = new Date(now)
  switch (period) {
    case 'today':
      start.setHours(0, 0, 0, 0)
      break
    case 'week':
      start.setDate(start.getDate() - 7)
      break
    case 'month':
      start.setMonth(start.getMonth() - 1)
      break
    case 'quarter':
      start.setMonth(start.getMonth() - 3)
      break
    case 'year':
      start.setFullYear(start.getFullYear() - 1)
      break
  }
  return start.getTime()
}

/**
 * The local search screen.
 *
 * Everything it shows comes from the on-device metadata index. The index is
 * a cache of file names, sizes and timestamps — MySort reads metadata only,
 * never file contents, and nothing leaves the machine.
 */
const SearchScreen: React.FC = () => {
  const toast = useToast()

  const [text, setText] = useState('')
  const [fuzzy, setFuzzy] = useState(false)
  const [extension, setExtension] = useState('')
  const [dateFilter, setDateFilter] = useState<DateFilter>('any')
  const [sizeMin, setSizeMin] = useState('')
  const [sizeMax, setSizeMax] = useState('')
  const [sort, setSort] = useState<SearchSort>('modified')
  const [order, setOrder] = useState<SortOrder>('desc')
  const [page, setPage] = useState(1)

  const [items, setItems] = useState<IndexedFile[]>([])
  const [total, setTotal] = useState(0)
  const [tookMs, setTookMs] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [scope, setScope] = useState<IndexScope | null>(null)
  const [status, setStatus] = useState<IndexStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<IndexedFile | null>(null)
  const [excludedPath, setExcludedPath] = useState('')

  const debouncedText = useDebounced(text, 250)
  const requestSeq = useRef(0)

  // The index pushes its status; the screen does not poll for it.
  useEffect(() => {
    const unsubscribe = api.onIndexStatus((next) => setStatus(next))
    void api.search.status().then((r) => {
      if (r.ok) setStatus(r.data)
    })
    void api.search.scope().then((r) => {
      if (r.ok) setScope(r.data)
    })
    return unsubscribe
  }, [])

  const query = useMemo<SearchQuery>(() => {
    const after = periodStart(dateFilter)
    const min = Number.parseInt(sizeMin, 10)
    const max = Number.parseInt(sizeMax, 10)
    return {
      text: debouncedText.trim().length > 0 ? debouncedText.trim() : undefined,
      fuzzy: fuzzy || undefined,
      extensions:
        extension.trim().length > 0
          ? extension
              .split(/[\s,]+/)
              .map((e) => e.trim().replace(/^\.+/, '').toLowerCase())
              .filter((e) => e.length > 0)
          : undefined,
      sizeMin: Number.isFinite(min) ? min : null,
      sizeMax: Number.isFinite(max) ? max : null,
      modifiedAfter: after,
      sort,
      order,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }
  }, [debouncedText, fuzzy, extension, sizeMin, sizeMax, dateFilter, sort, order, page])

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    const result = await api.search.query(query)
    // A slower response must never overwrite a newer one.
    if (seq !== requestSeq.current) return
    setLoading(false)
    if (result.ok) {
      setItems(result.data.items)
      setTotal(result.data.total)
      setTookMs(result.data.tookMs)
      setError(null)
    } else {
      setError(result.error.message)
    }
  }, [query])

  useEffect(() => {
    void load()
  }, [load])

  // Any filter change returns to the first page.
  useEffect(() => {
    setPage(1)
  }, [debouncedText, fuzzy, extension, sizeMin, sizeMax, dateFilter, sort, order])

  const startIndex = useCallback(async (rebuild: boolean) => {    setBusy(true)
    const result = await api.search.start({ rebuild })
    setBusy(false)
    if (result.ok) {
      setStatus(result.data)
      toast.push({
        kind: 'info',
        title: rebuild ? 'Rebuilding the index' : 'Indexing started',
        description: 'MySort is reading file names and sizes in the background.',
      })
    } else {
      toast.push({ kind: 'error', title: 'Could not start indexing', description: result.error.message })
    }
  }, [toast])

  const cancelIndex = useCallback(async () => {
    const result = await api.search.cancel()
    if (result.ok) setStatus(result.data)
  }, [])

  const clearIndex = useCallback(async () => {
    const result = await api.search.clear()
    if (result.ok) {
      setStatus(result.data)
      setItems([])
      setTotal(0)
      toast.push({
        kind: 'info',
        title: 'Index cleared',
        description: 'Nothing on disk was changed — only the index was removed.',
      })
    }
  }, [toast])

  const saveScope = useCallback(
    async (next: IndexScope) => {
      const result = await api.search.setScope({ scope: next })
      if (result.ok) {
        setScope(result.data)
        toast.push({ kind: 'info', title: 'Indexing scope updated' })
      } else {
        toast.push({
          kind: 'error',
          title: 'Could not change the scope',
          description: result.error.message,
        })
      }
    },
    [toast]
  )

  const addRoot = useCallback(async () => {
    const grant = await api.folders.pick('index')
    if (!grant.ok) return
    if (!scope) return
    const path = grant.data.displayName
    if (scope.roots.some((r) => r.toLowerCase() === path.toLowerCase())) {
      toast.push({ kind: 'info', title: 'That folder is already indexed' })
      return
    }
    await saveScope({ ...scope, roots: [...scope.roots, path] })
  }, [scope, saveScope, toast])

  const removeRoot = useCallback(
    async (root: string) => {
      if (!scope) return
      await saveScope({ ...scope, roots: scope.roots.filter((r) => r !== root) })
    },
    [scope, saveScope]
  )

  const addExcludedPath = useCallback(async () => {
    if (!scope || excludedPath.trim().length === 0) return
    await saveScope({ ...scope, excludedPaths: [...scope.excludedPaths, excludedPath.trim()] })
    setExcludedPath('')
  }, [scope, excludedPath, saveScope])

  const removeExcludedPath = useCallback(
    async (target: string) => {
      if (!scope) return
      await saveScope({
        ...scope,
        excludedPaths: scope.excludedPaths.filter((p) => p !== target),
      })
    },
    [scope, saveScope]
  )

  const toggleExcludedExtension = useCallback(
    async (ext: string) => {
      if (!scope) return
      const list = scope.excludedExtensions.includes(ext)
        ? scope.excludedExtensions.filter((e) => e !== ext)
        : [...scope.excludedExtensions, ext]
      await saveScope({ ...scope, excludedExtensions: list })
    },
    [scope, saveScope]
  )

  const openFile = useCallback(async (file: IndexedFile) => {
    const result = await api.search.open({ path: file.path })
    if (!result.ok) {
      toast.push({ kind: 'error', title: 'Could not open the file', description: result.error.message })
    }
  }, [toast])

  const revealFile = useCallback(async (file: IndexedFile) => {
    const result = await api.search.reveal({ path: file.path })
    if (!result.ok) {
      toast.push({ kind: 'error', title: 'Could not show the file', description: result.error.message })
    }
  }, [toast])

  const columns: Column<IndexedFile>[] = useMemo(
    () => [
      {
        key: 'name',
        header: 'File',
        width: '2.4fr',
        cell: (f) => (
          <div className={styles.name}>
            <span className={styles.extChip}>{f.ext ? f.ext.slice(0, 4) : '—'}</span>
            <span className={styles.fileName} title={f.name}>
              {f.name}
            </span>
          </div>
        ),
      },
      {
        key: 'where',
        header: 'Location',
        width: '1.8fr',
        cell: (f) => (
          <div className={styles.path} title={f.parentDir}>
            {shortenPath(f.parentDir, 46)}
          </div>
        ),
      },
      {
        key: 'size',
        header: 'Size',
        width: '0.8fr',
        align: 'end',
        cell: (f) => formatBytes(f.sizeBytes),
      },
      {
        key: 'modified',
        header: 'Modified',
        width: '0.9fr',
        align: 'end',
        cell: (f) => (
          <span title={formatDateTime(f.modifiedMs)}>{formatRelative(f.modifiedMs)}</span>
        ),
      },
      {
        key: 'actions',
        header: 'Actions',
        width: '0.9fr',
        align: 'end',
        cell: (f) => (
          <div className={styles.actions}>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              aria-label={`Open ${f.name}`}
              title="Open with the default application"
              onClick={() => void openFile(f)}
            >
              <FolderOpen size={14} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              aria-label={`Show ${f.name} in its folder`}
              title="Show in the folder"
              onClick={() => void revealFile(f)}
            >
              <FolderSearch size={14} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              aria-label={`Details for ${f.name}`}
              title="Details"
              onClick={() => setDetail(f)}
            >
              <Info size={14} />
            </Button>
          </div>
        ),
      },
    ],
    [openFile, revealFile]
  )

  const running = status?.running === true

  return (
    <>
      <PageHeader
        description="Find files on this computer by name, type, size or date. MySort reads file names and sizes only — never contents — and nothing leaves this machine."
        meta={
          status ? (
            <StatusPill tone={running ? 'brand' : 'neutral'} dot={running}>
              {running ? 'Indexing' : `${formatCount(status.totalIndexed)} files indexed`}
            </StatusPill>
          ) : null
        }
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => void load()} loading={loading}>
              <RefreshCw size={14} /> Refresh
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void startIndex(false)}
              loading={busy}
              disabled={running}
            >
              <HardDriveDownload size={14} /> Index folders
            </Button>
          </>
        }
      />

      <Section
        title="Search"
        description="Filters combine. Leave a field empty to ignore it."
      >
        <div className={styles.toolbar}>
          <div className={styles.toolbarSearch}>
            <SearchInput
              value={text}
              onValueChange={setText}
              placeholder="Search file names — e.g. report"
              aria-label="Search file names"
            />
          </div>
          <Segmented
            value={fuzzy ? 'fuzzy' : 'exact'}
            ariaLabel="Matching style"
            options={[
              { value: 'exact', label: 'Contains' },
              { value: 'fuzzy', label: 'Fuzzy' },
            ]}
            onChange={(v) => setFuzzy(v === 'fuzzy')}
          />
          <Select
            aria-label="Sort results by"
            value={sort}
            onChange={(e) => setSort(e.target.value as SearchSort)}
            options={SORT_OPTIONS}
          />
          <Segmented
            value={order}
            ariaLabel="Sort direction"
            options={[
              { value: 'desc', label: 'Newest' },
              { value: 'asc', label: 'Oldest' },
            ]}
            onChange={(v) => setOrder(v as SortOrder)}
          />
        </div>

        <div className={styles.filters}>
          <Field label="File type" block={false}>
            <TextInput
              className={styles.extInput}
              value={extension}
              onChange={(e) => setExtension(e.target.value)}
              placeholder="pdf, png…"
              monospace
              aria-label="File types"
            />
          </Field>
          <Field label="Modified" block={false}>
            <Select
              aria-label="Modified in"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value as DateFilter)}
              options={DATE_FILTERS}
            />
          </Field>
          <Field label="Minimum size (MB)" block={false}>
            <TextInput
              className={styles.extInput}
              value={sizeMin}
              onChange={(e) => setSizeMin(e.target.value)}
              inputMode="numeric"
              placeholder="0"
              aria-label="Minimum size in megabytes"
            />
          </Field>
          <Field label="Maximum size (MB)" block={false}>
            <TextInput
              className={styles.extInput}
              value={sizeMax}
              onChange={(e) => setSizeMax(e.target.value)}
              inputMode="numeric"
              placeholder="Any"
              aria-label="Maximum size in megabytes"
            />
          </Field>
        </div>

        {scope && scope.excludedPaths.length > 0 && (
          <Notice tone="info" title="Some folders are excluded from the index">
            {scope.excludedPaths.length} path{scope.excludedPaths.length === 1 ? '' : 's'} will never be
            read. Excluded folders stay untouched.
          </Notice>
        )}
      </Section>

      <Panel
        title="Results"
        description={
          total > 0
            ? `${formatCount(total)} ${pluralize(total, 'file')} · ${formatCount(tookMs)} ms`
            : undefined
        }
        actions={
          total > 0 ? (
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              itemCount={items.length}
              unit="file"
              onPageChange={setPage}
            />
          ) : undefined
        }
        flush
      >
        {error ? (
          <ErrorState title="The search could not run" message={error} onRetry={() => void load()} />
        ) : loading && items.length === 0 ? (
          <LoadingState label="Searching" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<FileSearch size={18} />}
            title="Nothing matched"
            description={
              status && status.totalIndexed === 0
                ? 'The index is empty. Choose the folders to index and run an index pass.'
                : 'Try a shorter search, or widen the filters.'
            }
            tone="brand"
          />
        ) : (
          <DataTable
            caption="Files matching your search"
            columns={columns}
            rows={items}
            rowKey={(f) => f.path}
            maxHeight="min(56vh, 520px)"
            resetScrollKey={page}
          />
        )}
      </Panel>

      <Section
        title="The local index"
        description="A private catalogue of file names, sizes and dates. It speeds up search and duplicate detection. Nothing is uploaded, and clearing it never deletes a file."
        actions={
          <>
            {running ? (
              <Button size="sm" variant="secondary" onClick={() => void cancelIndex()}>
                <Square size={13} /> Stop
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void startIndex(true)}
                disabled={busy}
              >
                <RefreshCw size={14} /> Rebuild
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void clearIndex()} disabled={running}>
              <Trash2 size={13} /> Clear
            </Button>
          </>
        }
      >
        <div className={styles.indexPanel}>
          {running && status && (
            <>
              <div className={styles.progress} role="progressbar" aria-label="Indexing progress">
                <div
                  className={styles.progressBar}
                  style={{ width: `${Math.min(100, Math.round((status.scanned / Math.max(1, status.indexed + status.scanned)) * 100))}%` }}
                />
              </div>
              <div className={styles.indexStats}>
                <span>{formatCount(status.scanned)} files read</span>
                <span>{formatCount(status.skipped)} skipped</span>
                {status.errors > 0 && <span>{formatCount(status.errors)} unreadable</span>}
                {status.currentRoot && <span className={styles.path}>{shortenPath(status.currentRoot, 40)}</span>}
              </div>
            </>
          )}
          {status?.message && <Notice tone="info">{status.message}</Notice>}
          <div className={styles.indexStats}>
            <span>{formatCount(status?.totalIndexed ?? 0)} files in the index</span>
            <span>{status?.startedAt ? `Started ${formatRelative(status.startedAt)}` : 'Not running'}</span>
          </div>
          {scope && scope.roots.length > 0 ? (
            <ul className={styles.roots}>
              {scope.roots.map((root) => (
                <li key={root} className={styles.root} title={root}>
                  <FolderOpen size={12} aria-hidden="true" />
                  <span className={styles.rootPath}>{root}</span>
                  <Button
                    size="sm"
                    variant="quiet"
                    iconOnly
                    aria-label={`Stop indexing ${root}`}
                    title="Stop indexing this folder"
                    onClick={() => void removeRoot(root)}
                  >
                    <X size={13} />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Notice tone="warning" title="No folders are indexed yet">
              Add a folder to the index before searching. MySort never reads a folder you have not
              chosen.
            </Notice>
          )}

          <div className={styles.scopeRow}>
            <Button size="sm" variant="secondary" onClick={() => void addRoot()}>
              <FolderOpen size={13} /> Add a folder
            </Button>
            <Toggle
              checked={scope?.excludeHidden !== false}
              onChange={(next) => {
                if (scope) void saveScope({ ...scope, excludeHidden: next })
              }}
              label="Skip hidden files and folders"
            />
          </div>

          <Field
            label="Never index these file types"
            help="MySort will not read the contents of these files, and will not list them in search."
          >
            <div className={styles.chipRow}>
              {COMMON_EXCLUSIONS.map((ext) => (
                <button
                  key={ext}
                  type="button"
                  className={styles.chip}
                  data-active={scope?.excludedExtensions.includes(ext) === true}
                  aria-pressed={scope?.excludedExtensions.includes(ext) === true}
                  onClick={() => void toggleExcludedExtension(ext)}
                >
                  .{ext}
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="Never index these folders"
            help="A folder listed here is skipped entirely, along with everything inside it."
          >
            <div className={styles.scopeRow}>
              <TextInput
                value={excludedPath}
                onChange={(e) => setExcludedPath(e.target.value)}
                placeholder="C:\\Users\\…\\Private"
                monospace
                aria-label="Folder to exclude from the index"
              />
              <Button size="sm" variant="secondary" onClick={() => void addExcludedPath()}>
                Exclude
              </Button>
            </div>
            {scope && scope.excludedPaths.length > 0 && (
              <ul className={styles.roots}>
                {scope.excludedPaths.map((p) => (
                  <li key={p} className={styles.root} title={p}>
                    <X size={12} aria-hidden="true" />
                    <span className={styles.rootPath}>{p}</span>
                    <Button
                      size="sm"
                      variant="quiet"
                      iconOnly
                      aria-label={`Stop excluding ${p}`}
                      title="Remove this exclusion"
                      onClick={() => void removeExcludedPath(p)}
                    >
                      <X size={13} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        </div>
      </Section>

      <Drawer
        open={detail !== null}
        title={detail?.name ?? ''}
        description={detail ? formatDateTime(detail.modifiedMs) : undefined}
        onClose={() => setDetail(null)}
        footer={
          detail ? (
            <Button size="sm" variant="secondary" onClick={() => void openFile(detail)}>
              <FolderOpen size={13} /> Open file
            </Button>
          ) : null
        }
      >
        {detail && (
          <>
            <DetailRow label="Name">{detail.name}</DetailRow>
            <DetailRow label="Folder" mono>
              {detail.parentDir}
            </DetailRow>
            <DetailRow label="Type">{detail.ext ? `.${detail.ext}` : 'No extension'}</DetailRow>
            <DetailRow label="Size">{formatBytes(detail.sizeBytes)}</DetailRow>
            <DetailRow label="Modified">{formatDateTime(detail.modifiedMs)}</DetailRow>
            <DetailRow label="Created">{formatDateTime(detail.createdMs)}</DetailRow>
            <DetailRow label="Verified">
              {detail.verification === 'hashed'
                ? 'Content hash confirmed'
                : detail.verification === 'stale'
                  ? 'Changed since it was hashed'
                  : 'From the index — not content-checked'}
            </DetailRow>
            {detail.sha256 && (
              <DetailRow label="SHA-256" mono>
                {detail.sha256}
              </DetailRow>
            )}
          </>
        )}
      </Drawer>
    </>
  )
}

export default SearchScreen

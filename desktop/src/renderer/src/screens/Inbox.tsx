import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Inbox as InboxIcon, ListChecks, Play, RefreshCw } from 'lucide-react'
import type { MonitoredFolder, OrganizationPlan, PlannedMove } from '../../../shared/types'
import { api } from '../api'
import Button from '../components/Button'
import { Select } from '../components/Field'
import PageHeader from '../components/PageHeader'
import { Section } from '../components/Panel'
import StatusPill from '../components/StatusPill'
import Toggle from '../components/Toggle'
import { EmptyState, ErrorState, LoadingState, Notice } from '../components/States'
import { useToast } from '../components/Toast'
import {
  explanationLabel,
  explanationTone,
  formatBytes,
  formatCount,
  planWarningLabel,
  pluralize,
  skipReasonLabel,
} from '../lib/format'
import styles from './Inbox.module.css'

/**
 * The review inbox.
 *
 * It is a *proposal*, not an action: MySort builds a read-only plan of what
 * it would do with the files in a watched folder, shows it here, and only
 * moves a file when the user ticks it and presses Apply. Files that are still
 * downloading, or that no rule matches, are listed as skipped.
 */
const InboxScreen: React.FC = () => {
  const toast = useToast()

  const [folders, setFolders] = useState<MonitoredFolder[]>([])
  const [folderId, setFolderId] = useState<number | null>(null)
  const [plan, setPlan] = useState<OrganizationPlan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.folders.list().then((r) => {
      if (!r.ok) return
      setFolders(r.data)
      if (r.data.length > 0) setFolderId((current) => current ?? r.data[0].id)
    })
  }, [])

  const buildPlan = useCallback(async () => {
    if (folderId === null) return
    setLoading(true)
    setError(null)
    const result = await api.inbox.plan({ folderId })
    setLoading(false)
    if (result.ok) {
      setPlan(result.data)
      // Everything is proposed; nothing is approved until the user says so.
      setSelected(new Set(result.data.items.map((i) => i.itemId)))
    } else {
      setError(result.error.message)
      setPlan(null)
    }
  }, [folderId])

  const apply = useCallback(async () => {
    if (!plan || selected.size === 0) return
    setApplying(true)
    const result = await api.inbox.apply({ planId: plan.planId, itemIds: [...selected] })
    setApplying(false)
    if (result.ok) {
      const done = result.data.results.filter((r) => r.status === 'completed').length
      const failed = result.data.results.filter(
        (r) => r.status === 'failed' || r.status === 'needs_review'
      ).length
      toast.push({
        kind: failed > 0 ? 'warning' : 'success',
        title: `${formatCount(done)} ${pluralize(done, 'file')} organized`,
        description:
          failed > 0
            ? `${formatCount(failed)} could not be moved and are listed in History.`
            : 'Every approved file was moved. You can undo any of them from History.',
      })
      setPlan(null)
      setSelected(new Set())
    } else {
      toast.push({ kind: 'error', title: 'The files were not moved', description: result.error.message })
    }
  }, [plan, selected, toast])

  const grouped = useMemo(() => {
    const map = new Map<string, PlannedMove[]>()
    for (const item of plan?.items ?? []) {
      const key = item.destPath.replace(/[\\/][^\\/]*$/, '')
      const bucket = map.get(key)
      if (bucket) bucket.push(item)
      else map.set(key, [item])
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [plan])

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const totalBytes = plan?.items.reduce((sum, i) => sum + i.sizeBytes, 0) ?? 0

  return (
    <>
      <PageHeader
        description="See what MySort would do with the files in a watched folder, then approve the moves you want. Nothing moves until you press Apply."
        meta={
          plan ? (
            <StatusPill tone="brand">
              {formatCount(plan.items.length)} {pluralize(plan.items.length, 'file')} proposed
            </StatusPill>
          ) : null
        }
        actions={
          <Button
            size="sm"
            variant="primary"
            onClick={() => void buildPlan()}
            loading={loading}
            disabled={folderId === null}
          >
            <ListChecks size={14} /> Build plan
          </Button>
        }
      />

      <Section title="Folder to review" description="Only loose files directly inside this folder are considered.">
        <div className={styles.toolbar}>
          <Select
            className={styles.folderSelect}
            aria-label="Folder to review"
            value={folderId === null ? '' : String(folderId)}
            onChange={(e) => setFolderId(Number(e.target.value))}
            options={
              folders.length === 0
                ? [{ value: '', label: 'No folders are watched' }]
                : folders.map((f) => ({ value: String(f.id), label: f.path }))
            }
          />
          <Button size="sm" variant="secondary" onClick={() => void buildPlan()} loading={loading}>
            <RefreshCw size={14} /> Rebuild plan
          </Button>
        </div>
        {folders.length === 0 && (
          <Notice tone="warning" title="No folder is being watched">
            Choose a folder in Settings before building a plan.
          </Notice>
        )}
      </Section>

      {loading && !plan && <LoadingState label="Reading the folder" />}

      {error && (
        <Section title="The plan could not be built">
          <ErrorState title="MySort could not read that folder" message={error} onRetry={() => void buildPlan()} />
        </Section>
      )}

      {plan && plan.items.length === 0 && (
        <Section title="Nothing to propose">
          <EmptyState
            icon={<InboxIcon size={18} />}
            title="Nothing is waiting"
            description="Every file in this folder is either already sorted, still downloading, or does not match a rule."
            tone="success"
          />
        </Section>
      )}

      {plan && plan.items.length > 0 && (
        <Section
          title="Proposed moves"
          description={`${formatCount(plan.items.length)} ${pluralize(plan.items.length, 'file')} · ${formatBytes(totalBytes)}`}
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set(plan.items.map((i) => i.itemId)))}
              >
                Select all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </>
          }
        >
          <div className={styles.group}>
            {grouped.map(([destination, items]) => (
              <div key={destination} className={styles.group}>
                <div className={styles.groupHead}>
                  <StatusPill tone="info">{formatCount(items.length)}</StatusPill>
                  <span className={styles.destination}>{destination}</span>
                </div>
                {items.map((item) => (
                  <div key={item.itemId} className={styles.row}>
                    <Toggle
                      className={styles.check}
                      checked={selected.has(item.itemId)}
                      onChange={() => toggle(item.itemId)}
                      label={`Approve moving ${item.fileName}`}
                    />
                    <div className={styles.rowMain}>
                      <span className={styles.rowName} title={item.fileName}>
                        {item.fileName}
                      </span>
                      <div className={styles.rowMeta}>
                        <StatusPill tone={explanationTone(item.explanation.outcome)} size="sm">
                          {explanationLabel(item.explanation.outcome)}
                        </StatusPill>
                        <span>{formatBytes(item.sizeBytes)}</span>
                        {item.warnings.map((w) => (
                          <StatusPill key={w} tone="warning" size="sm" title={planWarningLabel(w)}>
                            {planWarningLabel(w)}
                          </StatusPill>
                        ))}
                      </div>
                      <p className={styles.explanation}>{item.explanation.summary}</p>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className={styles.footer}>
            <Button
              variant="primary"
              onClick={() => void apply()}
              loading={applying}
              disabled={selected.size === 0}
            >
              <Play size={14} /> Move {formatCount(selected.size)} {pluralize(selected.size, 'file')}
            </Button>
            <span className={styles.explanation}>
              Every file is re-checked the moment you approve it — if it changed, it is left alone.
            </span>
          </div>
        </Section>
      )}

      {plan && plan.skipped.length > 0 && (
        <Section
          title="Left where they are"
          description="These files are not proposed for moving, and nothing will be done to them."
        >
          <ul className={styles.skipped}>
            {plan.skipped.map((s) => (
              <li key={s.fileName} className={styles.skippedRow}>
                <span>{s.fileName}</span>
                <StatusPill tone="neutral" size="sm">
                  {skipReasonLabel(s.reason)}
                </StatusPill>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

export default InboxScreen

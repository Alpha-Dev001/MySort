import React, { useCallback, useState } from 'react'
import { CopyCheck, FolderOpen, FolderSearch, RefreshCw, ShieldCheck } from 'lucide-react'
import type { DuplicateReport } from '../../../shared/types'
import { api } from '../api'
import Button from '../components/Button'
import { Section } from '../components/Panel'
import PageHeader from '../components/PageHeader'
import StatusPill from '../components/StatusPill'
import { EmptyState, ErrorState, LoadingState, Notice } from '../components/States'
import { useToast } from '../components/Toast'
import { formatBytes, formatCount, formatDateTime, formatRelative, pluralize } from '../lib/format'
import styles from './Duplicates.module.css'

/**
 * Exact duplicate detection.
 *
 * A duplicate here means two files with the *same content hash* — not merely
 * the same name or the same size. Nothing on this screen deletes anything:
 * it shows what is duplicated and lets the user open, reveal or collect the
 * copies they care about.
 */
const DuplicatesScreen: React.FC = () => {
  const toast = useToast()
  const [report, setReport] = useState<DuplicateReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scan = useCallback(async () => {
    setLoading(true)
    setError(null)
    const result = await api.duplicates.scan()
    setLoading(false)
    if (result.ok) {
      setReport(result.data)
      if (result.data.groups.length === 0) {
        toast.push({
          kind: 'success',
          title: 'No exact duplicates found',
          description: 'Every file that shares a size has different contents.',
        })
      }
    } else {
      setError(result.error.message)
    }
  }, [toast])

  const openFile = useCallback(
    async (filePath: string) => {
      const result = await api.search.open({ path: filePath })
      if (!result.ok) {
        toast.push({ kind: 'error', title: 'Could not open the file', description: result.error.message })
      }
    },
    [toast]
  )

  const revealFile = useCallback(
    async (filePath: string) => {
      const result = await api.search.reveal({ path: filePath })
      if (!result.ok) {
        toast.push({ kind: 'error', title: 'Could not show the file', description: result.error.message })
      }
    },
    [toast]
  )

  const totalCopies = report?.groups.reduce((sum, g) => sum + g.copies, 0) ?? 0
  const totalWasted = report?.groups.reduce((sum, g) => sum + g.wastedBytes, 0) ?? 0

  return (
    <>
      <PageHeader
        description="Files whose contents are byte-for-byte identical. MySort hashes the files and compares the hashes — a matching name or size is never enough on its own."
        meta={
          report ? (
            <StatusPill tone={report.groups.length > 0 ? 'warning' : 'success'}>
              {report.groups.length > 0
                ? `${formatCount(report.groups.length)} ${pluralize(report.groups.length, 'group')}`
                : 'No duplicates'}
            </StatusPill>
          ) : null
        }
        actions={
          <Button size="sm" variant="primary" onClick={() => void scan()} loading={loading}>
            <CopyCheck size={14} /> Scan for duplicates
          </Button>
        }
      />

      <Notice tone="info" icon={<ShieldCheck size={15} />} title="MySort never deletes anything">
        This screen only reports. Deleting a copy is a decision you make in a file manager — and it
        has to stay a decision you make.
      </Notice>

      {loading && !report && <LoadingState label="Comparing file contents" />}

      {error && (
        <Section title="The scan could not finish">
          <ErrorState title="The duplicate scan failed" message={error} onRetry={() => void scan()} />
        </Section>
      )}

      {report && (
        <>
          <Section
            title="Summary"
            description={`${formatCount(report.candidateFiles)} files shared a size and were compared · ${formatCount(report.hashedFiles)} were hashed · ${formatCount(report.tookMs)} ms`}          >
            <div className={styles.summary}>
              <span>
                {formatCount(totalCopies)} {pluralize(totalCopies, 'copy')} in{' '}
                {formatCount(report.groups.length)} {pluralize(report.groups.length, 'group')}
              </span>
              <span>
                Up to {formatBytes(totalWasted)} could be reclaimed by keeping one copy of each group
              </span>
              {report.unverifiableFiles > 0 && (
                <span>
                  {formatCount(report.unverifiableFiles)} files changed during the scan and were left
                  out
                </span>
              )}
              {report.truncated && <span>The scan stopped early — run it again for the rest</span>}
            </div>
          </Section>

          {report.groups.length === 0 ? (
            <Section title="Duplicate groups">
              <EmptyState
                icon={<CopyCheck size={18} />}
                title="No exact duplicates"
                description="Files that share a name or a size but differ in content are not duplicates, and are not listed here."
                tone="success"
                action={
                  <Button size="sm" variant="secondary" onClick={() => void scan()}>
                    <RefreshCw size={13} /> Scan again
                  </Button>
                }
              />
            </Section>
          ) : (
            report.groups.map((group) => (
              <Section
                key={group.hash}
                title={`${formatCount(group.copies)} identical ${pluralize(group.copies, 'copy')}`}
                description={`${formatBytes(group.sizeBytes)} each · ${formatBytes(group.wastedBytes)} could be reclaimed`}
              >
                <div className={styles.group}>
                  <div className={styles.groupHead}>
                    <StatusPill tone={group.status === 'verified' ? 'success' : 'warning'}>
                      {group.status === 'verified' ? 'Contents verified' : 'Uncertain'}
                    </StatusPill>
                    <span className={styles.hash}>{group.hash.slice(0, 16)}…</span>
                  </div>
                  {group.notes.map((note) => (
                    <Notice key={note} tone="warning">
                      {note}
                    </Notice>
                  ))}
                  <ul className={styles.files}>
                    {group.files.map((file) => (
                      <li key={file.path} className={styles.file}>
                        <div className={styles.fileMain}>
                          <span className={styles.fileName} title={file.name}>
                            {file.name}
                          </span>
                          <span className={styles.filePath} title={file.path}>
                            {file.parentDir || file.path}
                          </span>
                        </div>
                        <span title={formatDateTime(file.modifiedMs)}>
                          {formatRelative(file.modifiedMs)}
                        </span>
                        <div className={styles.fileActions}>
                          <Button
                            size="sm"
                            variant="ghost"
                            iconOnly
                            aria-label={`Open ${file.name}`}
                            title="Open"
                            onClick={() => void openFile(file.path)}
                          >
                            <FolderOpen size={14} />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            iconOnly
                            aria-label={`Show ${file.name} in its folder`}
                            title="Show in folder"
                            onClick={() => void revealFile(file.path)}
                          >
                            <FolderSearch size={14} />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </Section>
            ))
          )}
        </>
      )}

      {!report && !loading && (
        <Section title="Duplicate groups">
          <EmptyState
            icon={<CopyCheck size={18} />}
            title="Nothing scanned yet"
            description="Run a scan to compare the files MySort has indexed. Only files with identical contents are reported."
            tone="brand"
            action={
              <Button size="sm" variant="primary" onClick={() => void scan()}>
                <CopyCheck size={13} /> Scan for duplicates
              </Button>
            }
          />
        </Section>
      )}
    </>
  )
}

export default DuplicatesScreen

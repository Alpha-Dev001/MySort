import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  FlaskConical,
  ListChecks,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import type { FileRule, RuleTestResult } from '../../../shared/types'
import { api } from '../api'
import Button from '../components/Button'
import { TextInput } from '../components/Field'
import PageHeader from '../components/PageHeader'
import Panel from '../components/Panel'
import StatusPill from '../components/StatusPill'
import Toggle from '../components/Toggle'
import { EmptyState, ErrorState, SkeletonRows } from '../components/States'
import { Modal, useConfirm } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { explanationLabel, explanationTone, formatCount, pluralize } from '../lib/format'
import { emptyDraft, toCreateInput, RuleControls, RuleFormFields } from './RuleForm'
import styles from './Rules.module.css'

export interface RulesScreenProps {
  /** A rule card opens its detail page — document navigation, not a dropdown. */
  onOpenRule: (ruleId: string, ruleName: string) => void
}

export const RulesScreen: React.FC<RulesScreenProps> = ({ onOpenRule }) => {
  const toast = useToast()
  const confirm = useConfirm()

  const [rules, setRules] = useState<FileRule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState(emptyDraft)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [testName, setTestName] = useState('')
  const [testResult, setTestResult] = useState<RuleTestResult | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    const unsub = api.onRulesChanged((next) => {
      setRules(next)
      setLoading(false)
    })
    return unsub
  }, [])

  const load = useCallback(async () => {
    const res = await api.rules.list()
    if (res.ok) {
      setRules(res.data)
      setError(null)
    } else {
      setError(res.error.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rules
    return rules.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.extensions.some((e) => e.includes(q)) ||
        r.destination.value.toLowerCase().includes(q),
    )
  }, [rules, filter])

  // ---- mutations ---------------------------------------------------------

  const closeCreate = useCallback(() => {
    setCreating(false)
    setDraft(emptyDraft())
    setFormError(null)
  }, [])

  const startCreate = useCallback(() => {
    setDraft(emptyDraft())
    setFormError(null)
    setCreating(true)
  }, [])

  const browseDestination = useCallback(async () => {
    setBrowsing(true)
    try {
      const grant = await api.folders.pick('destination')
      if (!grant.ok) return
      setDraft((d) => ({ ...d, destKind: 'absolute', destValue: grant.data.displayName, grantId: grant.data.grantId }))
      setFormError(null)
    } finally {
      setBrowsing(false)
    }
  }, [])

  const save = useCallback(async () => {
    const payload = toCreateInput(draft)
    if ('error' in payload) {
      setFormError(payload.error)
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const res = await api.rules.create(payload)
      if (!res.ok) {
        setFormError(res.error.message)
        return
      }
      toast.push({ kind: 'success', title: 'Rule created', description: res.data.name })
      closeCreate()
      await load()
    } finally {
      setSaving(false)
    }
  }, [closeCreate, draft, load, toast])

  const toggleEnabled = useCallback(
    async (rule: FileRule) => {
      setBusyId(rule.id)
      const res = await api.rules.setEnabled({ ruleId: rule.id, enabled: !rule.enabled })
      setBusyId(null)
      if (res.ok) {
        await load()
      } else {
        toast.push({ kind: 'error', title: 'Could not change the rule', description: res.error.message })
      }
    },
    [load, toast],
  )

  const remove = useCallback(
    async (rule: FileRule) => {
      const ok = await confirm({
        title: `Delete “${rule.name}”?`,
        description: 'Files already moved by this rule stay where they are. New files will no longer match it.',
        confirmLabel: 'Delete rule',
        tone: 'danger',
      })
      if (!ok) return
      const res = await api.rules.remove({ ruleId: rule.id })
      if (res.ok) {
        toast.push({ kind: 'success', title: 'Rule deleted', description: rule.name })
        await load()
      } else {
        toast.push({ kind: 'error', title: 'Could not delete the rule', description: res.error.message })
      }
    },
    [confirm, load, toast],
  )

  const move = useCallback(
    async (rule: FileRule, delta: -1 | 1) => {
      const ids = rules.map((r) => r.id)
      const index = ids.indexOf(rule.id)
      const target = index + delta
      if (target < 0 || target >= ids.length) return
      const next = [...ids]
      next.splice(index, 1)
      next.splice(target, 0, rule.id)
      setBusyId(rule.id)
      const res = await api.rules.reorder({ orderedIds: next })
      setBusyId(null)
      if (res.ok) setRules(res.data)
      else toast.push({ kind: 'error', title: 'Could not reorder', description: res.error.message })
    },
    [rules, toast],
  )

  const runTest = useCallback(async () => {
    const name = testName.trim()
    if (!name) return
    setTesting(true)
    try {
      const res = await api.rules.test({ fileName: name })
      if (res.ok) setTestResult(res.data)
      else toast.push({ kind: 'error', title: 'Could not test that name', description: res.error.message })
    } finally {
      setTesting(false)
    }
  }, [testName, toast])

  const enabledCount = rules.filter((r) => r.enabled).length

  return (
    <>
      <PageHeader
        description="Rules decide where a file goes. They are checked top to bottom and the first enabled match wins."
        meta={
          rules.length > 0 ? (
            <StatusPill tone="brand" size="sm">
              {enabledCount} of {rules.length} enabled
            </StatusPill>
          ) : undefined
        }
        actions={
          <Button variant="primary" onClick={startCreate} disabled={creating}>
            <Plus size={15} /> New rule
          </Button>
        }
      />

      {/* ---- tester: makes the rule order legible ---------------------- */}
      {rules.length > 0 && (
        <Panel
          tone="raised"
          title="Test a filename"
          description="See exactly which rule wins before you rely on it."
        >
          <div className={styles.tester}>
            <div className={styles.testerInput}>
              <TextInput
                value={testName}
                onChange={(e) => setTestName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void runTest()}
                placeholder="e.g. report-final.pdf"
                adornment={<Search size={14} />}
                aria-label="File name to test"
              />
              <Button variant="secondary" onClick={() => void runTest()} loading={testing} disabled={!testName.trim()}>
                <FlaskConical size={14} /> Test
              </Button>
            </div>

            {testResult && (
              <div className={styles.testResult}>
                <div className={styles.testSummary}>
                  <StatusPill tone={explanationTone(testResult.explanation.outcome)} size="sm">
                    {explanationLabel(testResult.explanation.outcome)}
                  </StatusPill>
                  <code className={styles.testDest}>{testResult.destination ?? 'File stays where it is'}</code>
                  {testResult.category && <StatusPill tone="info" size="sm">{testResult.category}</StatusPill>}
                </div>
                {testResult.explanation.considered.length > 0 && (
                  <ol className={styles.considered}>
                    {testResult.explanation.considered.map((c, i) => (
                      <li key={`${c.ruleId ?? 'none'}-${i}`} className={styles.consideredRow}>
                        <span className={styles.consideredName}>{c.name}</span>
                        <span className={styles.consideredResult} data-result={c.result}>
                          {c.result}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </div>
        </Panel>
      )}

      {/* ---- create: a modal, so the list never jumps ------------------- */}
      <Modal
        open={creating}
        title="New rule"
        description="Rules are checked top to bottom; a new rule joins the end of the list unless you reorder it."
        onClose={closeCreate}
        footer={
          <div className={styles.modalActions}>
            <RuleControls
              draft={draft}
              setDraft={setDraft}
              saving={saving}
              saveLabel="Create rule"
              onSave={() => void save()}
              onCancel={closeCreate}
            />
          </div>
        }
      >
        <RuleFormFields
          draft={draft}
          setDraft={setDraft}
          error={formError}
          browsing={browsing}
          onBrowse={() => void browseDestination()}
        />
      </Modal>

      {/* ---- list ------------------------------------------------------- */}
      {loading ? (
        <Panel tone="raised">
          <SkeletonRows rows={4} columns={4} />
        </Panel>
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : rules.length === 0 ? (
        <Panel tone="raised">
          <EmptyState
            icon={<ListChecks size={17} />}
            title="No rules yet"
            description="Without a rule, MySort classifies files by extension into folders such as Images, Documents and Archives. Add a rule to control exactly where things go."
            action={
              <Button variant="primary" onClick={startCreate}>
                <Plus size={15} /> Create your first rule
              </Button>
            }
          />
        </Panel>
      ) : (
        <div className={styles.list}>
          {filter && (
            <p className={styles.filterNote}>
              {formatCount(visible.length)} of {rules.length} {pluralize(rules.length, 'rule')} match “{filter}”
            </p>
          )}

          {visible.length === 0 ? (
            <Panel tone="raised">
              <EmptyState
                compact
                icon={<Search size={17} />}
                title="No rules match that search"
                action={
                  <Button variant="secondary" size="sm" onClick={() => setFilter('')}>
                    Clear search
                  </Button>
                }
              />
            </Panel>
          ) : (
            visible.map((rule) => {
              const index = rules.findIndex((r) => r.id === rule.id)
              const busy = busyId === rule.id
              return (
                <article key={rule.id} className={[styles.card, !rule.enabled ? styles.cardOff : ''].filter(Boolean).join(' ')}>
                  <div className={styles.order} aria-hidden="true">
                    <span className={styles.orderIndex}>{index + 1}</span>
                  </div>

                  <div className={styles.cardBody}>
                    <button
                      type="button"
                      className={styles.cardHead}
                      onClick={() => onOpenRule(rule.id, rule.name)}
                      title="Open rule details"
                    >
                      <span className={styles.cardChevron} aria-hidden="true">
                        <ChevronRight size={14} />
                      </span>
                      <span className={styles.cardTitle}>
                        <span className={styles.ruleName}>{rule.name}</span>
                        <span className={styles.ruleSummary}>
                          {rule.extensions.length > 0 ? rule.extensions.map((e) => `.${e}`).join(' ') : rule.namePattern}
                          <span className={styles.arrow} aria-hidden="true">→</span>
                          <code>{rule.destination.value}</code>
                        </span>
                      </span>
                    </button>

                    {rule.warnings.length > 0 && (
                      <div className={styles.warnings}>
                        {rule.warnings.map((w, i) => (
                          <p key={i} className={styles.warning}>
                            <AlertTriangle size={12} aria-hidden="true" />
                            {w.code === 'OVERLAPS' && `Overlaps “${w.otherRuleName}”. This rule runs first, so it wins.`}
                            {w.code === 'SHADOWED' && 'An earlier rule already matches every file this one would match.'}
                            {w.code === 'DEST_UNAVAILABLE' && 'The destination folder is not reachable right now.'}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className={styles.cardAside}>
                    <Toggle
                      checked={rule.enabled}
                      disabled={busy}
                      onChange={() => void toggleEnabled(rule)}
                      label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
                    />
                    <div className={styles.rowActions}>
                      <Button
                        variant="quiet"
                        size="sm"
                        iconOnly
                        onClick={() => void move(rule, -1)}
                        disabled={busy || index === 0}
                        aria-label={`Move ${rule.name} up`}
                        title="Move up"
                      >
                        <ArrowUp size={13} />
                      </Button>
                      <Button
                        variant="quiet"
                        size="sm"
                        iconOnly
                        onClick={() => void move(rule, 1)}
                        disabled={busy || index === rules.length - 1}
                        aria-label={`Move ${rule.name} down`}
                        title="Move down"
                      >
                        <ArrowDown size={13} />
                      </Button>
                      <Button
                        variant="quiet"
                        size="sm"
                        iconOnly
                        onClick={() => void remove(rule)}
                        disabled={busy}
                        aria-label={`Delete ${rule.name}`}
                        title="Delete"
                        className={styles.dangerBtn}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>
                </article>
              )
            })
          )}
        </div>
      )}
    </>
  )
}

export default RulesScreen

import React, { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, FileQuestion, Trash2 } from 'lucide-react'
import type { FileRule } from '../../../shared/types'
import { api } from '../api'
import Button from '../components/Button'
import PageHeader from '../components/PageHeader'
import Panel from '../components/Panel'
import StatusPill from '../components/StatusPill'
import { EmptyState, ErrorState, LoadingState } from '../components/States'
import { useConfirm } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { formatCount, pluralize } from '../lib/format'
import { draftFrom, toUpdateInput, RuleControls, RuleFormFields, type Draft } from './RuleForm'
import styles from './RuleDetail.module.css'

export interface RuleDetailProps {
  /** Opaque rule id from the `#/rules/<id>` location. */
  ruleId: string
  onBack: () => void
  /** Reports the current rule name so the shell's top bar can carry it. */
  onName: (name: string | null) => void
}

/**
 * A rule's detail page — the destination for "open a rule" navigation.
 *
 * It replaces the old inline accordion: one rule per address, deep-linkable,
 * with the top bar naming the rule. The page is intentionally narrow: match
 * fields, the destination, live warnings, and the state/save controls. Order
 * stays on the list, where reordering is meaningful.
 */
const RuleDetail: React.FC<RuleDetailProps> = ({ ruleId, onBack, onName }) => {
  const toast = useToast()
  const confirm = useConfirm()

  const [rules, setRules] = useState<FileRule[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  const load = useCallback(async () => {
    const res = await api.rules.list()
    if (res.ok) {
      setRules(res.data)
      setLoadError(null)
    } else {
      setLoadError(res.error.message)
    }
  }, [])

  useEffect(() => {
    void load()
    const unsub = api.onRulesChanged((next) => {
      setRules(next)
      setLoadError(null)
    })
    return unsub
  }, [load])

  const rule = rules?.find((r) => r.id === ruleId) ?? null

  // Warm the top-bar title once the rule is known, and keep it in step if the
  // rule is renamed here.
  useEffect(() => {
    onName(rule?.name ?? null)
    return () => onName(null)
  }, [onName, rule?.name])

  // Seed the draft exactly once per rule so incidental list refreshes don't
  // clobber in-progress edits. (Render-phase reset: React re-runs this pass
  // with the seeded draft before painting.)
  const [draftRuleId, setDraftRuleId] = useState<string | null>(null)
  const [draftState, setDraftState] = useState<Draft | null>(null)
  if (rule && draftRuleId !== rule.id) {
    setDraftRuleId(rule.id)
    setDraftState(draftFrom(rule))
    setFormError(null)
  }

  // The shared form expects a non-null draft dispatch; wrap the nullable one.
  const setDraft = useCallback((action: React.SetStateAction<Draft>) => {
    setDraftState((prev) => {
      if (prev === null) return prev
      return typeof action === 'function' ? action(prev) : action
    })
  }, [])

  const browseDestination = useCallback(async () => {
    setBrowsing(true)
    try {
      const grant = await api.folders.pick('destination')
      if (!grant.ok) return
      setDraftState((d) => (d ? { ...d, destKind: 'absolute', destValue: grant.data.displayName, grantId: grant.data.grantId } : d))
      setFormError(null)
    } finally {
      setBrowsing(false)
    }
  }, [])

  const save = useCallback(async () => {
    if (!draftState || !rule) return
    const payload = toUpdateInput(draftState, rule)
    if ('error' in payload) {
      setFormError(payload.error)
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const res = await api.rules.update({ ruleId, ...payload })
      if (!res.ok) {
        setFormError(res.error.message)
        return
      }
      toast.push({ kind: 'success', title: 'Rule saved', description: res.data.name })
      await load()
    } finally {
      setSaving(false)
    }
  }, [draftState, load, rule, ruleId, toast])

  const remove = useCallback(async () => {
    if (!rule) return
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
      onBack()
    } else {
      toast.push({ kind: 'error', title: 'Could not delete the rule', description: res.error.message })
    }
  }, [confirm, onBack, rule, toast])

  // ---- states -------------------------------------------------------------

  /** Breadcrumb back to the list: the same affordance on every branch. */
  const backLink = (
    <div className={styles.backRow}>
      <button type="button" className={styles.backLink} onClick={onBack}>
        <ArrowLeft size={14} aria-hidden="true" /> All rules
      </button>
    </div>
  )

  if (loadError && !rules) {
    return (
      <>
        {backLink}
        <PageHeader description="This page shows one rule and everything it does." />
        <ErrorState message={loadError} onRetry={() => void load()} />
      </>
    )
  }

  if (!rules) {
    return (
      <>
        {backLink}
        <PageHeader />
        <Panel tone="raised">
          <LoadingState label="Opening the rule" />
        </Panel>
      </>
    )
  }

  if (!rule) {
    return (
      <>
        {backLink}
        <PageHeader description="This page shows one rule and everything it does." />
        <Panel tone="raised">
          <EmptyState
            icon={<FileQuestion size={17} />}
            title="This rule doesn't exist any more"
            description="It may have been deleted. Files already moved by it stay where they are."
            action={
              <Button variant="primary" onClick={onBack}>
                <ArrowLeft size={14} /> Back to rules
              </Button>
            }
          />
        </Panel>
      </>
    )
  }

  // The rule is on screen, so the render-phase seeding above has run; the
  // non-null draft is what the rest of the render relies on.
  if (!draftState) return null

  const position = rules.findIndex((r) => r.id === ruleId) + 1

  return (
    <>
      {backLink}
      <PageHeader
        description="Match files by extension or name pattern and move them wherever it says."
        meta={
          <>
            <StatusPill tone={rule.enabled ? 'brand' : 'neutral'} size="sm">
              {rule.enabled ? 'Enabled' : 'Disabled'}
            </StatusPill>
            <span className={styles.metaText}>
              Checked {formatCount(position)} of {rules.length} {pluralize(rules.length, 'rule')} — decide the order from the Rules page
            </span>
          </>
        }
        actions={
          <Button variant="ghost" className={styles.deleteBtn} onClick={() => void remove()} disabled={saving}>
            <Trash2 size={14} /> Delete rule
          </Button>
        }
      />

      <Panel
        tone="raised"
        title="Rule details"
        description="Saved changes apply to files that arrive from now on — files already moved stay put."
      >
        <div className={styles.form}>
          <RuleFormFields
            draft={draftState}
            setDraft={setDraft}
            error={formError}
            browsing={browsing}
            onBrowse={() => void browseDestination()}
          />

          {rule.warnings.length > 0 && (
            <div className={styles.warnings}>
              {rule.warnings.map((w, i) => (
                <p key={i} className={styles.warning}>
                  <AlertTriangle size={13} aria-hidden="true" />
                  {w.code === 'OVERLAPS' && `Overlaps “${w.otherRuleName}”. The earlier rule runs first and wins.`}
                  {w.code === 'SHADOWED' && 'An earlier rule already matches every file this one would match.'}
                  {w.code === 'DEST_UNAVAILABLE' && 'The destination folder is not reachable right now.'}
                </p>
              ))}
            </div>
          )}

          <div className={styles.formActions}>
            <RuleControls
              draft={draftState}
              setDraft={setDraft}
              saving={saving}
              saveLabel="Save changes"
              onSave={() => void save()}
              onCancel={onBack}
            />
          </div>
        </div>
      </Panel>
    </>
  )
}

export default RuleDetail

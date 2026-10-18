import React, { useState } from 'react'
import { FolderOpen, Plus, X } from 'lucide-react'
import type { FileRule, RuleInput, RuleUpdateInput } from '../../../shared/types'
import Button from '../components/Button'
import { Field, TextInput } from '../components/Field'
import Toggle from '../components/Toggle'
import { Notice } from '../components/States'
import styles from './RuleForm.module.css'

/**
 * The rule editor's shape: one draft object covering matching, destination
 * and state. The create modal (Rules screen) and the rule detail page share
 * both this model and the field components below, so the two surfaces can
 * never drift apart.
 */

export type Draft = {
  name: string
  extensions: string[]
  namePattern: string
  destKind: 'relative' | 'absolute'
  destValue: string
  grantId: string | null
  enabled: boolean
}

export function draftFrom(rule: FileRule): Draft {
  return {
    name: rule.name,
    extensions: [...rule.extensions],
    namePattern: rule.namePattern ?? '',
    destKind: rule.destination.kind,
    destValue: rule.destination.value,
    grantId: null,
    enabled: rule.enabled,
  }
}

export function emptyDraft(): Draft {
  return {
    name: '',
    extensions: [],
    namePattern: '',
    destKind: 'relative',
    destValue: '',
    grantId: null,
    enabled: true,
  }
}

function checkCriterion(name: string, draft: Draft): string | null {
  if (!name) return 'Give the rule a name.'
  if (draft.extensions.length === 0 && !draft.namePattern.trim())
    return 'Add at least one extension, or a filename pattern.'
  return null
}

function ruleFields(name: string, draft: Draft): Omit<RuleInput, 'destination'> {
  return {
    name,
    extensions: draft.extensions,
    namePattern: draft.namePattern.trim() || null,
    enabled: draft.enabled,
  }
}

/** rules:create always states a destination; absolute ones need a fresh grant. */
export function toCreateInput(draft: Draft): RuleInput | { error: string } {
  const name = draft.name.trim()
  const criterion = checkCriterion(name, draft)
  if (criterion) return { error: criterion }

  if (draft.destKind === 'relative') {
    const value = draft.destValue.trim()
    if (!value) return { error: 'Enter a destination folder.' }
    return { ...ruleFields(name, draft), destination: { kind: 'relative', value } }
  }
  if (!draft.grantId) return { error: 'Re-choose the destination folder before saving.' }
  return { ...ruleFields(name, draft), destination: { kind: 'absolute', grantId: draft.grantId } }
}

/**
 * rules:update may keep its existing destination. That matters when the rule
 * points at an absolute folder granted by the OS picker: the grant is
 * one-time, so an untouched destination is sent as "keep" instead of forcing
 * the user to re-pick a folder they never meant to change.
 */
export function toUpdateInput(draft: Draft, original: FileRule | null): RuleUpdateInput | { error: string } {
  const name = draft.name.trim()
  const criterion = checkCriterion(name, draft)
  if (criterion) return { error: criterion }

  if (draft.destKind === 'relative') {
    const value = draft.destValue.trim()
    if (!value) return { error: 'Enter a destination folder.' }
    return { ...ruleFields(name, draft), destination: { kind: 'relative', value } }
  }
  if (draft.grantId) {
    return { ...ruleFields(name, draft), destination: { kind: 'absolute', grantId: draft.grantId } }
  }
  const untouched =
    original && original.destination.kind === 'absolute' && draft.destValue === original.destination.value
  if (untouched) {
    return { ...ruleFields(name, draft), destination: { kind: 'keep' } }
  }
  return { error: 'Re-choose the destination folder before saving.' }
}

export interface RuleFormFieldsProps {
  draft: Draft
  setDraft: React.Dispatch<React.SetStateAction<Draft>>
  error: string | null
  browsing: boolean
  onBrowse: () => void
}

export function RuleFormFields({ draft, setDraft, error, browsing, onBrowse }: RuleFormFieldsProps): React.ReactElement {
  const [extInput, setExtInput] = useState('')

  const addExtension = (): void => {
    const clean = extInput
      .trim()
      .toLowerCase()
      .replace(/^\.+/, '')
      .split(/\s+/)
      .filter(Boolean)
    if (!clean.length) return
    setDraft((d) => ({ ...d, extensions: [...new Set([...d.extensions, ...clean])] }))
    setExtInput('')
  }

  const removeExtension = (ext: string): void => {
    setDraft((d) => ({ ...d, extensions: d.extensions.filter((e) => e !== ext) }))
  }

  // An absolute destination arrived through a one-time grant, so it can only be
  // replaced by picking again — the form says so instead of silently failing.
  const absoluteLocked = draft.destKind === 'absolute' && !draft.grantId

  return (
    <>
      <div className={styles.formGrid}>
        <Field label="Name" htmlFor="rule-name">
          <TextInput
            id="rule-name"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Invoices"
          />
        </Field>

        <Field
          label="Extensions"
          help="Leave empty to rely on the filename pattern alone."
        >
          <div className={styles.extRow}>
            <div className={styles.chips}>
              {draft.extensions.map((ext) => (
                <span key={ext} className={styles.chip}>
                  <code>.{ext}</code>
                  <button
                    type="button"
                    onClick={() => removeExtension(ext)}
                    aria-label={`Remove .${ext}`}
                    className={styles.chipRemove}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              {draft.extensions.length === 0 && <span className={styles.chipsEmpty}>No extensions yet</span>}
            </div>
            <div className={styles.extAdd}>
              <TextInput
                value={extInput}
                onChange={(e) => setExtInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addExtension()
                  }
                }}
                placeholder="pdf"
                aria-label="Add an extension"
              />
              <Button variant="secondary" onClick={addExtension} disabled={!extInput.trim()} aria-label="Add extension">
                <Plus size={14} />
              </Button>
            </div>
          </div>
        </Field>

        <Field label="Filename pattern (optional)" help="Only * and ? are allowed, e.g. invoice-*">
          <TextInput
            value={draft.namePattern}
            onChange={(e) => setDraft((d) => ({ ...d, namePattern: e.target.value }))}
            placeholder="invoice-*"
            monospace
          />
        </Field>

        <Field
          label="Destination folder"
          help={
            absoluteLocked
              ? 'Absolute folders are granted by the OS picker. Choose it again to change it.'
              : 'A folder inside your destination root, e.g. Documents/Invoices.'
          }
        >
          <div className={styles.destRow}>
            <TextInput
              value={draft.destValue}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  destValue: e.target.value,
                  grantId: null,
                  destKind: e.target.value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(e.target.value) ? 'absolute' : 'relative',
                }))
              }
              placeholder="Documents/Invoices"
              monospace
              disabled={absoluteLocked}
            />
            <Button variant="secondary" onClick={onBrowse} loading={browsing}>
              <FolderOpen size={14} /> Browse
            </Button>
          </div>
        </Field>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}
    </>
  )
}

export interface RuleControlsProps {
  draft: Draft
  setDraft: React.Dispatch<React.SetStateAction<Draft>>
  saving: boolean
  saveLabel: string
  onSave: () => void
  onCancel: () => void
}

export function RuleControls({ draft, setDraft, saving, saveLabel, onSave, onCancel }: RuleControlsProps): React.ReactElement {
  return (
    <>
      <Toggle
        checked={draft.enabled}
        onChange={(next) => setDraft((d) => ({ ...d, enabled: next }))}
        label="Rule is enabled"
      >
        Rule is enabled
      </Toggle>
      <div className={styles.formButtons}>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onSave} loading={saving}>
          {saveLabel}
        </Button>
      </div>
    </>
  )
}

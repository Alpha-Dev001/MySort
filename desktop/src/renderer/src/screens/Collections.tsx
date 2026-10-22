import React, { useCallback, useEffect, useState } from 'react'
import { FolderOpen, FolderSearch, Layers, Plus, Trash2, X } from 'lucide-react'
import type { CollectionMember, CollectionRule, FileCollection } from '../../../shared/types'
import { api } from '../api'
import Button from '../components/Button'
import { Field, Select, TextInput } from '../components/Field'
import { Modal } from '../components/Dialog'
import PageHeader from '../components/PageHeader'
import { Section } from '../components/Panel'
import StatusPill from '../components/StatusPill'
import { EmptyState, ErrorState, LoadingState, Notice } from '../components/States'
import { useConfirm } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { formatBytes, formatCount, pluralize } from '../lib/format'
import styles from './Collections.module.css'

const RULE_KINDS: readonly { value: CollectionRule['kind']; label: string }[] = [
  { value: 'extension', label: 'File type' },
  { value: 'name_contains', label: 'Name contains' },
  { value: 'parent', label: 'In folder' },
]

const kindLabel = (kind: CollectionRule['kind']): string =>
  RULE_KINDS.find((k) => k.value === kind)?.label ?? kind

/**
 * Collections: named sets of files that stay exactly where they are.
 *
 * A collection holds references, not copies. Nothing is moved, nothing is
 * duplicated, and deleting a collection never touches a file.
 */
const CollectionsScreen: React.FC = () => {
  const toast = useToast()
  const confirm = useConfirm()

  const [collections, setCollections] = useState<FileCollection[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [members, setMembers] = useState<CollectionMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [ruleKind, setRuleKind] = useState<CollectionRule['kind']>('extension')
  const [ruleValue, setRuleValue] = useState('')
  const [memberPath, setMemberPath] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const result = await api.collections.list()
    setLoading(false)
    if (result.ok) {
      setCollections(result.data)
      setActiveId((current) => current ?? result.data[0]?.id ?? null)
      setError(null)
    } else {
      setError(result.error.message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const active = collections.find((c) => c.id === activeId) ?? null

  const loadMembers = useCallback(async (id: string) => {
    const result = await api.collections.members({ id })
    if (result.ok) setMembers(result.data)
    else setMembers([])
  }, [])

  useEffect(() => {
    if (activeId) void loadMembers(activeId)
    else setMembers([])
  }, [activeId, loadMembers])

  const create = useCallback(async () => {
    if (name.trim().length === 0) return
    const result = await api.collections.create({ name: name.trim(), description: description.trim() })
    if (result.ok) {
      setCreateOpen(false)
      setName('')
      setDescription('')
      await load()
      setActiveId(result.data.id)
      toast.push({ kind: 'success', title: 'Collection created', description: result.data.name })
    } else {
      toast.push({ kind: 'error', title: 'Could not create the collection', description: result.error.message })
    }
  }, [name, description, load, toast])

  const addRule = useCallback(async () => {
    if (!active || ruleValue.trim().length === 0) return
    const rules: CollectionRule[] = [...active.rules, { kind: ruleKind, value: ruleValue.trim() }]
    const result = await api.collections.setRules({ id: active.id, rules })
    if (result.ok) {
      setCollections((current) => current.map((c) => (c.id === active.id ? result.data : c)))
      setRuleValue('')
      await loadMembers(active.id)
    }
  }, [active, ruleKind, ruleValue, loadMembers])

  const removeRule = useCallback(
    async (index: number) => {
      if (!active) return
      const rules = active.rules.filter((_, i) => i !== index)
      const result = await api.collections.setRules({ id: active.id, rules })
      if (result.ok) {
        setCollections((current) => current.map((c) => (c.id === active.id ? result.data : c)))
        await loadMembers(active.id)
      }
    },
    [active, loadMembers]
  )

  const removeCollection = useCallback(async () => {
    if (!active) return
    const ok = await confirm({
      title: `Delete “${active.name}”?`,
      description: 'The collection is removed. The files it pointed at stay exactly where they are.',
      confirmLabel: 'Delete collection',
      tone: 'danger',
    })
    if (!ok) return
    const result = await api.collections.remove({ id: active.id })
    if (result.ok) {
      setActiveId(null)
      await load()
      toast.push({ kind: 'info', title: 'Collection deleted', description: 'No files were touched.' })
    }
  }, [active, confirm, load, toast])

  const removeMember = useCallback(
    async (filePath: string) => {
      if (!active) return
      const result = await api.collections.removeMember({ id: active.id, path: filePath })
      if (result.ok) {
        setCollections((current) => current.map((c) => (c.id === active.id ? result.data : c)))
        await loadMembers(active.id)
      }
    },
    [active, loadMembers]
  )

  const addMember = useCallback(async () => {
    if (!active || memberPath.trim().length === 0) return
    const result = await api.collections.addMember({ id: active.id, path: memberPath.trim() })
    if (result.ok) {
      setCollections((current) => current.map((c) => (c.id === active.id ? result.data : c)))
      setMemberPath('')
      await loadMembers(active.id)
      toast.push({ kind: 'success', title: 'Added to the collection' })
    } else {
      toast.push({
        kind: 'error',
        title: 'Could not add that file',
        description: result.error.message,
      })
    }
  }, [active, memberPath, loadMembers, toast])

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

  if (loading) return <LoadingState label="Loading collections" />

  return (
    <>
      <PageHeader
        description="Group files without moving them. A collection is a set of references — the files stay exactly where they are, and deleting a collection never touches a file."
        actions={
          <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New collection
          </Button>
        }
      />

      {error && <ErrorState title="Could not load collections" message={error} onRetry={() => void load()} />}

      {collections.length === 0 ? (
        <Section title="Collections">
          <EmptyState
            icon={<Layers size={18} />}
            title="No collections yet"
            description="A collection gathers files that belong together — a project's invoices, a trip's photos — without moving anything."
            tone="brand"
            action={
              <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus size={13} /> Create your first collection
              </Button>
            }
          />
        </Section>
      ) : (
        <Section title="Your collections" description="Choose one to see what is in it.">
          <div className={styles.layout}>
            <ul className={styles.list}>
              {collections.map((collection) => (
                <li key={collection.id}>
                  <button
                    type="button"
                    className={styles.item}
                    data-active={collection.id === activeId}
                    onClick={() => setActiveId(collection.id)}
                  >
                    <span className={styles.itemName}>{collection.name}</span>
                    <span className={styles.itemMeta}>
                      {formatCount(collection.rules.length)}{' '}
                      {pluralize(collection.rules.length, 'rule')} ·{' '}
                      {formatCount(collection.manualPaths.length)} added by hand
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <div className={styles.detail}>
              {active && (
                <>
                  <div className={styles.rules}>
                    <strong>{active.name}</strong>
                    {active.description && <span className={styles.itemMeta}>{active.description}</span>}
                    {active.rules.length === 0 ? (
                      <Notice tone="info">
                        This collection has no rules yet. Add one below, or add files to it from
                        Search.
                      </Notice>
                    ) : (
                      active.rules.map((rule, index) => (
                        <div key={`${rule.kind}-${rule.value}-${index}`} className={styles.ruleRow}>
                          <span className={styles.tag}>
                            {kindLabel(rule.kind)}: {rule.value}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            iconOnly
                            aria-label={`Remove the ${rule.kind} rule ${rule.value}`}
                            onClick={() => void removeRule(index)}
                          >
                            <X size={13} />
                          </Button>
                        </div>
                      ))
                    )}
                  </div>

                  <div className={styles.ruleRow}>
                    <Select
                      aria-label="Rule kind"
                      value={ruleKind}
                      onChange={(e) => setRuleKind(e.target.value as CollectionRule['kind'])}
                      options={RULE_KINDS}
                    />
                    <TextInput
                      value={ruleValue}
                      onChange={(e) => setRuleValue(e.target.value)}
                      placeholder={ruleKind === 'parent' ? 'C:\\Users\\…\\Project' : ruleKind === 'extension' ? 'pdf' : 'invoice'}
                      monospace
                      aria-label="Rule value"
                    />
                    <Button size="sm" variant="secondary" onClick={() => void addRule()}>
                      <Plus size={13} /> Add rule
                    </Button>
                  </div>

                  <div>
                    <div className={styles.ruleRow}>
                      <strong>
                        {formatCount(members.length)} {pluralize(members.length, 'file')}
                      </strong>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeCollection()}
                        style={{ marginLeft: 'auto' }}
                      >
                        <Trash2 size={13} /> Delete collection
                      </Button>
                    </div>

                    <div className={styles.ruleRow}>
                      <TextInput
                        value={memberPath}
                        onChange={(e) => setMemberPath(e.target.value)}
                        placeholder="Add a file by its full path"
                        monospace
                        aria-label="File to add to this collection"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void addMember()}
                        disabled={memberPath.trim().length === 0}
                      >
                        <Plus size={13} /> Add file
                      </Button>
                    </div>

                    {members.length === 0 ? (
                      <Notice tone="info">
                        Nothing matches this collection yet. The index may not be built — build it on
                        the Search screen.
                      </Notice>
                    ) : (
                      <ul className={styles.members}>
                        {members.map((member) => (
                          <li key={member.path} className={styles.member}>
                            <div className={styles.memberMain}>
                              <span className={styles.memberName}>{member.name}</span>
                              <span className={styles.memberReason}>{member.reason}</span>
                              <span className={styles.memberPath} title={member.path}>
                                {member.path}
                              </span>
                            </div>
                            <span>{formatBytes(member.sizeBytes)}</span>
                            {member.missing ? (
                              <StatusPill tone="warning" size="sm">
                                Missing
                              </StatusPill>
                            ) : member.changed ? (
                              <StatusPill tone="info" size="sm">
                                Changed
                              </StatusPill>
                            ) : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              iconOnly
                              aria-label={`Open ${member.name}`}
                              title="Open"
                              onClick={() => void openFile(member.path)}
                            >
                              <FolderOpen size={14} />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              iconOnly
                              aria-label={`Show ${member.name} in its folder`}
                              title="Show in folder"
                              onClick={() => void revealFile(member.path)}
                            >
                              <FolderSearch size={14} />
                            </Button>
                            {member.reason === 'Added by hand' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                iconOnly
                                aria-label={`Remove ${member.name} from this collection`}
                                title="Remove from this collection"
                                onClick={() => void removeMember(member.path)}
                              >
                                <X size={14} />
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </Section>
      )}

      <Modal
        open={createOpen}
        title="New collection"
        description="Give it a name. You can add rules and files afterwards."
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void create()} disabled={name.trim().length === 0}>
              Create
            </Button>
          </>
        }
      >
        <Field label="Name">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Invoices"
            aria-label="Collection name"
            autoFocus
          />
        </Field>
        <Field label="Description" help="Optional.">
          <TextInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Everything to do with the apartment"
            aria-label="Collection description"
          />
        </Field>
      </Modal>
    </>
  )
}

export default CollectionsScreen

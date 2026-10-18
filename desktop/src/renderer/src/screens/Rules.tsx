import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  FlaskConical,
  ListChecks,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import type { FileRule, RuleTestResult } from '../../../shared/types';
import { api } from '../api';
import Button from '../components/Button';
import DataTable, { type Column } from '../components/DataTable';
import { SearchInput, Segmented, TextInput } from '../components/Field';
import PageHeader from '../components/PageHeader';
import Panel from '../components/Panel';
import StatusPill from '../components/StatusPill';
import Toggle from '../components/Toggle';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Modal, useConfirm } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { explanationLabel, explanationTone, formatCount, pluralize } from '../lib/format';
import { emptyDraft, toCreateInput, RuleControls, RuleFormFields } from './RuleForm';
import styles from './Rules.module.css';

export interface RulesScreenProps {
  /** A rule card opens its detail page — document navigation, not a dropdown. */
  onOpenRule: (ruleId: string, ruleName: string) => void;
}

type StatusFilter = 'all' | 'enabled' | 'disabled';

/** One short line per warning for the table cell; the detail page spells it out. */
function warningText(code: string, otherRuleName?: string): string {
  if (code === 'OVERLAPS')
    return `Overlaps “${otherRuleName ?? 'another rule'}” — this one runs first`;
  if (code === 'SHADOWED') return 'An earlier rule already matches every file this one would';
  return 'Destination folder is not reachable right now';
}

export const RulesScreen: React.FC<RulesScreenProps> = ({ onOpenRule }) => {
  const toast = useToast();
  const confirm = useConfirm();

  const [rules, setRules] = useState<FileRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [testName, setTestName] = useState('');
  const [testResult, setTestResult] = useState<RuleTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const unsub = api.onRulesChanged((next) => {
      setRules(next);
      setLoading(false);
    });
    return unsub;
  }, []);

  const load = useCallback(async () => {
    const res = await api.rules.list();
    if (res.ok) {
      setRules(res.data);
      setError(null);
    } else {
      setError(res.error.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rules.filter((r) => {
      if (statusFilter === 'enabled' && !r.enabled) return false;
      if (statusFilter === 'disabled' && r.enabled) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.extensions.some((e) => e.includes(q)) ||
        r.destination.value.toLowerCase().includes(q)
      );
    });
  }, [rules, filter, statusFilter]);

  const filtering = filter.trim() !== '' || statusFilter !== 'all';
  const enabledCount = rules.filter((r) => r.enabled).length;

  // Position lookup for the order column, without an O(n²) scan per row.
  const orderIndex = useMemo(() => new Map(rules.map((r, i) => [r.id, i + 1])), [rules]);

  const clearFilters = useCallback(() => {
    setFilter('');
    setStatusFilter('all');
  }, []);

  // ---- mutations ---------------------------------------------------------

  const closeCreate = useCallback(() => {
    setCreating(false);
    setDraft(emptyDraft());
    setFormError(null);
  }, []);

  const startCreate = useCallback(() => {
    setDraft(emptyDraft());
    setFormError(null);
    setCreating(true);
  }, []);

  const browseDestination = useCallback(async () => {
    setBrowsing(true);
    try {
      const grant = await api.folders.pick('destination');
      if (!grant.ok) return;
      setDraft((d) => ({
        ...d,
        destKind: 'absolute',
        destValue: grant.data.displayName,
        grantId: grant.data.grantId,
      }));
      setFormError(null);
    } finally {
      setBrowsing(false);
    }
  }, []);

  const save = useCallback(async () => {
    const payload = toCreateInput(draft);
    if ('error' in payload) {
      setFormError(payload.error);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await api.rules.create(payload);
      if (!res.ok) {
        setFormError(res.error.message);
        return;
      }
      toast.push({ kind: 'success', title: 'Rule created', description: res.data.name });
      closeCreate();
      await load();
    } finally {
      setSaving(false);
    }
  }, [closeCreate, draft, load, toast]);

  const toggleEnabled = useCallback(
    async (rule: FileRule) => {
      setBusyId(rule.id);
      const res = await api.rules.setEnabled({ ruleId: rule.id, enabled: !rule.enabled });
      setBusyId(null);
      if (res.ok) {
        await load();
      } else {
        toast.push({
          kind: 'error',
          title: 'Could not change the rule',
          description: res.error.message,
        });
      }
    },
    [load, toast]
  );

  const remove = useCallback(
    async (rule: FileRule) => {
      const ok = await confirm({
        title: `Delete “${rule.name}”?`,
        description:
          'Files already moved by this rule stay where they are. New files will no longer match it.',
        confirmLabel: 'Delete rule',
        tone: 'danger',
      });
      if (!ok) return;
      const res = await api.rules.remove({ ruleId: rule.id });
      if (res.ok) {
        toast.push({ kind: 'success', title: 'Rule deleted', description: rule.name });
        await load();
      } else {
        toast.push({
          kind: 'error',
          title: 'Could not delete the rule',
          description: res.error.message,
        });
      }
    },
    [confirm, load, toast]
  );

  const move = useCallback(
    async (rule: FileRule, delta: -1 | 1) => {
      const ids = rules.map((r) => r.id);
      const index = ids.indexOf(rule.id);
      const target = index + delta;
      if (target < 0 || target >= ids.length) return;
      const next = [...ids];
      next.splice(index, 1);
      next.splice(target, 0, rule.id);
      setBusyId(rule.id);
      const res = await api.rules.reorder({ orderedIds: next });
      setBusyId(null);
      if (res.ok) setRules(res.data);
      else
        toast.push({ kind: 'error', title: 'Could not reorder', description: res.error.message });
    },
    [rules, toast]
  );

  const runTest = useCallback(async () => {
    const name = testName.trim();
    if (!name) return;
    setTesting(true);
    try {
      const res = await api.rules.test({ fileName: name });
      if (res.ok) setTestResult(res.data);
      else
        toast.push({
          kind: 'error',
          title: 'Could not test that name',
          description: res.error.message,
        });
    } finally {
      setTesting(false);
    }
  }, [testName, toast]);

  // ---- columns -------------------------------------------------------------

  /**
   * The table IS the documented order: rows sit in processing order, and the
   * number column answers "which rule is checked first". Row click opens the
   * rule; every control inside a row stops the event so it never navigates.
   */
  const columns: Column<FileRule>[] = [
    {
      key: 'order',
      header: '#',
      headerHidden: true,
      width: '5%',
      cell: (rule) => <span className={styles.order}>{orderIndex.get(rule.id) ?? '—'}</span>,
    },
    {
      key: 'rule',
      header: 'Rule',
      width: '38%',
      cell: (rule) => {
        const match =
          rule.extensions.length > 0
            ? rule.extensions.map((e) => `.${e}`).join(' ')
            : rule.namePattern;
        return (
          <div className={styles.ruleCell}>
            <span className={styles.ruleName}>{rule.name}</span>
            {match && (
              <span className={styles.ruleMatch} title={match}>
                {match}
              </span>
            )}
            {rule.warnings.slice(0, 1).map((w, i) => {
              const text = warningText(w.code, w.otherRuleName);
              return (
                <span key={i} className={styles.ruleWarn} title={text}>
                  <AlertTriangle size={11} aria-hidden="true" />
                  {text}
                  {rule.warnings.length > 1 && ` (+${rule.warnings.length - 1} more)`}
                </span>
              );
            })}
          </div>
        );
      },
    },
    {
      key: 'dest',
      header: 'Destination',
      width: '20%',
      cell: (rule) => (
        <code className={styles.dest} title={rule.destination.value}>
          {rule.destination.value}
        </code>
      ),
    },
    {
      key: 'enabled',
      header: 'Enabled',
      width: '13%',
      cell: (rule) => (
        // The switch must not double as row navigation, so the cell swallows clicks.
        <div className={styles.toggleCell} onClick={(e) => e.stopPropagation()}>
          <Toggle
            checked={rule.enabled}
            disabled={busyId === rule.id}
            onChange={() => void toggleEnabled(rule)}
            label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
          />
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      width: '22%',
      align: 'end',
      cell: (rule) => {
        const index = (orderIndex.get(rule.id) ?? 1) - 1;
        const busy = busyId === rule.id;
        // Reordering only makes sense where the whole order is visible; a
        // filtered view hides the neighbours the move would swap with.
        const reorderOff = busy || filtering;
        return (
          <div className={styles.actions}>
            <Button
              variant="quiet"
              size="sm"
              iconOnly
              onClick={(e) => {
                e.stopPropagation();
                void move(rule, -1);
              }}
              disabled={reorderOff || index === 0}
              aria-label={`Move ${rule.name} up`}
              title={filtering ? 'Clear the filters to reorder' : 'Move up'}
            >
              <ArrowUp size={13} />
            </Button>
            <Button
              variant="quiet"
              size="sm"
              iconOnly
              onClick={(e) => {
                e.stopPropagation();
                void move(rule, 1);
              }}
              disabled={reorderOff || index === rules.length - 1}
              aria-label={`Move ${rule.name} down`}
              title={filtering ? 'Clear the filters to reorder' : 'Move down'}
            >
              <ArrowDown size={13} />
            </Button>
            <Button
              variant="quiet"
              size="sm"
              iconOnly
              onClick={(e) => {
                e.stopPropagation();
                void remove(rule);
              }}
              disabled={busy}
              aria-label={`Delete ${rule.name}`}
              title="Delete"
              className={styles.dangerBtn}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        );
      },
    },
  ];

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

      {/* ---- one panel: toolbar, order table, tester -------------------- */}
      {loading ? (
        <Panel tone="raised" flush>
          <div className={styles.tableWrap}>
            <LoadingState label="Loading rules" />
          </div>
        </Panel>
      ) : error ? (
        <Panel tone="raised" flush>
          <div className={styles.tableWrap}>
            <ErrorState message={error} onRetry={() => void load()} />
          </div>
        </Panel>
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
        <Panel tone="raised" flush>
          <div className={styles.toolbar}>
            <SearchInput
              className={styles.search}
              value={filter}
              onValueChange={setFilter}
              placeholder="Filter by name, extension or folder…"
              aria-label="Filter rules"
            />
            <Segmented
              ariaLabel="Filter rules by state"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'enabled', label: 'Enabled' },
                { value: 'disabled', label: 'Disabled' },
              ]}
            />
          </div>

          {filtering && visible.length > 0 && (
            <p className={styles.filterRow}>
              {formatCount(visible.length)} of {formatCount(rules.length)}{' '}
              {pluralize(rules.length, 'rule')} shown
            </p>
          )}

          <DataTable
            caption="File rules, checked from top to bottom"
            columns={columns}
            rows={visible}
            rowKey={(rule) => rule.id}
            onRowClick={(rule) => onOpenRule(rule.id, rule.name)}
            rowClassName={(rule) => (!rule.enabled ? styles.rowOff : undefined)}
            maxHeight="min(60vh, 560px)"
            resetScrollKey={`${filter}-${statusFilter}`}
            empty={
              <EmptyState
                compact
                icon={<Search size={17} />}
                title="No rules match those filters"
                action={
                  <Button variant="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            }
          />

          {/* ---- tester: the footer, right under the order it explains -- */}
          <div className={styles.tester}>
            <div className={styles.testerForm}>
              <TextInput
                value={testName}
                onChange={(e) => setTestName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void runTest()}
                placeholder="Test a filename — e.g. report-final.pdf"
                adornment={<Search size={14} />}
                aria-label="File name to test"
              />
              <Button
                variant="secondary"
                onClick={() => void runTest()}
                loading={testing}
                disabled={!testName.trim()}
              >
                <FlaskConical size={14} /> Test
              </Button>
            </div>

            {testResult && (
              <div className={styles.testResult}>
                <div className={styles.testSummary}>
                  <StatusPill tone={explanationTone(testResult.explanation.outcome)} size="sm">
                    {explanationLabel(testResult.explanation.outcome)}
                  </StatusPill>
                  <code className={styles.testDest}>
                    {testResult.destination ?? 'File stays where it is'}
                  </code>
                  {testResult.category && (
                    <StatusPill tone="info" size="sm">
                      {testResult.category}
                    </StatusPill>
                  )}
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
    </>
  );
};

export default RulesScreen;

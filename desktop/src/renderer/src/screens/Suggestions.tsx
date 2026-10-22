import React, { useCallback, useEffect, useState } from 'react'
import { Eye, Lightbulb, RefreshCw, Sparkles, X } from 'lucide-react'
import type { RuleRecommendation, SearchResultPage } from '../../../shared/types'
import { api } from '../api'
import Button from '../components/Button'
import PageHeader from '../components/PageHeader'
import { Section } from '../components/Panel'
import StatusPill from '../components/StatusPill'
import { EmptyState, ErrorState, LoadingState, Notice } from '../components/States'
import { useToast } from '../components/Toast'
import { formatCount, formatRelative, pluralize, shortenPath } from '../lib/format'
import styles from './Suggestions.module.css'

/**
 * Rule suggestions.
 *
 * A suggestion is a pattern MySort noticed in what you have already done —
 * never a rule that quietly starts moving files. Accepting a suggestion
 * creates an ordinary rule; dismissing it means it will not be offered again.
 */
const SuggestionsScreen: React.FC = () => {
  const toast = useToast()
  const [items, setItems] = useState<RuleRecommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ id: string; page: SearchResultPage } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const result = await api.recommendations.list()
    setLoading(false)
    if (result.ok) {
      setItems(result.data)
      setError(null)
    } else {
      setError(result.error.message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const detect = useCallback(async () => {
    setBusy('detect')
    const result = await api.recommendations.detect()
    setBusy(null)
    if (result.ok) {
      setItems(result.data)
      toast.push({
        kind: 'info',
        title: 'Suggestions refreshed',
        description: 'MySort looked at the moves you have already made.',
      })
    } else {
      toast.push({ kind: 'error', title: 'Could not look for patterns', description: result.error.message })
    }
  }, [toast])

  const accept = useCallback(
    async (recommendation: RuleRecommendation) => {
      setBusy(recommendation.id)
      const result = await api.recommendations.accept({ id: recommendation.id })
      setBusy(null)
      if (result.ok) {
        toast.push({
          kind: 'success',
          title: 'Rule created',
          description: `“${result.data.name}” now decides where these files go.`,
        })
        await load()
      } else {
        toast.push({ kind: 'error', title: 'Could not create the rule', description: result.error.message })
      }
    },
    [load, toast]
  )

  const dismiss = useCallback(
    async (recommendation: RuleRecommendation) => {
      setBusy(recommendation.id)
      const result = await api.recommendations.dismiss({ id: recommendation.id })
      setBusy(null)
      if (result.ok) {
        setItems(result.data)
        toast.push({ kind: 'info', title: 'Suggestion dismissed', description: 'It will not be offered again.' })
      } else {
        toast.push({ kind: 'error', title: 'Could not dismiss it', description: result.error.message })
      }
    },
    [toast]
  )

  const showPreview = useCallback(async (recommendation: RuleRecommendation) => {
    setBusy(recommendation.id)
    const result = await api.recommendations.preview({ id: recommendation.id })
    setBusy(null)
    if (result.ok) {
      setPreview({ id: recommendation.id, page: result.data })
    } else {
      toast.push({ kind: 'error', title: 'Could not build a preview', description: result.error.message })
    }
  }, [toast])

  const pending = items.filter((r) => r.status === 'pending')
  const settled = items.filter((r) => r.status !== 'pending')

  return (
    <>
      <PageHeader
        description="Patterns MySort noticed in the moves you have already made. Nothing here acts on its own — a suggestion becomes a rule only when you accept it."
        meta={
          pending.length > 0 ? (
            <StatusPill tone="brand">
              {formatCount(pending.length)} {pluralize(pending.length, 'suggestion')}
            </StatusPill>
          ) : null
        }
        actions={
          <Button size="sm" variant="secondary" onClick={() => void detect()} loading={busy === 'detect'}>
            <RefreshCw size={14} /> Look for patterns
          </Button>
        }
      />

      {loading && <LoadingState label="Loading suggestions" />}

      {error && <ErrorState title="Could not load suggestions" message={error} onRetry={() => void load()} />}

      {!loading && pending.length === 0 && (
        <Section title="Suggestions">
          <EmptyState
            icon={<Lightbulb size={18} />}
            title="No suggestions yet"
            description="When MySort sees the same kind of file going to the same place again and again, it offers to make that a rule."
            tone="brand"
            action={
              <Button size="sm" variant="secondary" onClick={() => void detect()} loading={busy === 'detect'}>
                <RefreshCw size={13} /> Look for patterns
              </Button>
            }
          />
        </Section>
      )}

      {pending.map((recommendation) => (
        <Section key={recommendation.id} title="Suggested rule">
          <div className={styles.card}>
            <div className={styles.head}>
              <div className={styles.title}>
                <span className={styles.name}>{recommendation.name}</span>
                <span className={styles.target}>
                  {recommendation.extensions.map((e) => `.${e}`).join(' ')} → {recommendation.destination}
                </span>
              </div>
              <div className={styles.actions}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void showPreview(recommendation)}
                  loading={busy === recommendation.id}
                >
                  <Eye size={13} /> Preview
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void dismiss(recommendation)}
                  disabled={busy === recommendation.id}
                >
                  <X size={13} /> Dismiss
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void accept(recommendation)}
                  loading={busy === recommendation.id}
                >
                  <Sparkles size={13} /> Create rule
                </Button>
              </div>
            </div>
            <p className={styles.evidence}>{recommendation.evidence}</p>
            <div className={styles.evidence}>
              <StatusPill tone="neutral" size="sm">
                Last seen {formatRelative(recommendation.lastSeenAt)}
              </StatusPill>
            </div>
            {preview?.id === recommendation.id && (
              <div className={styles.preview}>
                {preview.page.items.length === 0 ? (
                  <Notice tone="info">
                    No indexed file matches this rule yet. Build the index on the Search screen to see
                    what it would apply to.
                  </Notice>
                ) : (
                  <>
                    <span className={styles.evidence}>
                      {formatCount(preview.page.items.length)} indexed{' '}
                      {pluralize(preview.page.items.length, 'file')} would match:
                    </span>
                    {preview.page.items.slice(0, 12).map((file) => (
                      <span key={file.path} className={styles.previewRow}>
                        {file.name}
                        <span style={{ opacity: 0.7 }}>{shortenPath(file.parentDir, 40)}</span>
                      </span>
                    ))}
                    {preview.page.items.length > 12 && (
                      <span className={styles.previewRow}>
                        …and {formatCount(preview.page.items.length - 12)} more
                      </span>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </Section>
      ))}

      {settled.length > 0 && (
        <Section title="Earlier suggestions" description="Suggestions you accepted or dismissed.">
          <div className={styles.accepted}>
            {settled.map((recommendation) => (
              <div key={recommendation.id} className={styles.head}>
                <div className={styles.title}>
                  <span className={styles.name}>{recommendation.name}</span>
                  <span className={styles.target}>{recommendation.destination}</span>
                </div>
                <StatusPill tone={recommendation.status === 'accepted' ? 'success' : 'neutral'} size="sm">
                  {recommendation.status === 'accepted' ? 'Rule created' : 'Dismissed'}
                </StatusPill>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

export default SuggestionsScreen

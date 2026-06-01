'use client'

import { useEffect, useState } from 'react'
import { fetchAllOpenRecommendations, fetchRecommendationsHistory, updateRecommendation, applyRecommendation, runAgent, updateAgent } from '@/lib/client-api'
import type { Recommendation } from '@/lib/client-api'
import { ErrorState } from '@/components/ErrorState'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { RecommendationCard } from '@/components/recommendations/RecommendationCard'
import { RecommendationHistoryRow } from '@/components/recommendations/RecommendationHistoryRow'
import { recommendationBackoffSchedule } from '@/components/recommendations/schedule-backoff'

type RecommendationsTab = 'unresolved' | 'history'

// Cross-project Recommendations page. Two tabs: "Unresolved" (open work that
// needs attention) and "History" (what was already done — auto-resolved by the
// orchestrator, or dismissed/applied by the operator).
export function GlobalRecommendationsPage() {
  const [items, setItems] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<RecommendationsTab>('unresolved')
  // History is loaded lazily the first time the tab is opened, then refreshed
  // whenever an action resolves a card (so it stays in sync without polling).
  const [history, setHistory] = useState<Recommendation[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  // Tracks every recommendation currently being applied/dismissed. A single
  // string slot would have meant: clicking Accept on card B while card A is
  // still in flight overwrites A's busy state (UI lie), and whichever of
  // the two settles first clears the busy state for *both* via the shared
  // setUpdating(null) in finally. A Set scopes busy state per id.
  const [updating, setUpdating] = useState<ReadonlySet<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  // Transient confirmation banner for Fix actions that don't remove the card
  // (e.g. "Run agent now").
  const [notice, setNotice] = useState<string | null>(null)

  const startUpdating = (id: string) =>
    setUpdating((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  const finishUpdating = (id: string) =>
    setUpdating((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })

  const loadErrorMessage = (err: unknown) => err instanceof Error ? err.message : 'Failed to load recommendations'

  const load = async () => {
    const data = await fetchAllOpenRecommendations()
    setItems(data.recommendations)
    setLoadError(null)
  }

  const loadHistory = async () => {
    setHistoryLoading(true)
    try {
      const data = await fetchRecommendationsHistory()
      setHistory(data.recommendations)
      setHistoryError(null)
      setHistoryLoaded(true)
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load history')
    } finally {
      setHistoryLoading(false)
    }
  }

  // Lazily load history the first time the tab is opened.
  useEffect(() => {
    if (tab === 'history' && !historyLoaded && !historyLoading) void loadHistory()
  }, [tab, historyLoaded, historyLoading])

  // An action that resolved/dismissed/applied a card invalidates the cached
  // history so it reloads (lazily on next open, or immediately if visible).
  const invalidateHistory = () => {
    setHistoryLoaded(false)
    if (tab === 'history') void loadHistory()
  }

  const patchRecommendationPayload = (id: string, patch: Record<string, unknown>) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item
        const basePayload = item.payload && typeof item.payload === 'object' ? item.payload : {}
        return {
          ...item,
          payload: {
            ...basePayload,
            ...patch,
          },
        }
      }),
    )
  }

  useEffect(() => {
    let active = true
    fetchAllOpenRecommendations()
      .then((data) => {
        if (!active) return
        setItems(data.recommendations)
        setLoadError(null)
      })
      .catch((err) => {
        if (!active) return
        setLoadError(loadErrorMessage(err))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const dismiss = async (item: Recommendation) => {
    startUpdating(item.id)
    setErrors((prev) => { const { [item.id]: _, ...rest } = prev; void _; return rest })
    try {
      await updateRecommendation(item.project, item.id, 'dismissed')
      setItems((prev) => prev.filter((candidate) => candidate.id !== item.id))
      window.dispatchEvent(new CustomEvent('tamtam:recommendations-changed'))
      invalidateHistory()
      try {
        await load()
      } catch (err) {
        setLoadError(loadErrorMessage(err))
      }
    } catch (err) {
      setErrors((prev) => ({ ...prev, [item.id]: err instanceof Error ? err.message : 'Failed to dismiss' }))
    } finally {
      finishUpdating(item.id)
    }
  }

  const accept = async (item: Recommendation) => {
    startUpdating(item.id)
    setErrors((prev) => { const { [item.id]: _, ...rest } = prev; void _; return rest })
    try {
      await applyRecommendation(item.project, item)
      setItems((prev) => prev.filter((candidate) => candidate.id !== item.id))
      window.dispatchEvent(new CustomEvent('tamtam:recommendations-changed'))
      invalidateHistory()
      try {
        await load()
      } catch (err) {
        setLoadError(loadErrorMessage(err))
      }
    } catch (err) {
      setErrors((prev) => ({ ...prev, [item.id]: err instanceof Error ? err.message : 'Failed to apply recommendation' }))
    } finally {
      finishUpdating(item.id)
    }
  }

  // "Run agent now" Fix action. Unlike accept/dismiss this does NOT resolve the
  // recommendation — it kicks off a fresh run so the operator can see whether
  // the agent behaves better. The card stays until the next analysis clears it.
  const runNow = async (item: Recommendation) => {
    if (!item.agent_id) return
    startUpdating(item.id)
    setErrors((prev) => { const { [item.id]: _, ...rest } = prev; void _; return rest })
    try {
      await runAgent(item.agent_id, '')
      setNotice(`Triggered a run of ${item.agent_name ?? 'the agent'} in ${item.project}.`)
    } catch (err) {
      setErrors((prev) => ({ ...prev, [item.id]: err instanceof Error ? err.message : 'Failed to run agent' }))
    } finally {
      finishUpdating(item.id)
    }
  }

  // "Decrease rate" Fix action. Like Run now, this does not resolve the
  // recommendation; it only applies a slower cadence when the payload proves
  // that the target is actually a backoff.
  const backOff = async (item: Recommendation, requestedSchedule?: string) => {
    if (!item.agent_id) return
    const schedule = requestedSchedule ?? recommendationBackoffSchedule(item)
    if (!schedule) return
    startUpdating(item.id)
    setErrors((prev) => { const { [item.id]: _, ...rest } = prev; void _; return rest })
    try {
      await updateAgent(item.agent_id, { schedule })
      patchRecommendationPayload(item.id, { currentSchedule: schedule })
      setNotice(`Set ${item.agent_name ?? 'the agent'} in ${item.project} to run every ${schedule}.`)
    } catch (err) {
      setErrors((prev) => ({ ...prev, [item.id]: err instanceof Error ? err.message : 'Failed to update schedule' }))
    } finally {
      finishUpdating(item.id)
    }
  }

  // "Run investigation" Fix action. Fires the agent read-only with a diagnostic
  // prompt so it reports why its recent scheduled runs produced no changes
  // instead of attempting (and likely failing) to make edits.
  const investigate = async (item: Recommendation) => {
    if (!item.agent_id) return
    startUpdating(item.id)
    setErrors((prev) => { const { [item.id]: _, ...rest } = prev; void _; return rest })
    try {
      await runAgent(
        item.agent_id,
        'Your recent scheduled runs produced no file changes. Investigate why: review the ' +
          'project state and your own task scope, and report whether there is genuinely no ' +
          'actionable work, the prompt is too narrow, or something is blocking you from making ' +
          'changes. Do not modify any files — report your findings only.',
        { readOnly: true },
      )
      setNotice(`Started a read-only investigation run of ${item.agent_name ?? 'the agent'} in ${item.project}.`)
    } catch (err) {
      setErrors((prev) => ({ ...prev, [item.id]: err instanceof Error ? err.message : 'Failed to start investigation' }))
    } finally {
      finishUpdating(item.id)
    }
  }

  // "Stop boosting" Fix action. Leaves the agent on its schedule but tells the
  // orchestrator to stop firing extra boost runs for it.
  const stopBoosting = async (item: Recommendation) => {
    if (!item.agent_id) return
    startUpdating(item.id)
    setErrors((prev) => { const { [item.id]: _, ...rest } = prev; void _; return rest })
    try {
      await updateAgent(item.agent_id, { boostable: false })
      patchRecommendationPayload(item.id, { boostable: false })
      setNotice(`Stopped boost runs for ${item.agent_name ?? 'the agent'} in ${item.project}.`)
    } catch (err) {
      setErrors((prev) => ({ ...prev, [item.id]: err instanceof Error ? err.message : 'Failed to update agent' }))
    } finally {
      finishUpdating(item.id)
    }
  }

  // "Disable agent" Fix action. The most disruptive control, so it's confirmed
  // before stopping the agent's scheduled runs entirely.
  const disable = async (item: Recommendation) => {
    if (!item.agent_id) return
    const label = item.agent_name ?? 'this agent'
    if (!window.confirm(`Disable ${label} in ${item.project}? It will no longer run on its schedule.`)) return
    startUpdating(item.id)
    setErrors((prev) => { const { [item.id]: _, ...rest } = prev; void _; return rest })
    try {
      await updateAgent(item.agent_id, { enabled: false })
      patchRecommendationPayload(item.id, { enabled: false })
      setNotice(`Disabled ${label} in ${item.project}.`)
    } catch (err) {
      setErrors((prev) => ({ ...prev, [item.id]: err instanceof Error ? err.message : 'Failed to disable agent' }))
    } finally {
      finishUpdating(item.id)
    }
  }

  if (loading) {
    return (
      <div className="px-4 py-6 max-w-5xl mx-auto">
        <div className="skeleton h-6 w-48 rounded" />
        <div className="skeleton h-3 w-64 rounded mt-2" />
      </div>
    )
  }

  return (
    <div className="px-4 py-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Recommendations</h1>
          <p className="text-xs text-text-tertiary mt-1">Agent and scheduler suggestions across every project.</p>
        </div>
        <div className="text-xs font-mono text-text-tertiary tabular-nums">{items.length} open</div>
      </div>

      <div className="flex gap-4 border-b border-border" role="tablist" aria-label="Recommendations">
        {(['unresolved', 'history'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={[
              '-mb-px border-b-2 px-1 pb-2 text-sm font-medium transition-colors',
              tab === t
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-tertiary hover:text-text-secondary',
            ].join(' ')}
          >
            {t === 'unresolved' ? `Unresolved (${items.length})` : `History${historyLoaded ? ` (${history.length})` : ''}`}
          </button>
        ))}
      </div>

      {notice && (
        <div className="flex items-center justify-between gap-3 rounded border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-text-secondary">
          <span>{notice}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-auto w-auto rounded-none border-none bg-transparent p-0 font-mono text-text-tertiary hover:bg-transparent hover:text-text-primary"
            onClick={() => setNotice(null)}
            aria-label="Dismiss notice"
          >
            ✕
          </Button>
        </div>
      )}

      {tab === 'unresolved' && (
        <>
          {loadError && (
            <ErrorState
              message="Failed to load recommendations."
              hint={loadError}
              onRetry={() => {
                setLoading(true)
                void load()
                  .catch((err) => {
                    setLoadError(loadErrorMessage(err))
                  })
                  .finally(() => {
                    setLoading(false)
                  })
              }}
            />
          )}

          {!loadError && items.length === 0 ? (
            <EmptyState
              bordered
              paddingY="xs"
              align="start"
              title="No open recommendations across any project."
            />
          ) : !loadError ? (
            <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
              {items.map((item) => (
                <RecommendationCard
                  key={item.id}
                  item={item}
                  busy={updating.has(item.id)}
                  errorMessage={errors[item.id] ?? null}
                  onAccept={() => accept(item)}
                  onDismiss={() => dismiss(item)}
                  onRunNow={() => runNow(item)}
                  onBackOff={(schedule) => backOff(item, schedule)}
                  onInvestigate={() => investigate(item)}
                  onStopBoosting={() => stopBoosting(item)}
                  onDisable={() => disable(item)}
                  showProjectLink
                />
              ))}
            </div>
          ) : null}
        </>
      )}

      {tab === 'history' && (
        <>
          {historyError && (
            <ErrorState message="Failed to load history." hint={historyError} onRetry={() => void loadHistory()} />
          )}
          {!historyError && historyLoading && !historyLoaded ? (
            <div className="rounded-lg border border-border bg-bg-secondary p-4">
              <div className="skeleton h-3 w-48 rounded" />
            </div>
          ) : !historyError && historyLoaded && history.length === 0 ? (
            <EmptyState
              bordered
              paddingY="xs"
              align="start"
              title="Nothing resolved yet — auto-resolved, dismissed, and applied recommendations will appear here."
            />
          ) : !historyError ? (
            <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
              {history.map((item) => (
                <RecommendationHistoryRow key={item.id} item={item} />
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

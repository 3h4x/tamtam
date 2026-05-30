'use client'

import { useEffect, useState } from 'react'
import { fetchAllOpenRecommendations, updateRecommendation, applyRecommendation } from '@/lib/client-api'
import type { Recommendation } from '@/lib/client-api'
import { ErrorState } from '@/components/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { RecommendationCard } from '@/components/recommendations/RecommendationCard'

// Cross-project Recommendations page. Lists every open recommendation sorted
// newest-first, with the same Accept/dismiss buttons used inside each project's
// Recommendations tab.
export function GlobalRecommendationsPage() {
  const [items, setItems] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(true)
  // Tracks every recommendation currently being applied/dismissed. A single
  // string slot would have meant: clicking Accept on card B while card A is
  // still in flight overwrites A's busy state (UI lie), and whichever of
  // the two settles first clears the busy state for *both* via the shared
  // setUpdating(null) in finally. A Set scopes busy state per id.
  const [updating, setUpdating] = useState<ReadonlySet<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState<string | null>(null)

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
          <p className="text-xs text-text-tertiary mt-1">Open agent and scheduler suggestions across every project.</p>
        </div>
        <div className="text-xs font-mono text-text-tertiary tabular-nums">{items.length} open</div>
      </div>

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
              showProjectLink
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

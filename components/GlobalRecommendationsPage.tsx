'use client'

import { useEffect, useMemo, useState } from 'react'
import { fetchAllOpenRecommendations, updateRecommendation, applyRecommendation } from '@/lib/client-api'
import type { Recommendation } from '@/lib/client-api'
import { RecommendationCard } from '@/components/recommendations/RecommendationCard'

// Cross-project Recommendations page. Lists every open recommendation grouped
// by project, with the same Accept/dismiss buttons used inside each project's
// Recommendations tab. Hidden when no opens exist.
export function GlobalRecommendationsPage() {
  const [items, setItems] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState<string | null>(null)

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

  const grouped = useMemo(() => {
    const m = new Map<string, Recommendation[]>()
    for (const item of items) {
      const arr = m.get(item.project) ?? []
      arr.push(item)
      m.set(item.project, arr)
    }
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length)
  }, [items])

  const dismiss = async (item: Recommendation) => {
    setUpdating(item.id)
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
      setUpdating(null)
    }
  }

  const accept = async (item: Recommendation) => {
    setUpdating(item.id)
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
      setUpdating(null)
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
        <div className="rounded-lg border border-status-error/30 bg-status-error/10 p-4 text-sm text-status-error">
          <div>Failed to load recommendations.</div>
          <div className="mt-1 text-xs opacity-80">{loadError}</div>
          <button
            type="button"
            className="mt-3 rounded border border-status-error/40 px-2 py-1 text-xs font-medium hover:bg-status-error/10"
            onClick={() => {
              setLoading(true)
              void load()
                .catch((err) => {
                  setLoadError(loadErrorMessage(err))
                })
                .finally(() => {
                  setLoading(false)
                })
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!loadError && grouped.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-secondary p-4 text-sm text-text-tertiary">
          No open recommendations across any project.
        </div>
      ) : !loadError ? (
        grouped.map(([project, projectItems]) => (
          <section key={project}>
            <h2 className="text-sm font-semibold text-text-primary mb-2 flex items-center gap-2">
              <span>{project}</span>
              <span className="text-xs font-mono text-text-tertiary">{projectItems.length}</span>
            </h2>
            <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
              {projectItems.map((item) => (
                <RecommendationCard
                  key={item.id}
                  item={item}
                  busy={updating === item.id}
                  errorMessage={errors[item.id] ?? null}
                  onAccept={() => accept(item)}
                  onDismiss={() => dismiss(item)}
                  showProjectLink
                />
              ))}
            </div>
          </section>
        ))
      ) : null}
    </div>
  )
}

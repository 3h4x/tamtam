'use client'

import { useEffect, useState } from 'react'
import { applyRecommendation, fetchRecommendations, updateRecommendation } from '@/lib/client-api'
import type { Recommendation } from '@/lib/client-api'
import { RecommendationCard } from '@/components/recommendations/RecommendationCard'

interface RecommendationsTabProps {
  projectName: string
}

function getLoadErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to load recommendations'
}

export function RecommendationsTab({ projectName }: RecommendationsTabProps) {
  const [items, setItems] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const load = async () => {
    const data = await fetchRecommendations(projectName)
    setItems(data.recommendations.filter((item) => item.status === 'open'))
    setLoadError(null)
  }

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchRecommendations(projectName)
      .then((data) => {
        if (!active) return
        setItems(data.recommendations.filter((item) => item.status === 'open'))
        setLoadError(null)
      })
      .catch((err) => {
        if (!active) return
        setLoadError(getLoadErrorMessage(err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [projectName])

  const dismiss = async (item: Recommendation) => {
    setUpdating(item.id)
    setErrors((prev) => {
      const { [item.id]: _ignored, ...rest } = prev
      void _ignored
      return rest
    })
    try {
      await updateRecommendation(projectName, item.id, 'dismissed')
      setItems((prev) => prev.filter((candidate) => candidate.id !== item.id))
      try {
        await load()
      } catch (err) {
        setLoadError(getLoadErrorMessage(err))
      }
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [item.id]: err instanceof Error ? err.message : 'Failed to dismiss',
      }))
    } finally {
      setUpdating(null)
    }
  }

  const accept = async (item: Recommendation) => {
    setUpdating(item.id)
    setErrors((prev) => {
      const { [item.id]: _ignored, ...rest } = prev
      void _ignored
      return rest
    })
    try {
      await applyRecommendation(projectName, item)
      setItems((prev) => prev.filter((candidate) => candidate.id !== item.id))
      try {
        await load()
      } catch (err) {
        setLoadError(getLoadErrorMessage(err))
      }
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [item.id]: err instanceof Error ? err.message : 'Failed to apply recommendation',
      }))
    } finally {
      setUpdating(null)
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-bg-secondary p-4">
        <div className="skeleton h-5 w-40 rounded" />
        <div className="skeleton mt-2 h-3 w-64 rounded" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Recommendations</h2>
          <p className="mt-1 text-xs text-text-tertiary">Open agent and scheduler suggestions for this project.</p>
        </div>
        <div className="text-xs font-mono text-text-tertiary tabular-nums">{items.length} open</div>
      </div>

      {loadError ? (
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
                  setLoadError(getLoadErrorMessage(err))
                })
                .finally(() => {
                  setLoading(false)
                })
            }}
          >
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-secondary p-4 text-sm text-text-tertiary">
          No open recommendations for this project.
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
          {items.map((item) => (
            <RecommendationCard
              key={item.id}
              item={item}
              busy={updating === item.id}
              errorMessage={errors[item.id] ?? null}
              onAccept={() => accept(item)}
              onDismiss={() => dismiss(item)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

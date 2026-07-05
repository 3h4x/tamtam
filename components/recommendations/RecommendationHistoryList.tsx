'use client'

import { useEffect, useState } from 'react'
import { fetchRecommendationsHistory } from '@/lib/client-api'
import type { Recommendation } from '@/lib/client-api'
import { ErrorState } from '@/components/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { RecommendationHistoryRow } from '@/components/recommendations/RecommendationHistoryRow'

/**
 * The resolved/dismissed/applied recommendation archive (read-only). Lazily
 * loads its data on mount; the `error` guard prevents an auto-retry loop after a
 * failed fetch (manual Retry calls load() directly). Extracted from the former
 * GlobalRecommendationsPage so the merged Inbox's History tab can reuse it.
 */
export function RecommendationHistoryList() {
  const [history, setHistory] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const data = await fetchRecommendationsHistory()
      setHistory(data.recommendations)
      setError(null)
      setLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!loaded && !loading && !error) void load()
  }, [loaded, loading, error])

  if (error) {
    return <ErrorState message="Failed to load history." hint={error} onRetry={() => void load()} />
  }
  if (loading && !loaded) {
    return (
      <div className="rounded-lg border border-border bg-bg-secondary p-4">
        <div className="skeleton h-3 w-48 rounded" />
      </div>
    )
  }
  if (loaded && history.length === 0) {
    return (
      <EmptyState
        bordered
        paddingY="xs"
        align="start"
        title="Nothing resolved yet — auto-resolved, dismissed, and applied recommendations will appear here."
      />
    )
  }
  return (
    <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
      {history.map((item) => (
        <RecommendationHistoryRow key={item.id} item={item} />
      ))}
    </div>
  )
}

'use client'

import { useEffect, useMemo, useState } from 'react'
import { fetchRecommendations, updateRecommendation } from '@/lib/client-api'
import type { Recommendation } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'

interface RecommendationsTabProps {
  projectName: string
}

function typeLabel(type: string): string {
  if (type === 'agent_schedule_backoff') return 'schedule'
  return type.replace(/_/g, ' ')
}

export function RecommendationsTab({ projectName }: RecommendationsTabProps) {
  const [items, setItems] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)

  const load = async () => {
    const data = await fetchRecommendations(projectName)
    setItems(data.recommendations)
    setLoading(false)
  }

  useEffect(() => {
    let active = true
    fetchRecommendations(projectName)
      .then((data) => { if (active) setItems(data.recommendations) })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [projectName])

  const openItems = useMemo(() => items.filter((item) => item.status === 'open'), [items])
  const closedItems = useMemo(() => items.filter((item) => item.status !== 'open'), [items])

  const setStatus = async (item: Recommendation, status: Recommendation['status']) => {
    setUpdating(item.id)
    try {
      await updateRecommendation(projectName, item.id, status)
      await load()
    } finally {
      setUpdating(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <div className="skeleton h-5 w-36 rounded" />
            <div className="skeleton h-3 w-56 rounded mt-2" />
          </div>
          <div className="skeleton h-3 w-12 rounded" />
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="border-b border-border last:border-b-0 p-3 flex items-start justify-between gap-3" style={{ opacity: 1 - i * 0.25 }}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="skeleton h-4 w-16 rounded" />
                  <div className="skeleton h-3 w-24 rounded" />
                </div>
                <div className="skeleton h-3.5 w-3/5 rounded mt-2" />
                <div className="skeleton h-3 w-4/5 rounded mt-1.5" />
              </div>
              <div className="skeleton h-6 w-14 rounded shrink-0" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Recommendations</h2>
          <p className="text-xs text-text-tertiary mt-1">Agent and scheduler suggestions for this project.</p>
        </div>
        <div className="text-xs font-mono text-text-tertiary tabular-nums">{openItems.length} open</div>
      </div>

      {openItems.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-secondary p-4 text-sm text-text-tertiary">
          No open recommendations
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
          {openItems.map((item) => (
            <div key={item.id} className="border-b border-border last:border-b-0 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-accent border border-accent/25">
                      {typeLabel(item.type)}
                    </span>
                    {item.agent_name && <span className="font-mono text-xs text-text-tertiary">agent:{item.agent_name}</span>}
                    <span className="font-mono text-xs text-text-tertiary">updated {formatAgo(item.updated_at)}</span>
                  </div>
                  <div className="mt-2 text-sm font-medium text-text-primary">{item.title}</div>
                  <div className="mt-1 text-sm text-text-secondary">{item.detail}</div>
                  {Boolean(item.payload?.recommendedSchedule) && (
                    <div className="mt-2 text-xs font-mono text-text-tertiary">
                      current {String(item.payload?.currentSchedule ?? '-')} / suggested {String(item.payload?.recommendedSchedule)}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
                  disabled={updating === item.id}
                  onClick={() => setStatus(item, 'dismissed')}
                >
                  dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {closedItems.length > 0 && (
        <div className="text-xs text-text-tertiary">
          {closedItems.length} dismissed recommendation{closedItems.length === 1 ? '' : 's'}
        </div>
      )}
    </div>
  )
}

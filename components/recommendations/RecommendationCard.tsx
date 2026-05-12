'use client'

import Link from 'next/link'
import type { Recommendation } from '@/lib/client-api'
import { AUTO_APPLICABLE_RECOMMENDATION_TYPES } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'

function typeLabel(type: string): string {
  if (type === 'agent_schedule_backoff') return 'schedule'
  return type.replace(/_/g, ' ')
}

interface RecommendationCardProps {
  item: Recommendation
  busy: boolean
  errorMessage: string | null
  onAccept: () => void
  onDismiss: () => void
  // When set, renders a small "View in project →" link — used by the global
  // recommendations page so each card stays linked to its source project.
  showProjectLink?: boolean
}

export function RecommendationCard({
  item,
  busy,
  errorMessage,
  onAccept,
  onDismiss,
  showProjectLink,
}: RecommendationCardProps) {
  const acceptable = AUTO_APPLICABLE_RECOMMENDATION_TYPES.has(item.type)
  const actionLabel = item.title.trim() || typeLabel(item.type)
  return (
    <div className="border-b border-border last:border-b-0 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-accent border border-accent/25">
              {typeLabel(item.type)}
            </span>
            {item.agent_name && <span className="font-mono text-xs text-text-tertiary">agent:{item.agent_name}</span>}
            <span className="font-mono text-xs text-text-tertiary">updated {formatAgo(item.updated_at)}</span>
            {showProjectLink && (
              <Link
                href={`/project/${encodeURIComponent(item.project)}`}
                className="font-mono text-xs text-accent hover:underline"
              >
                {item.project} →
              </Link>
            )}
          </div>
          <div className="mt-2 text-sm font-medium text-text-primary">{item.title}</div>
          <div className="mt-1 text-sm text-text-secondary">{item.detail}</div>
          {Boolean(item.payload?.recommendedSchedule) && (
            <div className="mt-2 text-xs font-mono text-text-tertiary">
              current {String(item.payload?.currentSchedule ?? '-')} / suggested {String(item.payload?.recommendedSchedule)}
            </div>
          )}
          {errorMessage && (
            <div className="mt-2 text-xs text-status-error">{errorMessage}</div>
          )}
        </div>
        <div className="flex items-start gap-2 shrink-0">
          {acceptable && (
            <button
              type="button"
              className="rounded bg-accent px-2 py-1 text-xs font-medium text-bg-primary hover:bg-accent/90 disabled:opacity-50"
              disabled={busy}
              onClick={onAccept}
              aria-label={`Accept recommendation: ${actionLabel} (${item.project})`}
              title="Apply the suggested change automatically"
            >
              {busy ? 'applying…' : 'Accept'}
            </button>
          )}
          <button
            type="button"
            className="rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
            disabled={busy}
            onClick={onDismiss}
            aria-label={`Dismiss recommendation: ${actionLabel} (${item.project})`}
          >
            dismiss
          </button>
        </div>
      </div>
    </div>
  )
}

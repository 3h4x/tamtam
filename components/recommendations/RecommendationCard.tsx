'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import type { Recommendation } from '@/lib/client-api'
import { AUTO_APPLICABLE_RECOMMENDATION_TYPES } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'

function typeLabel(type: string): string {
  if (type === 'agent_schedule_backoff') return 'schedule'
  return type.replace(/_/g, ' ')
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function booleanLabel(value: unknown): string | null {
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return null
}

function recommendationReasoning(payload: Recommendation['payload']): Array<{ label: string; value: string }> {
  const raw = payload?.reasoning
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const reasoning = raw as Record<string, unknown>
  const rows: Array<{ label: string; value: string }> = []
  const summary = stringValue(reasoning.summary)
  const actionableWork = booleanLabel(reasoning.actionableWork)
  const filesChangedCount = numberValue(reasoning.filesChangedCount)
  const currentSchedule = stringValue(reasoning.currentSchedule)
  const recommendedSchedule = stringValue(reasoning.recommendedSchedule)
  const confidence = stringValue(reasoning.confidence)
  const sourceJobId = stringValue(reasoning.sourceJobId)

  if (summary) rows.push({ label: 'summary', value: summary })
  if (actionableWork) rows.push({ label: 'actionable work', value: actionableWork })
  if (filesChangedCount != null) rows.push({ label: 'files changed', value: String(filesChangedCount) })
  if (currentSchedule && recommendedSchedule) rows.push({ label: 'cadence', value: `${currentSchedule} → ${recommendedSchedule}` })
  if (confidence) rows.push({ label: 'confidence', value: confidence })
  if (sourceJobId) rows.push({ label: 'source job', value: sourceJobId })
  return rows
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
  const reasoningRows = recommendationReasoning(item.payload)
  return (
    <div className="border-b border-border last:border-b-0 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Pill
              tone="accent"
              size="xs"
              className="rounded px-1.5 text-[10px] font-mono border-accent/25"
            >
              {typeLabel(item.type)}
            </Pill>
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
          {reasoningRows.length > 0 && (
            <div className="mt-2 rounded border border-border bg-bg-secondary/50 p-2">
              <div className="font-mono text-[10px] uppercase text-text-tertiary">Why</div>
              <dl className="mt-1 grid gap-1 text-xs">
                {reasoningRows.map((row) => (
                  <div key={row.label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                    <dt className="font-mono text-text-tertiary">{row.label}</dt>
                    <dd className="min-w-0 break-words text-text-secondary">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {errorMessage && (
            <div className="mt-2 text-xs text-status-error">{errorMessage}</div>
          )}
        </div>
        <div className="flex items-start gap-2 shrink-0">
          {acceptable && (
            <Button
              type="button"
              variant="solid"
              size="sm"
              className="rounded text-bg-primary hover:bg-accent/90"
              disabled={busy}
              onClick={onAccept}
              aria-label={`Accept recommendation: ${actionLabel} (${item.project})`}
              title="Apply the suggested change automatically"
            >
              {busy ? 'applying…' : 'Accept'}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded bg-bg-tertiary text-text-secondary hover:text-text-primary"
            disabled={busy}
            onClick={onDismiss}
            aria-label={`Dismiss recommendation: ${actionLabel} (${item.project})`}
          >
            dismiss
          </Button>
        </div>
      </div>
    </div>
  )
}

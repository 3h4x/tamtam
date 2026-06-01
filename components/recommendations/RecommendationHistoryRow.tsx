'use client'

import Link from 'next/link'
import { buttonVariants } from '@/components/ui/Button'
import { Pill, type PillTone } from '@/components/ui/Pill'
import type { Recommendation } from '@/lib/client-api'
import { formatAgo } from '@/lib/shared/format'

// How a recommendation left the open list. `resolved` is the orchestrator
// auto-closing it on recovery; `applied` / `dismissed` are operator actions.
function stateChip(status: string): { text: string; tone: PillTone } {
  if (status === 'resolved') return { text: 'auto-resolved', tone: 'success' }
  if (status === 'applied') return { text: 'applied', tone: 'accent' }
  if (status === 'dismissed') return { text: 'dismissed', tone: 'neutral' }
  return { text: status, tone: 'neutral' }
}

function typeLabel(type: string): string {
  if (type === 'agent_schedule_backoff') return 'schedule'
  if (type === 'orchestrator_boost') return 'boost'
  if (type === 'orchestrator_agent_health') return 'health'
  if (type === 'agent_unfruitful') return 'unfruitful'
  return type.replace(/_/g, ' ')
}

// Read-only row for the History tab: shows what the recommendation was and how
// it was resolved. No Fix/dismiss controls — history is a record, not a queue.
export function RecommendationHistoryRow({ item }: { item: Recommendation }) {
  const chip = stateChip(item.status)
  return (
    <div className="border-b border-border last:border-b-0 p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Pill tone={chip.tone} size="xs" className="rounded px-1.5 text-[10px] font-mono">
          {chip.text}
        </Pill>
        <Pill tone="accent" size="xs" className="rounded px-1.5 text-[10px] font-mono border-accent/25">
          {typeLabel(item.type)}
        </Pill>
        {item.agent_name && <span className="font-mono text-xs text-text-tertiary">agent:{item.agent_name}</span>}
        <span className="font-mono text-xs text-text-tertiary">updated {formatAgo(item.updated_at)}</span>
        <Link
          href={`/project/${encodeURIComponent(item.project)}`}
          className={buttonVariants({ variant: 'link', size: 'sm', className: 'font-mono' })}
        >
          {item.project} →
        </Link>
      </div>
      <div className="mt-1 text-sm text-text-secondary">{item.title}</div>
    </div>
  )
}

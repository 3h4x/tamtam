'use client'

import { useCallback, useState } from 'react'
import { Pill, type PillTone } from '@/components/ui/Pill'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { usePolling } from '@/hooks/usePolling'
import { fetchAttention, type AttentionItem, type AttentionCounts, type AttentionSeverity } from '@/lib/client-api'
import { AttentionRow } from '@/components/attention/AttentionRow'
import { dispatchAttentionAction } from '@/components/attention/attention-actions'

const SEVERITY_TONE: Record<AttentionSeverity, PillTone> = {
  red: 'error',
  yellow: 'warning',
  green: 'success',
}

const SEVERITY_LABEL: Record<AttentionSeverity, string> = {
  red: 'Urgent',
  yellow: 'Needs attention',
  green: 'Ready',
}

/**
 * The merged Inbox feed: derived inbox signals interleaved with open
 * recommendations, one `AttentionRow` per item, auto-refreshed every 30s while
 * visible. `project` narrows to a single repo (the per-project banner), where
 * rows start expanded so the full reason is visible on landing.
 */
export function AttentionFeed({ project }: { project?: string }) {
  const visible = useDocumentVisible()
  const [items, setItems] = useState<AttentionItem[]>([])
  const [counts, setCounts] = useState<AttentionCounts>({ red: 0, yellow: 0, green: 0, total: 0 })
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const data = await fetchAttention(project ? { project } : undefined)
    setItems(data.items)
    setCounts(data.counts)
    setLoaded(true)
  }, [project])

  usePolling(load, { intervalMs: 30_000, enabled: visible })

  if (!loaded) return <LoadingState />

  if (items.length === 0) {
    return (
      <EmptyState
        paddingY="lg"
        title="All caught up."
        description="No pending decisions or recommendations. New items appear here as CI, reviews, releases, and agent runs progress."
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-text-secondary">
          {counts.total} item{counts.total === 1 ? '' : 's'}
        </span>
        {(['red', 'yellow', 'green'] as AttentionSeverity[]).map((sev) =>
          counts[sev] > 0 ? (
            <Pill key={sev} tone={SEVERITY_TONE[sev]} size="xs">
              {counts[sev]} {SEVERITY_LABEL[sev]}
            </Pill>
          ) : null,
        )}
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <AttentionRow
            key={item.id}
            item={item}
            onRun={dispatchAttentionAction}
            onResolved={load}
            defaultExpanded={Boolean(project)}
          />
        ))}
      </div>
    </div>
  )
}

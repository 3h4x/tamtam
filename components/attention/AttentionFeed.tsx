'use client'

import { useCallback, useState } from 'react'
import { Pill, type PillTone } from '@/components/ui/Pill'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { usePolling } from '@/hooks/usePolling'
import { fetchAttention, type AttentionItem, type AttentionSeverity } from '@/lib/client-api'
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
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const data = await fetchAttention(project ? { project } : undefined)
    setItems(data.items)
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

  // Genuine shippability DECISIONS (inbox signals) vs non-blocking agent-quality
  // ADVISORIES (recommendations). Only signals belong under "Needs your
  // decision"; advisories get a muted "Agent health" group below.
  const signals = items.filter((i) => i.source === 'signal')
  const advisories = items.filter((i) => i.source === 'recommendation')
  const countBy = (list: AttentionItem[]): Record<AttentionSeverity, number> => {
    const c: Record<AttentionSeverity, number> = { red: 0, yellow: 0, green: 0 }
    for (const i of list) c[i.severity] += 1
    return c
  }
  const signalCounts = countBy(signals)

  return (
    <div className="space-y-6">
      {signals.length > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-sm font-semibold text-text-primary">Needs your decision</span>
            <span className="text-text-secondary">
              {signals.length} action{signals.length === 1 ? '' : 's'} waiting on you
            </span>
            {(['red', 'yellow', 'green'] as AttentionSeverity[]).map((sev) =>
              signalCounts[sev] > 0 ? (
                <Pill key={sev} tone={SEVERITY_TONE[sev]} size="xs">
                  {signalCounts[sev]} {SEVERITY_LABEL[sev]}
                </Pill>
              ) : null,
            )}
          </div>
          <div className="space-y-2">
            {signals.map((item) => (
              <AttentionRow
                key={item.id}
                item={item}
                onRun={dispatchAttentionAction}
                onResolved={load}
                defaultExpanded={Boolean(project)}
              />
            ))}
          </div>
        </section>
      )}

      {advisories.length > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-sm font-semibold text-text-tertiary">Agent health</span>
            <span className="text-text-tertiary">
              {advisories.length} advisor{advisories.length === 1 ? 'y' : 'ies'} · not blocking
            </span>
          </div>
          <div className="space-y-2">
            {advisories.map((item) => (
              <AttentionRow
                key={item.id}
                item={item}
                onRun={dispatchAttentionAction}
                onResolved={load}
                defaultExpanded={false}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

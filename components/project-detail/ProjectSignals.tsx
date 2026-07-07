'use client'

import { useCallback, useState } from 'react'
import { Pill, type PillTone } from '@/components/ui/Pill'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { usePolling } from '@/hooks/usePolling'
import { AttentionRow } from '@/components/attention/AttentionRow'
import { dispatchAttentionAction } from '@/components/attention/attention-actions'
import { fetchAttention, type AttentionItem, type AttentionSeverity } from '@/lib/client-api'

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

// Severity → tinted banner frame. The banner adopts the colour of its most
// severe item so a blocked project reads as blocked at a glance.
const SEVERITY_FRAME: Record<AttentionSeverity, string> = {
  red: 'border-status-error/40 bg-status-error/10',
  yellow: 'border-status-warning/40 bg-status-warning/10',
  green: 'border-status-success/40 bg-status-success/10',
}

// Per-project slice of the merged Inbox feed, surfaced inline on the project page
// so an operator who opens a blocked/paused project sees the actionable reason —
// both pipeline signals AND agent recommendations — with the same one-click
// actions right there. Renders nothing when the project has no pending items.
export function ProjectSignals({ projectName }: { projectName: string }) {
  const visible = useDocumentVisible()
  const [items, setItems] = useState<AttentionItem[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await fetchAttention({ project: projectName })
      setItems(data.items)
    } finally {
      setLoaded(true)
    }
  }, [projectName])

  usePolling(load, { intervalMs: 15_000, enabled: visible })

  // Healthy project (no pending items) → render nothing, so the banner only
  // appears when there is something to act on.
  if (!loaded || items.length === 0) return null

  // Split the merged feed into genuine shippability DECISIONS (inbox signals)
  // and non-blocking agent-quality ADVISORIES (recommendations). Only the
  // former belong under "Needs your decision"; advisories move to a muted
  // "Agent health" subsection so agent nudges stop reading as blockers.
  const signals = items.filter((i) => i.source === 'signal')
  const advisories = items.filter((i) => i.source === 'recommendation')
  const countBy = (list: AttentionItem[]): Record<AttentionSeverity, number> => {
    const c: Record<AttentionSeverity, number> = { red: 0, yellow: 0, green: 0 }
    for (const i of list) c[i.severity] += 1
    return c
  }
  const signalCounts = countBy(signals)

  // The banner frame adopts the most-severe SIGNAL colour (real decisions drive
  // the alarm); items are pre-sorted red → yellow → green, so signals[0] is the
  // most severe. An advisory-only banner stays neutral — no alarm frame.
  const frame = signals.length > 0 ? SEVERITY_FRAME[signals[0].severity] : 'border-border'

  return (
    <section
      aria-label="Decisions needed for this project"
      className={`mb-3 rounded-lg border p-3 ${frame}`}
    >
      {signals.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-text-primary">Needs your decision</span>
            <span className="text-xs text-text-secondary">
              {signals.length} action{signals.length === 1 ? '' : 's'} waiting on you
            </span>
            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              {(['red', 'yellow', 'green'] as AttentionSeverity[]).map((sev) =>
                signalCounts[sev] > 0 ? (
                  <Pill key={sev} tone={SEVERITY_TONE[sev]} size="xs">
                    {signalCounts[sev]} {SEVERITY_LABEL[sev]}
                  </Pill>
                ) : null,
              )}
            </span>
          </div>
          <div className="space-y-2">
            {signals.map((item) => (
              <AttentionRow key={item.id} item={item} onRun={dispatchAttentionAction} onResolved={load} defaultExpanded />
            ))}
          </div>
        </>
      )}

      {advisories.length > 0 && (
        <div className={signals.length > 0 ? 'mt-3 border-t border-border/60 pt-3' : ''}>
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">Agent health</span>
            <span className="text-xs text-text-tertiary">
              {advisories.length} advisor{advisories.length === 1 ? 'y' : 'ies'} · not blocking
            </span>
          </div>
          <div className="space-y-2">
            {advisories.map((item) => (
              <AttentionRow key={item.id} item={item} onRun={dispatchAttentionAction} onResolved={load} defaultExpanded={false} />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

'use client'

import { useCallback, useState } from 'react'
import { Pill, type PillTone } from '@/components/ui/Pill'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { usePolling } from '@/hooks/usePolling'
import { SignalRow } from '@/components/InboxFeed'
import { fetchInbox, type InboxSignal, type InboxSeverity } from '@/lib/client-api'

const SEVERITY_TONE: Record<InboxSeverity, PillTone> = {
  red: 'error',
  yellow: 'warning',
  green: 'success',
}

const SEVERITY_LABEL: Record<InboxSeverity, string> = {
  red: 'Urgent',
  yellow: 'Needs attention',
  green: 'Ready',
}

// Severity → tinted banner frame. The banner adopts the colour of its most
// severe signal so a blocked project reads as blocked at a glance.
const SEVERITY_FRAME: Record<InboxSeverity, string> = {
  red: 'border-status-error/40 bg-status-error/10',
  yellow: 'border-status-warning/40 bg-status-warning/10',
  green: 'border-status-success/40 bg-status-success/10',
}

// Per-project slice of the inbox feed, surfaced inline on the project page so an
// operator who opens a blocked/paused project sees the actionable reason (and
// the same one-click action) right there instead of only in the cross-project
// inbox. Renders nothing when the project has no pending decisions.
export function ProjectSignals({ projectName }: { projectName: string }) {
  const visible = useDocumentVisible()
  const [signals, setSignals] = useState<InboxSignal[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await fetchInbox({ project: projectName })
      setSignals(data.signals)
    } finally {
      setLoaded(true)
    }
  }, [projectName])

  usePolling(load, { intervalMs: 15_000, enabled: visible })

  // Healthy project (no pending decisions) → render nothing, so the banner only
  // appears when there is something to act on.
  if (!loaded || signals.length === 0) return null

  // Signals arrive pre-sorted red → yellow → green, so signals[0] is the most
  // severe; use it to colour the banner frame.
  const topSeverity = signals[0].severity
  const counts: Record<InboxSeverity, number> = { red: 0, yellow: 0, green: 0 }
  for (const s of signals) counts[s.severity] += 1

  return (
    <section
      aria-label="Decisions needed for this project"
      className={`mb-3 rounded-lg border p-3 ${SEVERITY_FRAME[topSeverity]}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-text-primary">Needs your decision</span>
        <span className="text-xs text-text-secondary">
          {signals.length} action{signals.length === 1 ? '' : 's'} waiting on you
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {(['red', 'yellow', 'green'] as InboxSeverity[]).map((sev) =>
            counts[sev] > 0 ? (
              <Pill key={sev} tone={SEVERITY_TONE[sev]} size="xs">
                {counts[sev]} {SEVERITY_LABEL[sev]}
              </Pill>
            ) : null,
          )}
        </span>
      </div>
      <div className="space-y-2">
        {signals.map((signal) => (
          <SignalRow key={signal.id} signal={signal} onResolved={load} defaultExpanded />
        ))}
      </div>
    </section>
  )
}

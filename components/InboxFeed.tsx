'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/Button'
import { Pill, type PillTone } from '@/components/ui/Pill'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { useToast } from '@/components/Toast'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { usePolling } from '@/hooks/usePolling'
import {
  fetchInbox,
  fixCi,
  releaseProject,
  reviewProject,
  mergePR,
  resolveConflicts,
  resumeProject,
  retryAutomationQueue,
  type InboxSignal,
  type InboxCounts,
  type InboxSeverity,
} from '@/lib/client-api'

const SEVERITY_TONE: Record<InboxSeverity, PillTone> = {
  red: 'error',
  yellow: 'warning',
  green: 'success',
}

const SEVERITY_DOT: Record<InboxSeverity, string> = {
  red: 'bg-status-error',
  yellow: 'bg-status-warning',
  green: 'bg-status-success',
}

const SEVERITY_LABEL: Record<InboxSeverity, string> = {
  red: 'Urgent',
  yellow: 'Needs attention',
  green: 'Ready',
}

function formatAge(seconds: number | null): string | null {
  if (seconds == null) return null
  if (seconds < 60) return 'just now'
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Run the existing per-project endpoint that resolves the signal. Returns a
// human-readable success message for the toast.
async function runSignalAction(signal: InboxSignal): Promise<string> {
  const { project, action } = signal
  switch (action.kind) {
    case 'fix-ci':
      await fixCi(project)
      return `Started CI fix for ${project}`
    case 'release':
      await releaseProject(project, { queueIfBlocked: true })
      return `Started release for ${project}`
    case 'review':
      await reviewProject(project)
      return `Started review for ${project}`
    case 'merge': {
      if (action.prNumber == null) throw new Error('Missing PR number')
      await mergePR(project, action.prNumber)
      // A manual-merge HITL means the pipeline stalled waiting on this human
      // decision. Merging it is the operator saying "ship it and keep going",
      // so also clear any auto-pause — otherwise the project stays paused after
      // the merge and automation never resumes. (Merging a normal ready PR on a
      // healthy project doesn't touch pause state.)
      if (signal.type === 'pr_needs_manual_merge') {
        try {
          await resumeProject(project)
          return `Merged PR #${action.prNumber} in ${project} — automation resumed`
        } catch {
          return `Merged PR #${action.prNumber} in ${project} (could not auto-resume — resume manually)`
        }
      }
      return `Merged PR #${action.prNumber} in ${project}`
    }
    case 'resolve-conflicts': {
      if (action.prNumber == null) throw new Error('Missing PR number')
      await resolveConflicts(project, action.prNumber)
      // Fire-and-forget: the server spawns an agent that rebases onto the base,
      // resolves the hunks, force-pushes with lease, and re-drives the merge via
      // pr-wait (or re-raises this HITL if it can't resolve). The card clears on
      // the next poll once the PR is no longer conflicting.
      return `Resolving conflicts on PR #${action.prNumber} in ${project} — rebasing & re-driving the merge`
    }
    case 'retry-automation':
      await retryAutomationQueue(project)
      return `Retried automation queue for ${project}`
    case 'resume':
      await resumeProject(project)
      return `Resumed ${project}`
    default:
      throw new Error(`Unsupported action: ${action.kind}`)
  }
}

// Label for the external link, so a PR link doesn't read "View CI".
function externalLinkLabel(signal: InboxSignal): string {
  if ((signal.action.kind === 'merge' || signal.action.kind === 'resolve-conflicts') && signal.action.prNumber != null) {
    return `View PR #${signal.action.prNumber}`
  }
  if (signal.type === 'ci_red') return 'View CI'
  return 'View details'
}

// Action kinds that navigate instead of firing a server mutation. 'merge' and
// 'resolve-conflicts' are both explicit-consent server mutations (a conflicting
// PR is now resolved by an operator-triggered agent that rebases + resolves +
// force-pushes-with-lease server-side — see the resolve-conflicts route); only
// 'open-terminal' still just navigates.
const NAVIGATION_ACTION_KINDS = new Set<InboxSignal['action']['kind']>(['open-terminal'])

export function SignalRow({
  signal,
  onResolved,
  defaultExpanded = false,
}: {
  signal: InboxSignal
  onResolved: () => void
  /** Start expanded so the full reason (e.g. the high-risk files) is visible
   *  without a click — used by the project-page banner where the operator has
   *  landed specifically to understand why the project is blocked. */
  defaultExpanded?: boolean
}) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const age = formatAge(signal.ageSeconds)

  const onAction = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const message = await runSignalAction(signal)
      toast(message, 'success')
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('tamtam:inbox-changed'))
      }
      onResolved()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Action failed', 'error')
    } finally {
      setBusy(false)
    }
  }, [busy, signal, toast, onResolved])

  return (
    <div className="border border-border rounded-lg bg-bg-secondary">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${SEVERITY_DOT[signal.severity]}`}
          aria-hidden="true"
        />
        {/* Clickable header — expand to read the full reason and reach the source. */}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left cursor-pointer bg-transparent border-0 p-0"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`text-text-tertiary text-[10px] shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
              aria-hidden="true"
            >
              ›
            </span>
            <span className="font-medium text-text-primary truncate">{signal.project}</span>
            <Pill tone={SEVERITY_TONE[signal.severity]} size="xs">
              {signal.title}
            </Pill>
            {age && <span className="text-xs text-text-tertiary tabular-nums">{age}</span>}
          </div>
          {signal.detail && (
            <p className={`mt-0.5 text-xs text-text-secondary ${expanded ? 'whitespace-pre-wrap' : 'truncate'}`}>
              {signal.detail}
            </p>
          )}
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {NAVIGATION_ACTION_KINDS.has(signal.action.kind) ? (
            <Link
              href={signal.href}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              {signal.action.label}
            </Link>
          ) : (
            <Button
              variant={signal.severity === 'green' ? 'success' : 'primary'}
              size="sm"
              onClick={onAction}
              disabled={busy}
              disabledCursor="wait"
            >
              {busy ? '…' : signal.action.label}
            </Button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {signal.externalUrl && (
            <a
              href={signal.externalUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              {externalLinkLabel(signal)} ↗
            </a>
          )}
          <Link href={signal.href} className="text-accent hover:underline">
            Open in {signal.project} →
          </Link>
        </div>
      )}
    </div>
  )
}

export function InboxFeed() {
  const visible = useDocumentVisible()
  const [signals, setSignals] = useState<InboxSignal[]>([])
  const [counts, setCounts] = useState<InboxCounts>({ red: 0, yellow: 0, green: 0, total: 0 })
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const data = await fetchInbox()
    setSignals(data.signals)
    setCounts(data.counts)
    setLoaded(true)
  }, [])

  // Auto-refresh every 30s while the tab is visible; pause when hidden.
  usePolling(load, { intervalMs: 30_000, enabled: visible })

  if (!loaded) return <LoadingState />

  if (signals.length === 0) {
    return (
      <EmptyState
        paddingY="lg"
        title="All caught up."
        description="No pending decisions across your projects. New signals appear here as CI, reviews, and releases progress."
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-text-secondary">
          {counts.total} action{counts.total === 1 ? '' : 's'}
        </span>
        {(['red', 'yellow', 'green'] as InboxSeverity[]).map((sev) =>
          counts[sev] > 0 ? (
            <Pill key={sev} tone={SEVERITY_TONE[sev]} size="xs">
              {counts[sev]} {SEVERITY_LABEL[sev]}
            </Pill>
          ) : null,
        )}
      </div>
      <div className="space-y-2">
        {signals.map((signal) => (
          <SignalRow key={signal.id} signal={signal} onResolved={load} />
        ))}
      </div>
    </div>
  )
}

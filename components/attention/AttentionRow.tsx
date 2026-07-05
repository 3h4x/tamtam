'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/Button'
import { Pill, type PillTone } from '@/components/ui/Pill'
import { useToast } from '@/components/Toast'
import type { AttentionItem, AttentionAction, AttentionSeverity } from '@/lib/attention/types'

const SEVERITY_TONE: Record<AttentionSeverity, PillTone> = {
  red: 'error',
  yellow: 'warning',
  green: 'success',
}

const SEVERITY_DOT: Record<AttentionSeverity, string> = {
  red: 'bg-status-error',
  yellow: 'bg-status-warning',
  green: 'bg-status-success',
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

// A signal action whose href is the item's own href and merely navigates
// (no mutation). Recommendation link-actions instead carry their own `href`.
const NAV_SIGNAL_KINDS = new Set(['open-terminal'])
const isLinkAction = (a: AttentionAction) => Boolean(a.href) || NAV_SIGNAL_KINDS.has(a.kind)
const hrefForAction = (a: AttentionAction, item: AttentionItem) => a.href ?? item.href

/**
 * One row for BOTH a derived inbox signal and a persisted recommendation. A
 * signal shows its single action as a primary button (or a nav link); a
 * recommendation shows its Fix-menu actions in a `details` dropdown. The
 * `dismiss` action (present only on recommendations) is lifted out to a separate
 * secondary button, matching the existing recommendation-card UX.
 */
export function AttentionRow({
  item,
  onRun,
  onResolved,
  defaultExpanded = false,
}: {
  item: AttentionItem
  /** Perform the action's mutation; resolves to a success toast message or throws. */
  onRun: (item: AttentionItem, action: AttentionAction) => Promise<string>
  onResolved: () => void
  /** Start expanded (used by the per-project banner) so the full reason shows. */
  defaultExpanded?: boolean
}) {
  const { toast } = useToast()
  const [busyKind, setBusyKind] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const age = formatAge(item.ageSeconds)

  const dismissAction = item.actions.find((a) => a.kind === 'dismiss') ?? null
  const menuActions = item.actions.filter((a) => a.kind !== 'dismiss')

  const run = useCallback(
    async (action: AttentionAction) => {
      if (busyKind) return
      setBusyKind(action.kind)
      try {
        const message = await onRun(item, action)
        toast(message, 'success')
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('tamtam:inbox-changed'))
        onResolved()
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Action failed', 'error')
      } finally {
        setBusyKind(null)
      }
    },
    [busyKind, item, onRun, toast, onResolved],
  )

  const busy = busyKind !== null
  const single = menuActions.length === 1 && menuActions[0] ? menuActions[0] : null

  return (
    <div className="border border-border rounded-lg bg-bg-secondary">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${SEVERITY_DOT[item.severity]}`} aria-hidden="true" />
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
            <span className="font-medium text-text-primary truncate">{item.project}</span>
            <Pill tone={SEVERITY_TONE[item.severity]} size="xs">
              {item.title}
            </Pill>
            {item.agent && (
              <span className="font-mono text-xs text-text-tertiary">agent:{item.agent.name ?? item.agent.id}</span>
            )}
            {age && <span className="text-xs text-text-tertiary tabular-nums">{age}</span>}
          </div>
          {item.detail && (
            <p className={`mt-0.5 text-xs text-text-secondary ${expanded ? 'whitespace-pre-wrap' : 'truncate'}`}>
              {item.detail}
            </p>
          )}
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {/* A single non-dismiss action renders as one button (or nav link). */}
          {single &&
            (isLinkAction(single) ? (
              <Link href={hrefForAction(single, item)} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                {single.label}
              </Link>
            ) : (
              <Button
                variant={item.severity === 'green' ? 'success' : 'primary'}
                size="sm"
                onClick={() => run(single)}
                disabled={busy}
                disabledCursor="wait"
              >
                {busyKind === single.kind ? '…' : single.label}
              </Button>
            ))}
          {/* Multiple actions (a recommendation's Fix menu) render as a dropdown. */}
          {menuActions.length > 1 && (
            <details className="relative group">
              <summary
                className={buttonVariants({
                  variant: 'solid',
                  size: 'sm',
                  className: 'list-none select-none [&::-webkit-details-marker]:hidden',
                })}
                aria-label={`Fix: ${item.title} (${item.project})`}
              >
                {busy ? 'working…' : 'Fix ▾'}
              </summary>
              <div className="absolute right-0 z-10 mt-1 w-52 overflow-hidden rounded border border-border bg-bg-secondary shadow-lg">
                {menuActions.map((action) =>
                  isLinkAction(action) ? (
                    <Link
                      key={action.kind}
                      href={hrefForAction(action, item)}
                      className={buttonVariants({
                        variant: 'ghost',
                        size: 'sm',
                        className: 'w-full justify-start rounded-none px-3 py-2 font-normal',
                      })}
                    >
                      {action.label}
                    </Link>
                  ) : (
                    <Button
                      key={action.kind}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start rounded-none px-3 py-2 font-normal"
                      disabled={busy}
                      onClick={() => run(action)}
                    >
                      {busyKind === action.kind ? '…' : action.label}
                    </Button>
                  ),
                )}
              </div>
            </details>
          )}
          {dismissAction && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded bg-bg-tertiary text-text-secondary hover:text-text-primary"
              disabled={busy}
              onClick={() => run(dismissAction)}
              aria-label={`Dismiss: ${item.title} (${item.project})`}
            >
              {busyKind === 'dismiss' ? '…' : 'Dismiss'}
            </Button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {item.externalUrl && (
            <a href={item.externalUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              View details ↗
            </a>
          )}
          <Link href={item.href} className="text-accent hover:underline">
            Open in {item.project} →
          </Link>
        </div>
      )}
    </div>
  )
}

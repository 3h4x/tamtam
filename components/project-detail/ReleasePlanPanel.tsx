'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { InlineLoading } from '@/components/ui/InlineLoading'
import { Pill } from '@/components/ui/Pill'
import { fetchReleasePlan } from '@/lib/client-api'
import type { ReleasePlan } from '@/lib/pipeline/release-plan'

export interface ReleasePlanPanelProps {
  projectName: string
  /** Changes any time branch/state/config that affects the plan changes, so an
   *  open panel re-fetches without the operator re-toggling. */
  refreshKey: string
}

const STEP_LABEL: Record<string, string> = {
  test: 'Test',
  review: 'Review',
  commit: 'Commit',
  push: 'Push',
  'mark-dod': 'Mark DoD',
  'pr-wait': 'PR wait / merge',
  soak: 'Soak',
}

export function ReleasePlanPanel({ projectName, refreshKey }: ReleasePlanPanelProps) {
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<ReleasePlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setPlan(await fetchReleasePlan(projectName))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPlan(null)
    } finally {
      setLoading(false)
    }
  }, [projectName])

  // Re-fetch whenever the plan inputs change while the panel is open.
  useEffect(() => {
    if (open) void load()
  }, [open, refreshKey, load])

  return (
    <div className="w-full">
      <Button
        type="button"
        onClick={() => setOpen((v) => !v)}
        variant="ghost"
        size="sm"
        className="rounded-none border-0 bg-transparent px-0 py-0 hover:bg-transparent"
        aria-expanded={open}
        title="Preview the release pipeline plan without running anything"
      >
        <span aria-hidden="true" className="text-text-tertiary">{open ? '▾' : '▸'}</span>
        Release plan {open ? '(dry-run)' : '— preview'}
      </Button>

      {open && (
        <div className="mt-2 rounded-md border border-border bg-bg-secondary p-3 text-sm">
          {loading && (
            <InlineLoading label="Computing plan…" className="text-text-secondary" />
          )}
          {error && !loading && (
            <div className="flex items-center justify-between gap-2 text-status-error">
              <span>{error}</span>
              <Button size="sm" variant="ghost" onClick={() => void load()}>Retry</Button>
            </div>
          )}
          {plan && !loading && !error && <PlanBody plan={plan} />}
        </div>
      )}
    </div>
  )
}

function PlanBody({ plan }: { plan: ReleasePlan }) {
  const willRun = plan.steps.filter((s) => s.willRun)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
        <Pill size="xs" className="bg-bg-tertiary uppercase tracking-wider">
          {plan.mode === 'pr' ? 'PR workflow' : 'Direct branch'}
        </Pill>
        <span className="font-mono tabular-nums">
          {plan.currentBranch || '(detached)'} → {plan.targetBranch || '?'}
        </span>
        {plan.comparisonRange && (
          <span className="font-mono tabular-nums text-text-tertiary">{plan.comparisonRange}</span>
        )}
      </div>

      {plan.blockers.length > 0 && (
        <ul className="space-y-1 rounded border border-status-error/40 bg-status-error/10 p-2 text-xs text-status-error">
          {plan.blockers.map((b) => (
            <li key={b.code}>⛔ {b.detail}</li>
          ))}
        </ul>
      )}

      {willRun.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {willRun.map((s, i) => (
            <span key={s.kind} className="inline-flex items-center gap-1.5">
              {i > 0 && <span aria-hidden="true" className="text-text-tertiary">→</span>}
              <Pill size="xs" className="bg-accent/15 text-accent">{STEP_LABEL[s.kind] ?? s.kind}</Pill>
            </span>
          ))}
        </div>
      )}

      <ol className="space-y-1.5">
        {plan.steps.map((s) => (
          <li
            key={s.kind}
            className={`flex items-start gap-2 ${s.willRun ? 'text-text-primary' : 'text-text-tertiary'}`}
          >
            <span aria-hidden="true" className="mt-0.5 w-4 shrink-0 text-center">
              {s.willRun ? '✓' : '·'}
            </span>
            <div className="min-w-0">
              <span className="font-medium">{STEP_LABEL[s.kind] ?? s.kind}</span>
              <span className="text-text-secondary"> — {s.reason}</span>
              {s.comparisonRange && (
                <span className="ml-1 font-mono text-xs text-text-tertiary">[{s.comparisonRange}]</span>
              )}
              {s.willRun && s.sideEffects.length > 0 && (
                <ul className="ml-1 list-disc pl-4 text-xs text-text-tertiary">
                  {s.sideEffects.map((eff) => (
                    <li key={eff}>{eff}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

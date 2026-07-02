'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Pill, type PillTone } from '@/components/ui/Pill'
import { Spinner } from '@/components/ui/Spinner'
import { StatusIcon } from '@/components/ui/StatusIcon'
import { runKindDisplayName } from '@/components/project-runs/kinds'
import type { JobTraceStep } from '@/lib/jobs/job-trace-types'

function formatStepDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return ''
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

function formatTs(secs: number): string {
  return new Date(secs * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
}

function StepGlyph({ step }: { step: JobTraceStep }) {
  if (step.status === 'running') return <Spinner size="sm" color="accent" />
  if (step.status === 'aborted') return <StatusIcon ok={false} size="sm" ariaLabel="aborted" />
  if (step.exit_code === 0) return <StatusIcon ok={true} size="sm" ariaLabel="done" />
  if (step.verdict === 'NEEDS ATTENTION') return <span className="font-bold text-status-warning">!</span>
  if (step.verdict === 'LGTM') return <StatusIcon ok={true} size="sm" ariaLabel="LGTM" />
  return <StatusIcon ok={false} size="sm" ariaLabel="failed" />
}

function VerdictBadge({ verdict }: { verdict: string | null }) {
  if (!verdict) return null
  const tone: PillTone = verdict === 'LGTM' ? 'success' : verdict === 'NEEDS ATTENTION' ? 'warning' : 'error'
  return (
    <Pill tone={tone} size="xs" className="rounded px-1.5 font-mono text-[10px]">
      {verdict}
    </Pill>
  )
}

function stepDurationMs(step: JobTraceStep): number | null {
  if (step.duration_ms != null) return step.duration_ms
  if (step.finished_at != null) return Math.round((step.finished_at - step.started_at) * 1000)
  return null
}

interface PipelineTimelineProps {
  steps: JobTraceStep[]
  projectName: string
  /** Text shown when the release/unit has no recorded steps yet. */
  emptyLabel?: string
}

// Vertical pipeline step timeline: node glyph, phase name, verdict, duration,
// timestamp, deep-link to the full terminal log, and an expandable excerpt.
// Shared by the history detail drawer and the release trace page.
export function PipelineTimeline({ steps, projectName, emptyLabel = 'No pipeline steps recorded yet' }: PipelineTimelineProps) {
  const [openStep, setOpenStep] = useState<string | null>(null)

  if (steps.length === 0) {
    return <EmptyState title={emptyLabel} paddingY="xs" align="start" className="px-2" />
  }

  return (
    <div className="relative">
      <div className="absolute bottom-4 left-[19px] top-4 w-px bg-border" />
      <div className="space-y-3">
        {steps.map((step) => {
          const isOpen = openStep === step.job_id
          const dur = formatStepDuration(stepDurationMs(step))
          const phaseTone =
            step.status === 'running' ? 'text-accent' :
            step.status === 'aborted' ? 'text-status-error' :
            step.exit_code === 0 || step.verdict === 'LGTM' ? 'text-text-primary' :
            step.verdict === 'NEEDS ATTENTION' ? 'text-status-warning' :
            step.exit_code !== null ? 'text-status-error' : 'text-text-secondary'
          return (
            <div key={step.job_id} className="relative pl-10">
              <div className="absolute left-[11px] top-3 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-border bg-bg-primary text-[11px]">
                <StepGlyph step={step} />
              </div>
              <div className="overflow-hidden rounded-md border border-border bg-bg-secondary">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full !justify-start !gap-3 !rounded-none !border-0 bg-transparent !px-4 !py-3 text-left !font-normal text-text-primary hover:!bg-bg-tertiary"
                  onClick={() => setOpenStep(isOpen ? null : step.job_id)}
                  title={runKindDisplayName(step.kind)}
                >
                  <span className={`w-24 shrink-0 font-mono text-sm font-semibold ${phaseTone}`}>{step.kind}</span>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <VerdictBadge verdict={step.verdict} />
                    {dur && <span className="font-mono text-[10px] text-text-tertiary">{dur}</span>}
                    {step.status === 'running' && <span className="font-mono text-[10px] text-accent">running…</span>}
                    {step.status === 'aborted' && <span className="font-mono text-[10px] text-status-error">cancelled</span>}
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-text-tertiary">{formatTs(step.started_at)}</span>
                  <Link
                    href={`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(step.job_id)}`}
                    className={buttonVariants({ variant: 'link', className: 'z-10 shrink-0 font-mono text-[10px]' })}
                    onClick={(e) => e.stopPropagation()}
                  >
                    full log →
                  </Link>
                  <span className={`text-xs text-text-tertiary transition-transform ${isOpen ? 'rotate-180' : ''}`}>▾</span>
                </Button>
                {isOpen && (
                  <div className="border-t border-border px-4 pb-3">
                    {step.log_excerpt ? (
                      <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-secondary">
                        {step.log_excerpt}
                      </pre>
                    ) : (
                      <p className="mt-2 font-mono text-xs text-text-tertiary">no log excerpt available</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

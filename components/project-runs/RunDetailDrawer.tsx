'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Drawer } from '@/components/ui/Drawer'
import { Pill } from '@/components/ui/Pill'
import { PulseDot } from '@/components/ui/PulseDot'
import { Spinner } from '@/components/ui/Spinner'
import { buttonVariants } from '@/components/ui/Button'
import { ErrorState } from '@/components/ErrorState'
import { PipelineTimeline } from '@/components/project-runs/PipelineTimeline'
import { formatCost, formatTokens } from '@/components/project-runs/formatting'
import { formatRunSummaryText } from '@/components/project-runs/run-summary'
import { rowStateInfo, gemmaOutcomeInfo, promptBloat } from '@/components/project-runs/presentation'
import { bucketOf, KIND_COLOR, KIND_LABEL, runKindDisplayName } from '@/components/project-runs/kinds'
import type { JobTrace } from '@/lib/jobs/job-trace-types'

interface RunDetailDrawerProps {
  projectName: string
  jobId: string | null
  onClose: () => void
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function headingFor(t: JobTrace): string {
  if (t.kind.startsWith('agent:')) return t.kind.replace(/^agent:/, '')
  if (t.kind === 'run') return t.prompt ? truncate(t.prompt, 120) : 'Chat'
  if (t.kind === 'release') return 'Release pipeline'
  return runKindDisplayName(t.kind)
}

function fmtDurationMs(ms: number | null): string {
  if (ms === null || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border px-4 py-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{label}</div>
      {children}
    </section>
  )
}

function Meta({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${tone ?? 'text-text-primary'}`}>{value}</div>
    </div>
  )
}

export function RunDetailDrawer({ projectName, jobId, onClose }: RunDetailDrawerProps) {
  const [trace, setTrace] = useState<JobTrace | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!jobId) return
    let active = true
    let interval: ReturnType<typeof setInterval> | null = null
    setTrace(null)
    setError(null)
    setLoading(true)

    const load = async (): Promise<JobTrace | null> => {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/trace`)
        if (!res.ok) {
          if (active) setError(res.status === 404 ? 'Run not found' : `Error ${res.status}`)
          return null
        }
        const data: JobTrace = await res.json()
        if (active) {
          setTrace(data)
          setError(null)
        }
        return data
      } catch {
        if (active) setError('Failed to load run detail')
        return null
      } finally {
        if (active) setLoading(false)
      }
    }

    void load().then((data) => {
      // Poll while the unit or its release is still running.
      if (!active || !data || data.status !== 'running') return
      interval = setInterval(async () => {
        const next = await load()
        if (next && next.status !== 'running' && interval) {
          clearInterval(interval)
          interval = null
        }
      }, 4000)
    })

    return () => {
      active = false
      if (interval) clearInterval(interval)
    }
  }, [jobId])

  const title = trace ? (() => {
    const bucket = bucketOf(trace.kind)
    const state = rowStateInfo({
      isRunning: trace.status === 'running',
      isFailed: trace.status === 'aborted' || (trace.exit_code !== null && trace.exit_code !== 0),
      exitCode: trace.exit_code,
    })
    return (
      <div className="flex min-w-0 items-center gap-2">
        <span className={`inline-flex h-5 shrink-0 items-center rounded px-1.5 font-mono text-[10px] font-semibold ${KIND_COLOR[bucket]}`}>
          {KIND_LABEL[bucket]}
        </span>
        <span className="min-w-0 truncate text-sm font-semibold text-text-primary" title={headingFor(trace)}>
          {headingFor(trace)}
        </span>
        <Pill tone={state.tone} size="xs" className="h-5 shrink-0 gap-1.5 rounded px-1.5 text-[10px]">
          {state.running && <PulseDot size="xs" />}
          {state.label}
        </Pill>
      </div>
    )
  })() : <span className="text-sm font-semibold text-text-primary">Run detail</span>

  const report = trace ? formatRunSummaryText(trace.workSummary) : null
  const bloat = trace ? promptBloat(trace.usage.promptBytes) : null
  const gemma = trace ? gemmaOutcomeInfo(trace.context.outcomeVerdict) : null

  return (
    <Drawer open={jobId !== null} onClose={onClose} title={title}>
      {loading && !trace && (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-text-secondary">
          <Spinner size="sm" /> Loading run detail…
        </div>
      )}
      {error && !trace && (
        <div className="p-4">
          <ErrorState message={error} hint={jobId ? `Job ${jobId.slice(-12)}` : undefined} />
        </div>
      )}
      {trace && (
        <div>
          {/* Meta strip */}
          <div className="grid grid-cols-2 gap-3 px-4 py-3 sm:grid-cols-4">
            <Meta label="duration" value={fmtDurationMs(trace.duration_ms ?? (trace.finished_at ? Math.round((trace.finished_at - trace.started_at) * 1000) : null))} />
            <Meta label="cost" value={trace.usage.costUsd > 0 ? formatCost(trace.usage.costUsd) : '—'} tone="text-accent" />
            <Meta label="model" value={trace.usage.model ?? '—'} tone="text-accent" />
            <Meta
              label="score"
              value={trace.context.runScore != null ? trace.context.runScore : '—'}
              tone={trace.context.runScore != null && trace.context.runScore < 40 ? 'text-status-warning' : 'text-text-primary'}
            />
          </div>

          {/* Trigger */}
          {trace.trigger && (
            <Section label="trigger">
              <div className="text-xs text-text-secondary">
                <Link
                  href={`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(trace.trigger.job_id)}`}
                  className={buttonVariants({ variant: 'link', className: 'font-mono text-xs' })}
                >
                  ← {trace.trigger.label}
                </Link>
                {trace.trigger.prompt && (
                  <span className="ml-2 italic text-text-tertiary">“{truncate(trace.trigger.prompt, 160)}”</span>
                )}
              </div>
            </Section>
          )}

          {/* Pipeline */}
          {(trace.steps.length > 0 || trace.release_id) && (
            <Section label="pipeline">
              <PipelineTimeline steps={trace.steps} projectName={projectName} />
            </Section>
          )}

          {/* Report */}
          {report && (
            <Section label="report">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-text-secondary">{report}</pre>
            </Section>
          )}

          {/* Files */}
          {trace.files.files.length > 0 && (
            <Section label={`files changed · ${trace.files.files.length}`}>
              {(trace.files.linesAdded != null || trace.files.linesRemoved != null) && (
                <div className="mb-2 font-mono text-xs tabular-nums">
                  <span className="text-status-success">+{trace.files.linesAdded ?? 0}</span>{' '}
                  <span className="text-status-error">−{trace.files.linesRemoved ?? 0}</span>
                </div>
              )}
              <ul className="space-y-0.5">
                {trace.files.files.map((f) => (
                  <li key={f} className="truncate font-mono text-xs text-text-secondary" title={f}>{f}</li>
                ))}
              </ul>
            </Section>
          )}

          {/* Usage */}
          <Section label="usage">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs tabular-nums text-text-secondary">
              <span title="Input / output tokens">
                <span className="text-status-success">↑{formatTokens(trace.usage.inputTokens)}</span>{' '}
                <span className="text-accent">↓{formatTokens(trace.usage.outputTokens)}</span>
              </span>
              {trace.usage.cacheReadTokens > 0 && (
                <span className="text-text-tertiary">cache ↑{formatTokens(trace.usage.cacheReadTokens)}</span>
              )}
              {trace.usage.costUsd > 0 && <span>{formatCost(trace.usage.costUsd)}</span>}
              {bloat?.show && (
                <span
                  className={bloat.alert ? 'text-status-error' : 'text-status-warning'}
                  title={`Prompt piped to provider: ${bloat.bytes.toLocaleString()} bytes. Every cache-read of this prefix is billed.`}
                >
                  prompt {bloat.label}
                </span>
              )}
              {trace.usage.provider && <span className="text-text-tertiary">{trace.usage.provider}</span>}
            </div>
          </Section>

          {/* Context / audit */}
          {(trace.context.skills.length > 0 || trace.context.releaseStopReason || trace.context.followupIssueUrl || gemma || trace.logPruned) && (
            <Section label="context">
              <div className="flex flex-col gap-2">
                {gemma && (
                  <Pill tone={gemma.tone} size="xs" className="h-5 w-fit rounded px-1.5 font-mono text-[10px]" title="Local-LLM outcome verdict">
                    {gemma.label}
                  </Pill>
                )}
                {trace.context.skills.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {trace.context.skills.map((s) => (
                      <Pill key={s} tone="neutral" size="xs" className="rounded px-1.5 font-mono text-[10px]">{s}</Pill>
                    ))}
                  </div>
                )}
                {trace.context.releaseStopReason && (
                  <div className="text-xs text-status-warning">
                    <span className="font-mono uppercase tracking-wider text-text-tertiary">stop reason </span>
                    {trace.context.releaseStopReason}
                  </div>
                )}
                {trace.context.followupIssueUrl && (
                  <a
                    href={trace.context.followupIssueUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="w-fit font-mono text-xs text-status-warning hover:underline"
                  >
                    ↗ follow-up issue{trace.context.followupIssueNumber != null ? ` #${trace.context.followupIssueNumber}` : ''}
                  </a>
                )}
                {trace.logPruned && <div className="font-mono text-[11px] text-text-tertiary">log file was deleted by retention policy</div>}
              </div>
            </Section>
          )}

          {/* Footer link */}
          <div className="border-t border-border px-4 py-3">
            <Link
              href={`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(trace.job_id)}`}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              Open full terminal ↗
            </Link>
          </div>
        </div>
      )}
    </Drawer>
  )
}

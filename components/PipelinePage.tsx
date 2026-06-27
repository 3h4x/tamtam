'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import type { PipelineResponse, VerdictDistribution, DurationStats } from '@/app/api/stats/pipeline/route'
import { Button, buttonVariants } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Table } from '@/components/ui/Table'
import { ErrorState } from './ErrorState'

type Window = '24h' | '7d' | '30d' | 'all'

const EMPTY_SEARCH_PARAMS = new URLSearchParams()

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const s = ms / 1000
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

function fmtPct(rate: number | null | undefined): string {
  if (rate == null) return '—'
  return `${Math.round(rate * 100)}%`
}

function fmtIterationCap(cap: number | null): string {
  return cap == null ? '∞' : String(cap)
}

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string
  value: string
  sub?: string
  color?: 'green' | 'yellow' | 'red' | 'blue'
}) {
  const valueColor =
    color === 'green'
      ? 'text-status-success'
      : color === 'yellow'
        ? 'text-status-warning'
        : color === 'red'
          ? 'text-status-error'
          : color === 'blue'
            ? 'text-accent'
            : 'text-text-primary'
  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-4">
      <div className="text-xs text-text-tertiary uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-semibold mt-1 tabular-nums ${valueColor}`}>{value}</div>
      {sub && <div className="text-xs text-text-tertiary mt-1">{sub}</div>}
    </div>
  )
}

function VerdictBar({ verdicts }: { verdicts: VerdictDistribution }) {
  const { lgtm, needsAttention, doNotShip, parseFailed, prunedMissingVerdict, total } = verdicts
  if (total === 0) {
    return (
      <EmptyState
        title={<span className="font-normal text-text-tertiary">No review data in this period.</span>}
        align="start"
        paddingX="none"
        paddingY="none"
        className="py-2"
      />
    )
  }
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0)
  const segments = [
    { label: 'LGTM', count: lgtm, color: 'bg-status-success', textColor: 'text-status-success' },
    { label: 'NEEDS ATTENTION', count: needsAttention, color: 'bg-status-warning', textColor: 'text-status-warning' },
    { label: 'DO NOT SHIP', count: doNotShip, color: 'bg-status-error', textColor: 'text-status-error' },
    { label: 'Parse failed', count: parseFailed, color: 'bg-text-tertiary', textColor: 'text-text-tertiary' },
    { label: 'Log pruned', count: prunedMissingVerdict ?? 0, color: 'bg-border', textColor: 'text-text-tertiary' },
  ].filter((s) => s.count > 0)

  return (
    <div className="space-y-3">
      {/* Stacked bar */}
      <div className="flex h-6 rounded overflow-hidden gap-px">
        {segments.map((s) => (
          <div
            key={s.label}
            className={`${s.color} transition-all duration-500`}
            style={{ width: `${pct(s.count)}%` }}
            title={`${s.label}: ${s.count} (${pct(s.count)}%)`}
          />
        ))}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5 text-xs">
            <span className={`w-2 h-2 rounded-sm inline-block ${s.color}`} />
            <span className="text-text-secondary">{s.label}</span>
            <span className={`font-medium tabular-nums ${s.textColor}`}>
              {s.count} ({pct(s.count)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

const STEP_KINDS = ['release', 'test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'mark-dod'] as const

export function PipelinePage() {
  const searchParams = useSearchParams() ?? EMPTY_SEARCH_PARAMS
  const projectFilter = searchParams.get('project')

  const [data, setData] = useState<PipelineResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [window_, setWindow] = useState<Window>('24h')
  const [showConfig, setShowConfig] = useState(false)

  const load = useCallback(
    async (w: Window) => {
      try {
        const url = `/api/stats/pipeline?window=${w}${projectFilter ? `&project=${encodeURIComponent(projectFilter)}` : ''}`
        const res = await fetch(url)
        if (!res.ok) throw new Error('fetch failed')
        setData(await res.json())
        setError(null)
      } catch {
        setError('Failed to load pipeline metrics')
      } finally {
        setLoading(false)
      }
    },
    [projectFilter],
  )

  useEffect(() => {
    setLoading(true)
    load(window_)
    const id = setInterval(() => load(window_), 60_000)
    return () => clearInterval(id)
  }, [load, window_])

  if (loading && !data) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="skeleton h-11 w-full rounded-lg" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-20 rounded-lg" />
          ))}
        </div>
        <div className="skeleton h-40 rounded-lg" />
        <div className="skeleton h-48 rounded-lg" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="max-w-6xl mx-auto">
        <ErrorState
          message={error ?? 'No pipeline data available.'}
          hint="Pipeline metrics are collected from release runs across all projects."
          onRetry={() => { setLoading(true); load(window_) }}
        />
      </div>
    )
  }

  const { verdicts, fixLoop, pipelineSuccess, stepDurations, mttr, projects, configSnapshot } = data

  const successColor =
    pipelineSuccess.total === 0
      ? undefined
      : pipelineSuccess.rate >= 0.9
        ? 'green'
        : pipelineSuccess.rate >= 0.6
          ? 'yellow'
          : 'red'

  const lgtmRate = verdicts.total > 0 ? verdicts.lgtm / verdicts.total : null
  const lgtmColor =
    lgtmRate == null ? undefined : lgtmRate >= 0.8 ? 'green' : lgtmRate >= 0.5 ? 'yellow' : 'red'

  const convRate = fixLoop.total > 0 ? fixLoop.converged / fixLoop.total : null
  const convColor =
    convRate == null ? undefined : convRate >= 0.8 ? 'green' : convRate >= 0.5 ? 'yellow' : 'red'

  // True parser failures: log was available but verdict text couldn't be extracted.
  // Excludes prunedMissingVerdict (log gone before verdict was persisted — a one-time
  // historical gap that shrinks as old jobs age out of the window).
  const parseable = verdicts.total - (verdicts.prunedMissingVerdict ?? 0)
  const parseFailRate = parseable > 0 ? verdicts.parseFailed / parseable : null
  // Inverted scale: low parse-fail = good. Target is < 10%.
  const parseFailColor =
    parseFailRate == null ? undefined : parseFailRate <= 0.1 ? 'green' : parseFailRate <= 0.25 ? 'yellow' : 'red'

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">
            Pipeline Metrics
            {projectFilter && (
              <span className="ml-2 text-sm font-normal text-text-tertiary">
                — {projectFilter}{' '}
                <Link href="/stats?tab=pipeline" className={buttonVariants({ variant: 'link', size: 'sm', className: 'ml-1' })}>
                  show all
                </Link>
              </span>
            )}
          </h1>
          <p className="text-xs text-text-tertiary mt-0.5">
            Release pipeline health: verdict rates, fix-loop convergence, and step latencies
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <SegmentedControl<Window>
            ariaLabel="Time window"
            options={[
              { value: '24h', label: '24h' },
              { value: '7d', label: '7d' },
              { value: '30d', label: '30d' },
              { value: 'all', label: 'all' },
            ]}
            value={window_}
            onChange={(w) => {
              setWindow(w)
              setLoading(true)
            }}
          />
          <span className="text-xs text-text-tertiary">
            {loading ? 'Refreshing…' : `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`}
          </span>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard
          label="Pipeline success"
          value={pipelineSuccess.total > 0 ? fmtPct(pipelineSuccess.rate) : '—'}
          sub={pipelineSuccess.total > 0 ? `${pipelineSuccess.succeeded}/${pipelineSuccess.total} releases` : 'No releases'}
          color={successColor as 'green' | 'yellow' | 'red' | undefined}
        />
        <StatCard
          label="Review LGTM rate"
          value={verdicts.total > 0 ? fmtPct(lgtmRate) : '—'}
          sub={verdicts.total > 0 ? `${verdicts.lgtm}/${verdicts.total} reviews` : 'No reviews'}
          color={lgtmColor as 'green' | 'yellow' | 'red' | undefined}
        />
        <StatCard
          label="Verdict parse fail"
          value={parseable > 0 ? fmtPct(parseFailRate) : '—'}
          sub={
            parseable > 0
              ? `${verdicts.parseFailed}/${parseable} unparseable${(verdicts.prunedMissingVerdict ?? 0) > 0 ? ` · ${verdicts.prunedMissingVerdict} pruned` : ''}`
              : 'No reviews'
          }
          color={parseFailColor as 'green' | 'yellow' | 'red' | undefined}
        />
        <StatCard
          label="Fix convergence"
          value={fixLoop.total > 0 ? fmtPct(convRate) : '—'}
          sub={fixLoop.total > 0 ? `${fixLoop.converged}/${fixLoop.total} converged · ${fixLoop.hitCap} exhausted recovery budget` : 'No recovery loops'}
          color={convColor as 'green' | 'yellow' | 'red' | undefined}
        />
        <StatCard
          label="Avg successful release time"
          value={fmtDuration(mttr?.avg ?? null)}
          sub={mttr ? `median ${fmtDuration(mttr.median)} · p95 ${fmtDuration(mttr.p95)} · ${mttr.count} successful releases` : 'No completed releases'}
          color="blue"
        />
      </div>

      {/* Verdict distribution */}
      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-bg-tertiary">
          <h2 className="text-sm font-medium text-text-primary">Review verdict distribution</h2>
          <p className="text-xs text-text-tertiary mt-0.5">
            Breakdown of all completed reviews · tune{' '}
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => setShowConfig((v) => !v)}
            >
              verdict rules
            </Button>{' '}
            in Settings → Pipeline
          </p>
        </div>
        <div className="px-4 py-4">
          <VerdictBar verdicts={verdicts} />
        </div>
      </div>

      {/* Step durations */}
      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-bg-tertiary">
          <h2 className="text-sm font-medium text-text-primary">Step durations</h2>
          <p className="text-xs text-text-tertiary mt-0.5">Avg, median, and p95 wall-clock time per pipeline step</p>
        </div>
        <Table<{ kind: string; stats: DurationStats | undefined }>
          className="rounded-none border-0"
          columns={[
            {
              key: 'step',
              label: 'Step',
              render: (r) => <span className="font-mono text-text-primary">{r.kind}</span>,
            },
            {
              key: 'runs',
              label: 'Runs',
              headerClass: 'text-right',
              cellClass: 'text-right tabular-nums text-text-secondary',
              render: (r) => (r.stats ? r.stats.count.toLocaleString() : ''),
            },
            {
              key: 'avg',
              label: 'Avg',
              headerClass: 'text-right',
              cellClass: 'text-right tabular-nums font-medium text-text-primary',
              render: (r) => (r.stats ? fmtDuration(r.stats.avg) : ''),
            },
            {
              key: 'median',
              label: 'Median',
              headerClass: 'text-right',
              cellClass: 'text-right tabular-nums font-medium text-text-primary',
              render: (r) => (r.stats ? fmtDuration(r.stats.median) : ''),
            },
            {
              key: 'p95',
              label: 'p95',
              headerClass: 'text-right',
              cellClass: 'text-right tabular-nums text-text-secondary',
              render: (r) => (r.stats ? fmtDuration(r.stats.p95) : <span className="text-text-tertiary">no data</span>),
            },
          ]}
          rows={STEP_KINDS.map((kind) => ({ kind, stats: stepDurations[kind] }))}
          getRowKey={(r) => r.kind}
        />
      </div>

      {/* Fix loop detail */}
      {fixLoop.total > 0 && (
        <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-bg-tertiary">
            <h2 className="text-sm font-medium text-text-primary">Fix loop detail</h2>
            <p className="text-xs text-text-tertiary mt-0.5">
              Review/test cap: {fmtIterationCap(configSnapshot.maxStepIterations)} iterations per step
              {' · '}
              push fix cap: {configSnapshot.maxPushFixAttempts} attempts
            </p>
          </div>
          <div className="px-4 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-xs text-text-tertiary uppercase tracking-wide">Releases with recovery loops</div>
              <div className="text-xl font-semibold text-text-primary mt-1 tabular-nums">{fixLoop.total}</div>
            </div>
            <div>
              <div className="text-xs text-text-tertiary uppercase tracking-wide">Converged</div>
              <div className="text-xl font-semibold text-status-success mt-1 tabular-nums">{fixLoop.converged}</div>
            </div>
            <div>
              <div className="text-xs text-text-tertiary uppercase tracking-wide">Exhausted recovery budget</div>
              <div className={`text-xl font-semibold mt-1 tabular-nums ${fixLoop.hitCap > 0 ? 'text-status-error' : 'text-text-primary'}`}>
                {fixLoop.hitCap}
              </div>
            </div>
            <div>
              <div className="text-xs text-text-tertiary uppercase tracking-wide">Avg recovery iters</div>
              <div className="text-xl font-semibold text-text-primary mt-1 tabular-nums">{fixLoop.avgIterations}</div>
            </div>
          </div>
        </div>
      )}

      {/* Per-project table (global view only) */}
      {projects.length > 0 && (
        <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-bg-tertiary">
            <h2 className="text-sm font-medium text-text-primary">Per-project breakdown</h2>
          </div>
          <Table<PipelineResponse['projects'][number]>
            className="rounded-none border-0"
            columns={[
              {
                key: 'project',
                label: 'Project',
                render: (r) => (
                  <Link
                    href={`/pipeline?project=${encodeURIComponent(r.project)}`}
                    className={buttonVariants({ variant: 'link', className: 'font-medium text-text-primary no-underline hover:text-accent hover:no-underline' })}
                    data-private
                  >
                    {r.project}
                  </Link>
                ),
              },
              {
                key: 'releases',
                label: 'Releases',
                headerClass: 'text-right',
                cellClass: 'text-right tabular-nums text-text-secondary',
                render: (r) => r.releases,
              },
              {
                key: 'success',
                label: 'Success',
                headerClass: 'text-right',
                render: (r) => (
                  <div className="flex items-center justify-end gap-1.5">
                    {r.releases > 0 && (
                      <div className="w-16 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${r.successRate >= 0.9 ? 'bg-status-success' : r.successRate >= 0.6 ? 'bg-status-warning' : 'bg-status-error'}`}
                          style={{ width: `${Math.round(r.successRate * 100)}%` }}
                        />
                      </div>
                    )}
                    <span className={`tabular-nums font-medium ${r.successRate >= 0.9 ? 'text-status-success' : r.successRate >= 0.6 ? 'text-status-warning' : 'text-status-error'}`}>
                      {fmtPct(r.successRate)}
                    </span>
                  </div>
                ),
              },
              {
                key: 'lgtm-rate',
                label: 'LGTM rate',
                headerClass: 'text-right',
                render: (r) => (
                  <div className="flex items-center justify-end gap-1.5">
                    {r.reviewCount > 0 && (
                      <div className="w-16 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${r.lgtmRate >= 0.8 ? 'bg-status-success' : r.lgtmRate >= 0.5 ? 'bg-status-warning' : 'bg-status-error'}`}
                          style={{ width: `${Math.round(r.lgtmRate * 100)}%` }}
                        />
                      </div>
                    )}
                    <span className={`tabular-nums ${r.reviewCount === 0 ? 'text-text-tertiary' : r.lgtmRate >= 0.8 ? 'text-status-success' : r.lgtmRate >= 0.5 ? 'text-status-warning' : 'text-status-error'}`}>
                      {r.reviewCount > 0 ? fmtPct(r.lgtmRate) : '—'}
                    </span>
                  </div>
                ),
              },
              {
                key: 'avg-recovery-iters',
                label: 'Avg recovery iters',
                headerClass: 'text-right',
                cellClass: 'text-right tabular-nums text-text-secondary',
                render: (r) => (r.fixIterationsAvg > 0 ? r.fixIterationsAvg : '—'),
              },
              {
                key: 'median-release',
                label: 'Median release',
                headerClass: 'text-right',
                cellClass: 'text-right tabular-nums text-text-secondary',
                render: (r) => fmtDuration(r.medianReleaseDurationMs),
              },
            ]}
            rows={projects}
            getRowKey={(r) => r.project}
            rowClassName={() => 'hover:bg-bg-tertiary/40'}
          />
        </div>
      )}

      {/* Config snapshot */}
      <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
        <Button
          type="button"
          variant="secondary"
          className="w-full justify-between rounded-none border-x-0 border-t-0 bg-bg-tertiary px-4 py-3 text-left hover:bg-bg-tertiary"
          onClick={() => setShowConfig((v) => !v)}
        >
          <div>
            <h2 className="text-sm font-medium text-text-primary">Active configuration</h2>
            <p className="text-xs text-text-tertiary mt-0.5">
              Verdict rules and commit style applied during this period — edit in{' '}
              <Link
                href="/settings/pipeline"
                className={buttonVariants({ variant: 'link', size: 'sm' })}
                onClick={(e) => e.stopPropagation()}
              >
                Settings → Pipeline
              </Link>
            </p>
          </div>
          <span className="text-text-tertiary text-xs ml-4">{showConfig ? '▲ hide' : '▼ show'}</span>
        </Button>
        {showConfig && (
          <div className="px-4 py-4 space-y-4">
            <div>
              <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-1">
                Verdict rules · review/test cap: {fmtIterationCap(configSnapshot.maxStepIterations)} iterations per step
              </div>
              <div className="text-xs text-text-secondary mb-2">
                push fix cap: {configSnapshot.maxPushFixAttempts} attempts · standalone fallback window: {Math.round(configSnapshot.stepWindowSeconds / 60)} min
              </div>
              <pre className="text-xs text-text-secondary bg-bg-tertiary rounded p-3 whitespace-pre-wrap break-words">
                {configSnapshot.verdictRules || '(using defaults)'}
              </pre>
            </div>
            <div>
              <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-1">Commit style</div>
              <pre className="text-xs text-text-secondary bg-bg-tertiary rounded p-3 whitespace-pre-wrap break-words">
                {configSnapshot.commitStyle || '(using defaults)'}
              </pre>
            </div>
          </div>
        )}
      </div>

      {pipelineSuccess.total === 0 && verdicts.total === 0 && (
        <EmptyState
          paddingX="none"
          paddingY="none"
          title={
            <span className="text-xs font-normal text-text-tertiary">
              No pipeline data in the last window. Trigger a{' '}
              <span className="font-medium">Release</span> from any project to start collecting metrics.
            </span>
          }
        />
      )}
    </div>
  )
}

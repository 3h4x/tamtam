'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Pill } from '@/components/ui/Pill'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { fetchProjectPipelineStats } from '@/lib/client-api'
import type { PipelineDurationStats, ProjectPipelineStats } from '@/lib/client-api'

type Window = '7d' | '30d' | 'all'

const WINDOWS: Window[] = ['7d', '30d', 'all']

const STEP_ORDER = ['agent', 'test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'mark-dod'] as const

const STEP_META: Record<(typeof STEP_ORDER)[number], { label: string; detail: string }> = {
  agent: { label: 'agent / trigger', detail: 'the run that kicked off each release — usually the longest + costliest step' },
  test: { label: 'tests', detail: 'verification before review' },
  review: { label: 'review', detail: 'provider verdict pass' },
  fix: { label: 'fix', detail: 'apply review, test, commit, or push hook fixes' },
  commit: { label: 'commit', detail: 'prepare release commit' },
  push: { label: 'push', detail: 'push direct to origin' },
  'pr-wait': { label: 'merge', detail: 'wait for PR gates and merge' },
  'mark-dod': { label: 'dod', detail: 'definition-of-done bookkeeping' },
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`
  return `${minutes}m`
}

function formatPercent(value: number | null | undefined): string {
  if (value == null) return '—'
  return `${Math.round(value * 100)}%`
}

function formatCost(value: number | null | undefined): string {
  if (value == null || value <= 0) return '—'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

function MetricCard({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string
  value: string
  detail: string
  tone?: 'default' | 'good' | 'warn' | 'info'
}) {
  const valueClass =
    tone === 'good'
      ? 'text-status-success'
      : tone === 'warn'
        ? 'text-status-warning'
        : tone === 'info'
          ? 'text-accent'
          : 'text-text-primary'

  return (
    <div className="rounded-md border border-border bg-bg-primary px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      <div className="mt-1 text-xs text-text-secondary">{detail}</div>
    </div>
  )
}

function StepCard({ step, stats }: { step: (typeof STEP_ORDER)[number]; stats?: PipelineDurationStats }) {
  const meta = STEP_META[step]

  return (
    <div className="rounded-md border border-border bg-bg-primary px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">{meta.label}</div>
          <div className="mt-0.5 text-xs text-text-tertiary">{meta.detail}</div>
        </div>
        <Pill
          tone="neutral"
          size="xs"
          className="shrink-0 rounded-full bg-bg-secondary text-[11px] font-normal tabular-nums"
        >
          {stats?.count ?? 0} run{stats?.count === 1 ? '' : 's'}
        </Pill>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary">avg</div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-text-primary">{formatDuration(stats?.avg)}</div>
        </div>
        <div className="text-right text-xs text-text-secondary tabular-nums">
          <div>median {formatDuration(stats?.median)}</div>
          <div>p95 {formatDuration(stats?.p95)}</div>
          <div>avg cost {formatCost(stats?.avgCostUsd)}</div>
        </div>
      </div>
    </div>
  )
}

function PipelineStatsSkeleton() {
  return (
    <section className="mb-4 rounded-lg border border-border bg-bg-secondary">
      <div className="border-b border-border px-3 py-2.5">
        <div className="skeleton h-4 w-40 rounded" />
        <div className="mt-2 skeleton h-3 w-64 rounded" />
      </div>
      <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="skeleton h-24 rounded-md" />
        ))}
      </div>
      <div className="grid gap-3 px-3 pb-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="skeleton h-28 rounded-md" />
        ))}
      </div>
    </section>
  )
}

// Compact single-line KPI for the demoted Overview summary. Small value type,
// no detail line — the full breakdown lives at /stats?tab=pipeline.
function CompactKpi({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'good' | 'warn' | 'info'
}) {
  const valueClass =
    tone === 'good'
      ? 'text-status-success'
      : tone === 'warn'
        ? 'text-status-warning'
        : tone === 'info'
          ? 'text-accent'
          : 'text-text-primary'
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  )
}

function PipelineStatsCompactSkeleton() {
  return (
    <section className="mb-4 rounded-lg border border-border bg-bg-secondary">
      <div className="border-b border-border px-3 py-2">
        <div className="skeleton h-4 w-40 rounded" />
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 px-3 py-2.5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="space-y-1">
            <div className="skeleton h-3 w-16 rounded" />
            <div className="skeleton h-5 w-12 rounded" />
          </div>
        ))}
      </div>
    </section>
  )
}

// `compact` renders a demoted, single-strip summary (5 KPIs + a deep-link to the
// full pipeline stats page) instead of the full metric/step-card grid. The
// Overview tab uses it so current-state surfaces own the fold; the standalone
// /stats?tab=pipeline page renders the full panel.
export function PipelineStatsPanel({ projectName, compact = false }: { projectName: string; compact?: boolean }) {
  const [window_, setWindow] = useState<Window>('30d')
  const [data, setData] = useState<ProjectPipelineStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    const load = async () => {
      try {
        const next = await fetchProjectPipelineStats(projectName, window_)
        if (!active) return
        setData(next)
        setError(null)
      } catch {
        if (!active) return
        setError('Failed to load pipeline stats')
      } finally {
        if (active) setLoading(false)
      }
    }

    setLoading(true)
    load()
    const intervalId = setInterval(load, 60_000)

    return () => {
      active = false
      clearInterval(intervalId)
    }
  }, [projectName, window_])

  if (loading && !data) return compact ? <PipelineStatsCompactSkeleton /> : <PipelineStatsSkeleton />

  const refreshError = error && data ? `${error}. Showing last successful snapshot.` : null

  const successRate = data?.pipelineSuccess.total ? data.pipelineSuccess.rate : null
  const successTone =
    successRate == null ? 'default' : successRate >= 0.9 ? 'good' : successRate >= 0.6 ? 'warn' : 'default'
  const releasesLabel =
    data?.pipelineSuccess.total && data.pipelineSuccess.total > 0
      ? `${data.pipelineSuccess.succeeded}/${data.pipelineSuccess.total} finished successfully`
      : 'No completed releases in this window'
  const fixLoopLabel =
    data?.fixLoop.total && data.fixLoop.total > 0
      ? `${data.fixLoop.converged} converged · ${data.fixLoop.hitCap} exhausted`
      : 'No recovery loops observed'

  if (compact) {
    return (
      <section className="mb-4 rounded-lg border border-border bg-bg-secondary">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="text-sm font-medium text-text-primary">
            Pipeline performance
            <span className="ml-1.5 text-xs font-normal text-text-tertiary">30-day averages</span>
          </div>
          <Link href="/stats?tab=pipeline" className="text-xs text-accent hover:underline">
            View details →
          </Link>
        </header>
        {error && !data ? (
          <ErrorCallout radius="md" padding="md" className="m-3 text-sm">{error}</ErrorCallout>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2.5">
            <CompactKpi label="avg release" value={formatDuration(data?.mttr?.avg)} tone="info" />
            <CompactKpi label="cost / release" value={formatCost(data?.mttr?.avgCostUsd)} tone="info" />
            <CompactKpi label="success" value={formatPercent(successRate)} tone={successTone} />
            <CompactKpi label="avg tests" value={formatDuration(data?.stepDurations.test?.avg)} />
            <CompactKpi label="fix loops" value={data?.fixLoop.total ? `${data.fixLoop.avgIterations.toFixed(1)}x` : '—'} />
          </div>
        )}
      </section>
    )
  }

  return (
    <section className="mb-4 rounded-lg border border-border bg-bg-secondary">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">Pipeline performance</div>
          <div className="mt-0.5 text-xs text-text-secondary">
            Average time per release step for <span className="font-mono text-sm font-semibold text-accent">{projectName}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<Window>
            ariaLabel="Pipeline stats time window"
            options={WINDOWS.map((option) => ({ value: option, label: option }))}
            value={window_}
            onChange={setWindow}
          />
          <div className="text-xs text-text-tertiary tabular-nums">
            {loading ? 'Refreshing…' : data ? `Updated ${new Date(data.generatedAt).toLocaleTimeString()}` : '—'}
          </div>
        </div>
      </header>

      {error && !data ? (
        <ErrorCallout radius="md" padding="md" className="m-3 text-sm">{error}</ErrorCallout>
      ) : (
        <>
          {refreshError && (
            <ErrorCallout
              role="alert"
              tone="warning"
              className="rounded-none border-x-0 border-t-0 px-3 py-2 text-sm"
              preWrap={false}
            >
              {refreshError}
            </ErrorCallout>
          )}
          <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-5">
            <MetricCard
              label="avg successful release"
              value={formatDuration(data?.mttr?.avg)}
              detail={data?.mttr ? `median ${formatDuration(data.mttr.median)} · p95 ${formatDuration(data.mttr.p95)} · ${data.mttr.count} successful releases` : 'No successful releases yet'}
              tone="info"
            />
            <MetricCard
              label="avg cost per release"
              value={formatCost(data?.mttr?.avgCostUsd)}
              detail={
                data?.mttr?.avgCostUsd != null && data?.mttr
                  ? `successful releases only · ${data.mttr.count} successful release${data.mttr.count === 1 ? '' : 's'}`
                  : 'No successful release cost recorded in this window'
              }
              tone="info"
            />
            <MetricCard
              label="release success"
              value={formatPercent(successRate)}
              detail={releasesLabel}
              tone={successTone}
            />
            <MetricCard
              label="avg tests"
              value={formatDuration(data?.stepDurations.test?.avg)}
              detail={data?.stepDurations.test ? `${data.stepDurations.test.count} test runs in window` : 'No test runs in this window'}
            />
            <MetricCard
              label="fix loops"
              value={data?.fixLoop.total ? `${data.fixLoop.avgIterations.toFixed(1)}x` : '—'}
              detail={fixLoopLabel}
            />
          </div>

          <div className="grid gap-3 px-3 pb-3 md:grid-cols-2 xl:grid-cols-3">
            {STEP_ORDER.map((step) => (
              <StepCard key={step} step={step} stats={data?.stepDurations[step]} />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

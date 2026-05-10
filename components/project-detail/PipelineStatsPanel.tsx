'use client'

import { useEffect, useState } from 'react'
import { fetchProjectPipelineStats } from '@/lib/client-api'
import type { PipelineDurationStats, ProjectPipelineStats } from '@/lib/client-api'

type Window = '7d' | '30d' | 'all'

const WINDOWS: Window[] = ['7d', '30d', 'all']

const STEP_ORDER = ['agent', 'test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'fix-push', 'mark-dod'] as const

const STEP_META: Record<(typeof STEP_ORDER)[number], { label: string; detail: string }> = {
  agent: { label: 'agent / trigger', detail: 'the run that kicked off each release — usually the longest + costliest step' },
  test: { label: 'tests', detail: 'verification before review' },
  review: { label: 'review', detail: 'provider verdict pass' },
  fix: { label: 'fix', detail: 'apply review or test fixes' },
  commit: { label: 'commit', detail: 'prepare release commit' },
  push: { label: 'push', detail: 'push direct to origin' },
  'pr-wait': { label: 'merge', detail: 'wait for PR gates and merge' },
  'fix-push': { label: 'fix push', detail: 'push after a fix loop' },
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
        <div className="shrink-0 rounded-full border border-border bg-bg-secondary px-2 py-0.5 text-[11px] tabular-nums text-text-secondary">
          {stats?.count ?? 0} run{stats?.count === 1 ? '' : 's'}
        </div>
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

export function PipelineStatsPanel({ projectName }: { projectName: string }) {
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

  if (loading && !data) return <PipelineStatsSkeleton />

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
          <div className="flex items-center gap-0.5 overflow-hidden rounded-md border border-border">
            {WINDOWS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setWindow(option)}
                className={`px-2.5 py-1 text-xs font-medium tabular-nums transition-colors ${
                  window_ === option
                    ? 'bg-accent text-white'
                    : 'bg-bg-primary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
          <div className="text-xs text-text-tertiary tabular-nums">
            {loading ? 'Refreshing…' : data ? `Updated ${new Date(data.generatedAt).toLocaleTimeString()}` : '—'}
          </div>
        </div>
      </header>

      {error && !data ? (
        <div className="px-3 py-3 text-sm text-status-error">{error}</div>
      ) : (
        <>
          {refreshError && (
            <div className="border-b border-status-warning/30 bg-status-warning/10 px-3 py-2 text-sm text-status-warning" role="alert">
              {refreshError}
            </div>
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

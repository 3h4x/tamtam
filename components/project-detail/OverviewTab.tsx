'use client'

import { useRouter } from 'next/navigation'
import {
  ACTIVE_WORK_BUCKET_ORDER,
  activeWorkAccentClass,
  activeWorkBadgeLabel,
  bucketOf,
  type KindBucket,
} from '@/components/project-runs/kinds'
import { activeWorkTitle } from '@/components/project-runs/entries'
import { PipelineStrip } from '@/components/project-detail/PipelineStrip'
import { StatusStrip } from '@/components/project-detail/StatusStrip'
import { AgentsStats } from '@/components/project-detail/AgentsStats'
import { PipelineStatsPanel } from '@/components/project-detail/PipelineStatsPanel'
import { Pill } from '@/components/ui/Pill'
import { PromptInsightsPanel } from '@/components/project-detail/PromptInsightsPanel'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { PulseDot } from '@/components/ui/PulseDot'
import { formatAgo } from '@/lib/shared/format'
import type { JobInfo, ProjectConfig } from '@/lib/client-api'

type Verdict = 'LGTM' | 'NEEDS ATTENTION' | 'DO NOT SHIP'

function runMeta(j: JobInfo): string[] {
  const meta = [`started ${formatAgo(j.started_at)}`]
  if (j.model) meta.push(j.model)
  else if (j.provider) meta.push(j.provider)
  return meta
}

export interface OverviewTabProps {
  projectName: string
  totalChanges: number
  unpushed: number
  hasUnreviewed: boolean
  verdict: Verdict | undefined
  isReviewRunning: boolean
  latestReview: JobInfo | undefined
  runningReview: JobInfo | undefined
  isTestRunning: boolean
  latestTest: JobInfo | undefined
  runningTest: JobInfo | undefined
  ciStatus: 'success' | 'failure' | 'in_progress' | null
  ciFailedUrl: string | null
  releaseTag: string | null
  aggregateCi: string | null
  config: ProjectConfig | null
  projectJobs: JobInfo[]
  runningJobs: JobInfo[]
  // Lookup: running-release-id → originating agent job. When present, the
  // active-work card for a running release renders with the agent's title
  // and meta instead of the generic "Release pipeline" wrapper — keeping
  // the workflow visually unified.
  runningParentLookup?: Map<string, JobInfo>
  jobsLoaded: boolean
  jobsPaused: boolean
  onOpenChanges: () => void
  onRefresh: () => Promise<void>
}

export function OverviewTab({
  projectName,
  totalChanges,
  unpushed,
  hasUnreviewed,
  verdict,
  isReviewRunning,
  latestReview,
  runningReview,
  isTestRunning,
  latestTest,
  runningTest,
  ciStatus,
  ciFailedUrl,
  releaseTag,
  config,
  projectJobs,
  runningJobs,
  runningParentLookup,
  jobsLoaded,
  jobsPaused,
  onOpenChanges,
  onRefresh,
}: OverviewTabProps) {
  const router = useRouter()
  const activeCounts = runningJobs.reduce(
    (acc, job) => {
      acc[bucketOf(job.kind)] += 1
      return acc
    },
    {
      run: 0,
      release: 0,
      review: 0,
      test: 0,
      fix: 0,
      'fix-ci': 0,
      commit: 0,
      push: 0,
      'mark-dod': 0,
      'pr-wait': 0,
      soak: 0,
      agent: 0,
      other: 0,
    } satisfies Record<KindBucket, number>,
  )
  const visibleRunningJobs = runningJobs.slice(0, 4)

  // Most recent finished release — surfaced as a glanceable "last shipped" line
  // (tag + recency + outcome), which the header tag and StatusStrip don't show.
  const lastRelease = projectJobs
    .filter((j) => j.kind === 'release' && (j.status === 'done' || j.status === 'aborted'))
    .reduce<JobInfo | undefined>(
      (latest, j) => (!latest || (j.finished_at || 0) > (latest.finished_at || 0) ? j : latest),
      undefined,
    )
  const lastReleaseOk = lastRelease?.status === 'done'

  return (
    <>
      {runningJobs.length > 0 && (
        <section className="mb-4 rounded-lg border border-border bg-bg-secondary">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 text-sm font-medium text-text-primary">
                <PulseDot size="sm" />
                active work
              </div>
              <div className="mt-0.5 text-xs text-text-secondary tabular-nums">
                {runningJobs.length} running now
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-secondary tabular-nums">
              {ACTIVE_WORK_BUCKET_ORDER.map((bucket) => {
                const count = activeCounts[bucket]
                if (count === 0) return null
                return (
                  <Pill key={bucket} size="xs" className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] tabular-nums">
                    {activeWorkBadgeLabel(bucket)} {count}
                  </Pill>
                )
              })}
            </div>
          </div>
          <div className="grid gap-2 p-3 md:grid-cols-2">
            {visibleRunningJobs.map((j) => {
              // If the running job is a release with a known originating
              // agent in the project's job list, render the card around the
              // agent (title, meta, badge) so the workflow reads as one
              // unit. Click target stays on the release — that's where
              // active work is happening and where progress is visible.
              const anchor = runningParentLookup?.get(j.id) ?? null
              const display = anchor ?? j
              const displayKind = anchor ? anchor.kind : j.kind
              return (
                <Button
                  key={j.id}
                  type="button"
                  onClick={() => router.push(`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(j.id)}`)}
                  surface="primary"
                  className={`min-w-0 !justify-start !gap-0 border-l-2 ${activeWorkAccentClass(displayKind)} !bg-bg-primary !px-3 !py-2 text-left !font-normal hover:!bg-bg-tertiary`}
                  title={`Open ${j.kind} started ${formatAgo(j.started_at)}`}
                >
                  <div className="flex w-full min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Spinner
                          size="sm"
                          shrink
                          className="!h-3 !w-3 !border-[1.5px]"
                          aria-label="active job spinner"
                        />
                        <span className="truncate text-sm font-medium text-text-primary">{activeWorkTitle(display)}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
                        {runMeta(display).map((item) => (
                          <span key={item} className="font-mono tabular-nums">
                            {item}
                          </span>
                        ))}
                        {anchor && (
                          <span className="font-mono tabular-nums text-text-tertiary">
                            · release in progress
                          </span>
                        )}
                      </div>
                    </div>
                    <Pill size="xs" className="shrink-0 rounded-full bg-bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-tertiary">
                      {activeWorkBadgeLabel(displayKind)}
                    </Pill>
                  </div>
                </Button>
              )
            })}
          </div>
          {runningJobs.length > visibleRunningJobs.length && (
            <div className="border-t border-border px-3 py-2 text-xs text-text-secondary tabular-nums">
              +{runningJobs.length - visibleRunningJobs.length} more running job{runningJobs.length - visibleRunningJobs.length === 1 ? '' : 's'}
            </div>
          )}
        </section>
      )}

      <PipelineStrip
        projectName={projectName}
        projectJobs={projectJobs}
        config={config}
        totalChanges={totalChanges}
        unpushed={unpushed}
        hasUnreviewed={hasUnreviewed}
        verdict={verdict}
        jobsPaused={jobsPaused}
        onRefresh={onRefresh}
      />

      <StatusStrip
        projectName={projectName}
        totalChanges={totalChanges}
        unpushed={unpushed}
        hasUnreviewed={hasUnreviewed}
        verdict={verdict}
        isReviewRunning={isReviewRunning}
        latestReview={latestReview}
        runningReview={runningReview}
        isTestRunning={isTestRunning}
        latestTest={latestTest}
        runningTest={runningTest}
        testCronSchedule={config?.test_cron_enabled ? config.test_cron_schedule : null}
        ciStatus={ciStatus}
        ciFailedUrl={ciFailedUrl}
        releaseTag={releaseTag}
        isLoading={!jobsLoaded}
        onOpenChanges={onOpenChanges}
        onOpenJob={(jobId) => router.push(`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(jobId)}`)}
      />

      {lastRelease?.finished_at != null && (
        <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
          <span className="uppercase tracking-wider text-text-tertiary">Last release</span>
          {releaseTag && <span className="font-mono tabular-nums text-text-primary">{releaseTag}</span>}
          <span className="text-text-tertiary">· shipped {formatAgo(lastRelease.finished_at)} ·</span>
          <span className={lastReleaseOk ? 'text-status-success' : 'text-status-error'}>
            {lastReleaseOk ? 'succeeded' : 'aborted'}
          </span>
        </div>
      )}

      <AgentsStats projectName={projectName} />

      <PipelineStatsPanel projectName={projectName} compact />

      <PromptInsightsPanel projectName={projectName} />
    </>
  )
}

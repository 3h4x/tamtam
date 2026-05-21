'use client'

import { useRouter } from 'next/navigation'
import {
  ACTIVE_WORK_BUCKET_ORDER,
  activeWorkAccentClass,
  activeWorkBadgeLabel,
  activeWorkTitle,
  bucketOf,
  type KindBucket,
} from '@/components/project-runs/utils'
import { StatusStrip } from '@/components/project-detail/StatusStrip'
import { AgentsStats } from '@/components/project-detail/AgentsStats'
import { PipelineStatsPanel } from '@/components/project-detail/PipelineStatsPanel'
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
  isTestRunning: boolean
  latestTest: JobInfo | undefined
  ciStatus: 'success' | 'failure' | 'in_progress' | null
  ciFailedUrl: string | null
  releaseTag: string | null
  aggregateCi: string | null
  config: ProjectConfig | null
  runningJobs: JobInfo[]
  // Lookup: running-release-id → originating agent job. When present, the
  // active-work card for a running release renders with the agent's title
  // and meta instead of the generic "Release pipeline" wrapper — keeping
  // the workflow visually unified.
  runningParentLookup?: Map<string, JobInfo>
  jobsLoaded: boolean
  onOpenChanges: () => void
}

export function OverviewTab({
  projectName,
  totalChanges,
  unpushed,
  hasUnreviewed,
  verdict,
  isReviewRunning,
  latestReview,
  isTestRunning,
  latestTest,
  ciStatus,
  ciFailedUrl,
  releaseTag,
  config,
  runningJobs,
  runningParentLookup,
  jobsLoaded,
  onOpenChanges,
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

  return (
    <>
      {runningJobs.length > 0 && (
        <section className="mb-4 rounded-lg border border-border bg-bg-secondary">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 text-sm font-medium text-text-primary">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-info opacity-60" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-status-info" />
                </span>
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
                  <span key={bucket} className="rounded-full border border-border bg-bg-tertiary px-2 py-0.5">
                    {activeWorkBadgeLabel(bucket)} {count}
                  </span>
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
              <button
                key={j.id}
                type="button"
                onClick={() => router.push(`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(j.id)}`)}
                className={`min-w-0 rounded-md border border-border border-l-2 ${activeWorkAccentClass(displayKind)} bg-bg-primary px-3 py-2 text-left transition-colors hover:bg-bg-tertiary cursor-pointer`}
                title={`Open ${j.kind} started ${formatAgo(j.started_at)}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="spinner-sm shrink-0 !h-3 !w-3 !border-[1.5px]" aria-hidden />
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
                  <span className="shrink-0 rounded-full border border-border bg-bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-tertiary">
                    {activeWorkBadgeLabel(displayKind)}
                  </span>
                </div>
              </button>
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

      <StatusStrip
        projectName={projectName}
        totalChanges={totalChanges}
        unpushed={unpushed}
        hasUnreviewed={hasUnreviewed}
        verdict={verdict}
        isReviewRunning={isReviewRunning}
        latestReview={latestReview}
        isTestRunning={isTestRunning}
        latestTest={latestTest}
        testCronSchedule={config?.test_cron_enabled ? config.test_cron_schedule : null}
        ciStatus={ciStatus}
        ciFailedUrl={ciFailedUrl}
        releaseTag={releaseTag}
        isLoading={!jobsLoaded}
        onOpenChanges={onOpenChanges}
        onOpenJob={(jobId) => router.push(`/project/${encodeURIComponent(projectName)}/terminal?job=${encodeURIComponent(jobId)}`)}
      />

      <PipelineStatsPanel projectName={projectName} />

      <AgentsStats projectName={projectName} />
    </>
  )
}

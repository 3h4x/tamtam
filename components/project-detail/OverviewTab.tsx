'use client'

import { useRouter } from 'next/navigation'
import { AgentsTab } from '@/components/AgentsTab'
import { StatusStrip } from '@/components/project-detail/StatusStrip'
import { formatAgo } from '@/lib/shared/format'
import type { JobInfo, ProjectConfig } from '@/lib/client-api'

type Verdict = 'LGTM' | 'NEEDS ATTENTION' | 'DO NOT SHIP'

function runLabel(j: JobInfo): string {
  if (j.kind === 'run') return 'chat'
  if (j.kind.startsWith('agent:')) return j.kind.slice('agent:'.length)
  if (j.kind === 'fix-ci') return 'fix-ci'
  return j.kind
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
  currentBranch: string | null
  runningJobs: JobInfo[]
  projectJobs: JobInfo[]
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
  currentBranch,
  runningJobs,
  projectJobs,
  onOpenChanges,
}: OverviewTabProps) {
  const router = useRouter()

  return (
    <>
      {runningJobs.length > 0 && (
        <div className="mb-4 border border-status-warning/40 bg-status-warning/5 rounded-lg px-3 py-2 flex items-center gap-3 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-sm text-status-warning font-medium">
            <span className="inline-block w-2 h-2 rounded-full bg-status-warning animate-pulse" />
            {runningJobs.length} running
          </span>
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {runningJobs.slice(0, 5).map((j) => (
              <button
                key={j.id}
                onClick={() => router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(j.id)}`)}
                className="px-2 py-0.5 border border-border rounded-full bg-bg-secondary hover:bg-bg-tertiary cursor-pointer font-mono"
                title={`Open ${j.kind} started ${formatAgo(j.started_at)}`}
              >
                {runLabel(j)} · {formatAgo(j.started_at)}
              </button>
            ))}
            {runningJobs.length > 5 && (
              <span className="text-text-tertiary">+{runningJobs.length - 5} more</span>
            )}
          </div>
        </div>
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
        onOpenChanges={onOpenChanges}
        onOpenJob={(jobId) => router.push(`/project/${projectName}/terminal?job=${encodeURIComponent(jobId)}`)}
      />

      <AgentsTab
        projectName={projectName}
        currentBranch={currentBranch}
        prWorkflowEnabled={!!config?.pr_workflow_enabled}
        projectJobs={projectJobs}
      />
    </>
  )
}

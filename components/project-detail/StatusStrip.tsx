'use client'

import { formatAgo } from '@/lib/shared/format'
import type { JobInfo } from '@/lib/client-api'

type Verdict = 'LGTM' | 'NEEDS ATTENTION' | 'DO NOT SHIP'

export interface StatusStripProps {
  projectName: string
  totalChanges: number
  unpushed: number
  hasUnreviewed: boolean
  verdict: Verdict | undefined
  isReviewRunning: boolean
  latestReview: JobInfo | undefined
  isTestRunning: boolean
  latestTest: JobInfo | undefined
  testCronSchedule: string | null
  ciStatus: 'success' | 'failure' | 'in_progress' | null
  ciFailedUrl: string | null
  releaseTag: string | null
  onOpenChanges: () => void
  onOpenJob: (jobId: string) => void
}

interface StatusCardProps {
  label: string
  primary: React.ReactNode
  detail?: React.ReactNode
  tone: 'neutral' | 'success' | 'warning' | 'error' | 'info'
  onClick?: () => void
  disabled?: boolean
  running?: boolean
}

const TONE_RING: Record<StatusCardProps['tone'], string> = {
  neutral: 'border-border',
  success: 'border-status-success/40',
  warning: 'border-status-warning/40',
  error: 'border-status-error/40',
  info: 'border-status-info/40',
}

const TONE_DOT: Record<StatusCardProps['tone'], string> = {
  neutral: 'bg-text-tertiary',
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
  info: 'bg-status-info',
}

function StatusCard({ label, primary, detail, tone, onClick, disabled, running }: StatusCardProps) {
  const clickable = !!onClick && !disabled
  return (
    <button
      type="button"
      className={`min-w-0 text-left border rounded-lg px-3 py-2 flex items-center gap-2 transition-colors ${TONE_RING[tone]} ${
        clickable ? 'bg-bg-secondary hover:bg-bg-tertiary cursor-pointer' : 'bg-bg-secondary cursor-default'
      } ${disabled ? 'opacity-60' : ''}`}
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
    >
      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${TONE_DOT[tone]} ${running ? 'animate-pulse' : ''}`} />
      <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-semibold shrink-0">{label}</span>
      <span className="text-sm font-medium text-text-primary truncate">{primary}</span>
      {detail && <span className="text-xs text-text-tertiary truncate hidden sm:inline">{detail}</span>}
    </button>
  )
}

export function StatusStrip({
  projectName: _projectName,
  totalChanges,
  unpushed,
  hasUnreviewed,
  verdict,
  isReviewRunning,
  latestReview,
  isTestRunning,
  latestTest,
  testCronSchedule,
  ciStatus,
  ciFailedUrl,
  releaseTag,
  onOpenChanges,
  onOpenJob,
}: StatusStripProps) {
  // CHANGES card
  const changesCard = totalChanges > 0 ? (
    <StatusCard
      label="Changes"
      primary={`${totalChanges} file${totalChanges !== 1 ? 's' : ''}`}
      detail={hasUnreviewed ? 'unreviewed — open diff' : 'reviewed — open diff'}
      tone={hasUnreviewed ? 'warning' : 'success'}
      onClick={onOpenChanges}
    />
  ) : (
    <StatusCard label="Changes" primary="clean" detail="no uncommitted edits" tone="success" />
  )

  // REVIEW card
  let reviewCard: React.ReactNode
  if (isReviewRunning) {
    reviewCard = (
      <StatusCard
        label="Review"
        primary="In progress"
        detail={latestReview ? `started ${formatAgo(latestReview.started_at)} — follow output` : 'starting...'}
        tone="warning"
        running
        onClick={latestReview ? () => onOpenJob(latestReview.id) : undefined}
      />
    )
  } else if (hasUnreviewed) {
    reviewCard = (
      <StatusCard
        label="Review"
        primary="unreviewed"
        detail={verdict ? `last: ${verdict} — open diff` : 'not yet reviewed'}
        tone="warning"
        onClick={onOpenChanges}
      />
    )
  } else if (verdict && latestReview) {
    const pendingPush = verdict === 'LGTM' && totalChanges > 0
    const tone: StatusCardProps['tone'] =
      verdict === 'LGTM' ? 'success'
        : verdict === 'NEEDS ATTENTION' ? 'warning' : 'error'
    reviewCard = (
      <StatusCard
        label="Review"
        primary={verdict}
        detail={
          pendingPush
            ? `${formatAgo(latestReview.finished_at ?? latestReview.started_at)} — awaiting push`
            : `${formatAgo(latestReview.finished_at ?? latestReview.started_at)} — view log`
        }
        tone={tone}
        onClick={() => onOpenJob(latestReview.id)}
      />
    )
  } else {
    reviewCard = <StatusCard label="Review" primary="not run yet" tone="neutral" />
  }

  // TESTS card
  const cronSuffix = testCronSchedule ? ` · auto every ${testCronSchedule}` : ''
  let testsCard: React.ReactNode
  if (isTestRunning) {
    testsCard = (
      <StatusCard
        label="Tests"
        primary="Running"
        detail={(latestTest ? `started ${formatAgo(latestTest.started_at)} — follow output` : 'starting...') + cronSuffix}
        tone="warning"
        running
        onClick={latestTest ? () => onOpenJob(latestTest.id) : undefined}
      />
    )
  } else if (latestTest) {
    const passed = latestTest.exit_code === 0
    testsCard = (
      <StatusCard
        label="Tests"
        primary={passed ? 'Passed' : `Failed (exit ${latestTest.exit_code})`}
        detail={`${formatAgo(latestTest.finished_at ?? latestTest.started_at)} — view log${cronSuffix}`}
        tone={passed ? 'success' : 'error'}
        onClick={() => onOpenJob(latestTest.id)}
      />
    )
  } else {
    testsCard = (
      <StatusCard
        label="Tests"
        primary="not run yet"
        detail={testCronSchedule ? `scheduled every ${testCronSchedule}` : undefined}
        tone="neutral"
      />
    )
  }

  // CI card
  let ciCard: React.ReactNode
  if (ciStatus === 'success') {
    ciCard = (
      <StatusCard
        label="CI"
        primary="Passing"
        detail={releaseTag ? `release ${releaseTag}` : 'latest commit'}
        tone="success"
        onClick={ciFailedUrl ? () => window.open(ciFailedUrl, '_blank') : undefined}
      />
    )
  } else if (ciStatus === 'failure') {
    ciCard = (
      <StatusCard
        label="CI"
        primary="Failing"
        detail={ciFailedUrl ? 'open run on GitHub' : 'no run url'}
        tone="error"
        onClick={ciFailedUrl ? () => window.open(ciFailedUrl, '_blank') : undefined}
      />
    )
  } else if (ciStatus === 'in_progress') {
    ciCard = (
      <StatusCard
        label="CI"
        primary="In progress"
        detail={ciFailedUrl ? 'open run on GitHub' : undefined}
        tone="warning"
        running
        onClick={ciFailedUrl ? () => window.open(ciFailedUrl, '_blank') : undefined}
      />
    )
  } else {
    ciCard = <StatusCard label="CI" primary="no status" tone="neutral" />
  }

  // PUSH card
  const pushCard = unpushed > 0 ? (
    <StatusCard
      label="Push"
      primary={`${unpushed} commit${unpushed !== 1 ? 's' : ''} ahead`}
      detail="not yet pushed to origin"
      tone="warning"
      onClick={onOpenChanges}
    />
  ) : null

  return (
    <div className="flex flex-wrap gap-2 mb-4">
      {changesCard}
      {reviewCard}
      {testsCard}
      {ciCard}
      {pushCard}
    </div>
  )
}

'use client'

import { useState, useEffect, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { fixCi, releaseProject, fetchJobs, fetchProjectConfig, updateProjectConfig, fetchCustomActions, runCustomAction, saveCustomActions, pullProject, fetchBehind, PullDivergedError, testProject, fetchIssuesAndPRs, pushProject, fetchBranch, createProjectPR } from '@/lib/client-api'
import type { JobInfo, ProjectConfig, CustomAction } from '@/lib/client-api'
import { FleetHealth } from '@/hooks/useProjectHealth'
import { getAggregateCi } from '@/lib/statusConstants'
import { formatAgo } from '@/lib/format'
import { TerminalTab } from '@/components/TerminalTab'
import { AgentsTab } from '@/components/AgentsTab'
import { ProjectRunsTab } from '@/components/ProjectRunsTab'
import { ChangesTab } from '@/components/ChangesTab'
import { IssuesTab } from '@/components/IssuesTab'
import { DocsTab } from '@/components/DocsTab'
import { useToast } from '@/components/Toast'
import { isPipelineBusy } from '@/lib/pipeline-status'
import { getPipelineSteps, type StepToggleContext } from '@/lib/pipeline-steps'

type Tab = 'overview' | 'config' | 'history' | 'terminal' | 'changes' | 'issues' | 'docs'

type Verdict = 'LGTM' | 'NEEDS ATTENTION' | 'DO NOT SHIP'


function runLabel(j: JobInfo): string {
  if (j.kind === 'run') return 'chat'
  if (j.kind.startsWith('agent:')) return 'agent'
  if (j.kind === 'fix-ci') return 'fix-ci'
  return j.kind
}

interface StatusStripProps {
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

function StatusStrip({
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

interface ProjectDetailPageProps {
  fleet: FleetHealth
  onRefresh: () => Promise<void>
}

export function ProjectDetailPage({
  fleet,
  onRefresh,
}: ProjectDetailPageProps) {
  const params = useParams<{ name: string; tab?: string; sessionId?: string }>()
  const name = params.name
  const router = useRouter()
  const { toast } = useToast()
  const VALID_TABS: Tab[] = ['overview', 'config', 'history', 'terminal', 'changes', 'issues', 'docs']
  const activeTab: Tab = params.sessionId
    ? 'terminal'
    : VALID_TABS.includes(params.tab as Tab) ? (params.tab as Tab) : 'overview'
  const setActiveTab = (tab: Tab) => {
    router.push(tab === 'overview' ? `/project/${name}` : `/project/${name}/${tab}`)
  }
  const [fixingCi, setFixingCi] = useState(false)
  const [fixCiResult, setFixCiResult] = useState<string | null>(null)
  const [retryingPush, setRetryingPush] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [projectJobs, setProjectJobs] = useState<JobInfo[]>([])
  const [issueCount, setIssueCount] = useState<{ prs: number; issues: number } | null>(null)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null)
  const [branchCommitsAhead, setBranchCommitsAhead] = useState<number | null>(null)
  const [openPrBranches, setOpenPrBranches] = useState<string[]>([])
  // Branch → PR number for branches with open PRs. Used to label the
  // "Push to PR #N" button when the current branch already has a PR.
  const [openPrByBranch, setOpenPrByBranch] = useState<Record<string, number>>({})
  const [creatingPr, setCreatingPr] = useState(false)
  const [pushingToPr, setPushingToPr] = useState(false)

  // Custom actions
  const [customActions, setCustomActions] = useState<CustomAction[]>([])
  const [runningActions, setRunningActions] = useState<Set<string>>(new Set())

  // Config state
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [testCommandInput, setTestCommandInput] = useState('')
  const [testCronEnabledInput, setTestCronEnabledInput] = useState(false)
  const [testCronScheduleInput, setTestCronScheduleInput] = useState('')
  const [autoCommitEnabledInput, setAutoCommitEnabledInput] = useState(false)
  const [autoPushEnabledInput, setAutoPushEnabledInput] = useState(false)
  const [autoPrMergeEnabledInput, setAutoPrMergeEnabledInput] = useState(false)
  const [releaseAfterRunInput, setReleaseAfterRunInput] = useState(false)
  const [prWorkflowEnabledInput, setPrWorkflowEnabledInput] = useState(false)
  const [issueAutoBranchInput, setIssueAutoBranchInput] = useState(true)
  const [testsDisabledInput, setTestsDisabledInput] = useState(false)
  const [reviewDisabledInput, setReviewDisabledInput] = useState(false)
  const [configSaving, setConfigSaving] = useState(false)
  const [configSaved, setConfigSaved] = useState(false)

  // Custom actions editor state
  const [editActions, setEditActions] = useState<CustomAction[]>([])
  const [actionsSaving, setActionsSaving] = useState(false)
  const [actionsSaved, setActionsSaved] = useState(false)
  const [actionsLoaded, setActionsLoaded] = useState(false)


  useEffect(() => {
    if (!name) return
    let active = true
    const poll = async () => {
      try {
        const data = await fetchJobs(name)
        if (active) setProjectJobs(data.jobs)
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 10000)
    return () => { active = false; clearInterval(interval) }
  }, [name])

  // Load custom actions
  useEffect(() => {
    if (!name) return
    fetchCustomActions(name).then((data) => setCustomActions(data.actions)).catch(() => {})
  }, [name])

  // Poll issues/PRs + current/default branch together so the Create PR button
  // stays in sync with external branch switches and externally-closed PRs.
  useEffect(() => {
    if (!name) return
    let active = true
    const poll = async () => {
      const [issuesRes, branchRes] = await Promise.allSettled([
        fetchIssuesAndPRs(name),
        fetchBranch(name),
      ])
      if (!active) return
      if (issuesRes.status === 'fulfilled') {
        setIssueCount({ prs: issuesRes.value.prs.length, issues: issuesRes.value.issues.length })
        setOpenPrBranches(issuesRes.value.prs.map(pr => pr.headRefName))
        setOpenPrByBranch(Object.fromEntries(issuesRes.value.prs.map(pr => [pr.headRefName, pr.number])))
      }
      if (branchRes.status === 'fulfilled') {
        setCurrentBranch(branchRes.value.branch)
        setDefaultBranch(branchRes.value.defaultBranch)
        setBranchCommitsAhead(branchRes.value.commitsAhead)
      }
    }
    poll()
    const interval = setInterval(poll, 10000)
    return () => { active = false; clearInterval(interval) }
  }, [name])

  const handleCustomAction = async (actionName: string) => {
    if (!name || runningActions.has(actionName)) return
    setRunningActions((prev) => new Set(prev).add(actionName))
    try {
      const result = await runCustomAction(name, actionName)
      toast(`${actionName} started for ${name}`, 'success')
      router.push(`/project/${name}/terminal?job=${encodeURIComponent(result.job_id)}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : `Failed to run ${actionName}`, 'error')
    } finally {
      setRunningActions((prev) => {
        const next = new Set(prev)
        next.delete(actionName)
        return next
      })
    }
  }

  // Load config when the overview or config tab is active (overview uses it for cron schedule hint).
  useEffect(() => {
    if ((activeTab !== 'config' && activeTab !== 'overview' && activeTab !== 'terminal') || !name) return
    let active = true
    setConfigLoading(true)
    Promise.all([
      fetchProjectConfig(name),
      !actionsLoaded ? fetchCustomActions(name) : null,
    ])
      .then(([configData, actionsData]) => {
        if (active) {
          setConfig(configData)
          setTestCommandInput(configData.test_command)
          setTestCronEnabledInput(configData.test_cron_enabled)
          setTestCronScheduleInput(configData.test_cron_schedule)
          setAutoCommitEnabledInput(!!configData.auto_commit_enabled)
          setAutoPushEnabledInput(!!configData.auto_push_enabled)
          setAutoPrMergeEnabledInput(!!configData.auto_pr_merge_enabled)
          setReleaseAfterRunInput(!!configData.release_after_run)
          setPrWorkflowEnabledInput(!!configData.pr_workflow_enabled)
          setIssueAutoBranchInput(configData.issue_auto_branch ?? true)
          setTestsDisabledInput(!!configData.tests_disabled)
          setReviewDisabledInput(!!configData.review_disabled)
          if (actionsData) {
            setEditActions(actionsData.actions)
            setActionsLoaded(true)
          }
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => { if (active) setConfigLoading(false) })
    return () => { active = false }
  }, [activeTab, name])


  const project = fleet.projects.find(p => p.project === name)

  if (!project) {
    return (
      <div className="p-6">
        <button className="text-accent hover:underline text-sm mb-4 inline-block" onClick={() => router.push('/')}>
          &larr; Back to projects
        </button>
        <p className="text-text-secondary text-sm p-6">
          Project "{name}" not found.
        </p>
      </div>
    )
  }

  const aggregateCi = getAggregateCi(project)

  const ciFailedUrl = project.tasks.find(t => t.task.ci_failed_url)?.task.ci_failed_url || null
  const releaseTag = project.tasks.find(t => t.task.release_tag)?.task.release_tag || null
  const githubUrl = project.tasks.find(t => t.task.github)?.task.github || null
  const hasUnreviewed = project.unreviewedCount > 0
  const isReviewRunning = projectJobs.some(j => j.kind === 'review' && j.status === 'running')
  const isCiFixRunning = projectJobs.some(j => j.kind === 'fix-ci' && j.status === 'running')
  const isTestRunning = projectJobs.some(j => j.kind === 'test' && j.status === 'running')
  const isPipelineRunning = isPipelineBusy(projectJobs)

  // Get latest review verdict
  const latestReview = projectJobs
    .filter(j => j.kind === 'review' && j.status === 'done' && j.verdict)
    .sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))[0]
  const verdict = latestReview?.verdict

  // Get latest test result
  const latestTest = projectJobs
    .filter(j => j.kind === 'test' && j.status === 'done')
    .sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))[0]

  const runningJobs = (() => {
    const running = projectJobs.filter(j => j.status === 'running')
    // A release job orchestrates test/review/fix/push as children. Surfacing
    // both the parent and its active child as separate "running" rows is
    // noisy — collapse to just the release while it's in flight.
    const releaseRunning = running.some(j => j.kind === 'release')
    const RELEASE_CHILD_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'mark-dod', 'pr-wait'])
    const filtered = releaseRunning
      ? running.filter(j => !RELEASE_CHILD_KINDS.has(j.kind))
      : running
    return filtered.sort((a, b) => (b.started_at || 0) - (a.started_at || 0))
  })()

  const [releasing, setReleasing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [pullResult, setPullResult] = useState<string | null>(null)
  const [pullDiverged, setPullDiverged] = useState(false)
  const [behindCount, setBehindCount] = useState(0)

  useEffect(() => {
    if (!name) return
    fetchBehind(name).then((r) => setBehindCount(r.behind)).catch(() => {})
  }, [name])

  const handlePull = async (strategy: 'ff-only' | 'merge' | 'rebase' = 'ff-only') => {
    if (!name || pulling) return
    setPulling(true)
    setPullResult(null)
    setPullDiverged(false)
    try {
      const res = await pullProject(name, strategy)
      const msg = res.output || 'Already up to date.'
      const alreadyUpToDate = msg.includes('Already up to date')
      setPullResult(alreadyUpToDate ? 'Already up to date.' : 'Pulled.')
      if (!alreadyUpToDate) setBehindCount(0)
      setTimeout(() => setPullResult(null), 4000)
    } catch (err) {
      if (err instanceof PullDivergedError) {
        setPullDiverged(true)
      } else {
        setPullResult(err instanceof Error ? err.message : 'Pull failed')
        setTimeout(() => setPullResult(null), 6000)
      }
    } finally {
      setPulling(false)
    }
  }

  const handleTest = async () => {
    if (!name || testing || isTestRunning) return
    setTesting(true)
    try {
      const result = await testProject(name)
      router.push(`/project/${name}/terminal?job=${result.job_id}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to start test', 'error')
    } finally {
      setTesting(false)
    }
  }

  const handlePush = async () => {
    if (!name || pushing) return
    setPushing(true)
    try {
      const result = await pushProject(name)
      router.push(`/project/${name}/terminal?job=${result.job_id}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to push', 'error')
    } finally {
      setPushing(false)
    }
  }

  const handleRelease = async () => {
    if (!name || releasing) return
    setReleasing(true)
    try {
      const result = await releaseProject(name)
      toast(`${result.step}: ${result.message}`, 'info')
      // Prefer the unified release meta-terminal so the user sees
      // test → review → commit → push in a single log.
      const jobIdToOpen = result.release_job_id ?? result.job_id
      if (jobIdToOpen) {
        router.push(`/project/${name}/terminal?job=${encodeURIComponent(jobIdToOpen)}`)
      }
    } catch (err) {
      const error = err as Error & { isPipelineLocked?: boolean; blockingJobId?: string }
      if (error.isPipelineLocked) {
        const msg = error.blockingJobId
          ? `Pipeline is running (job ${error.blockingJobId}). Click the job to watch its progress.`
          : 'Pipeline is already running. Wait for it to complete before starting another release.'
        toast(msg, 'info')
      } else {
        toast(error instanceof Error ? error.message : 'Failed to start release', 'error')
      }
    } finally {
      setReleasing(false)
    }
  }

  const handlePushToPr = async () => {
    if (!name || pushingToPr) return
    setPushingToPr(true)
    try {
      const result = await pushProject(name, { commit: true })
      router.push(`/project/${name}/terminal?job=${encodeURIComponent(result.job_id)}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to push to PR', 'error')
    } finally {
      setPushingToPr(false)
    }
  }

  const handleCreatePr = async () => {
    if (!name || creatingPr) return
    setCreatingPr(true)
    try {
      const result = await createProjectPR(name)
      // Confirmation only — do NOT auto-open a new tab. The button flips from
      // "Create PR" to nothing (or "View PR" in ChangesTab) once the PR list
      // refresh below completes; the toast surfaces the URL if the user
      // actually wants to navigate.
      toast(result.url ? `Pull request created: ${result.url}` : 'Pull request created', 'success')
      // Force-refresh PR list (bypass server cache) so the button disappears
      fetchIssuesAndPRs(name, true).then((data) => {
        setIssueCount({ prs: data.prs.length, issues: data.issues.length })
        setOpenPrBranches(data.prs.map(pr => pr.headRefName))
        setOpenPrByBranch(Object.fromEntries(data.prs.map(pr => [pr.headRefName, pr.number])))
      }).catch(() => {})
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to create PR', 'error')
    } finally {
      setCreatingPr(false)
    }
  }

  const handleFixCi = async () => {
    if (!name || fixingCi) return
    setFixingCi(true)
    setFixCiResult(null)
    try {
      const result = await fixCi(name)
      router.push(`/project/${name}/terminal?job=${encodeURIComponent(result.job_id)}`)
    } catch (err) {
      setFixCiResult(err instanceof Error ? err.message : 'Failed to start CI fix')
      setFixingCi(false)
    }
  }

  const handleSaveActions = async () => {
    if (!name || actionsSaving) return
    // Filter out empty rows
    const valid = editActions.filter(a => a.name.trim() && a.command.trim())
    setActionsSaving(true)
    setActionsSaved(false)
    try {
      const result = await saveCustomActions(name, valid)
      setEditActions(result.actions)
      setCustomActions(result.actions)
      setActionsSaved(true)
      setTimeout(() => setActionsSaved(false), 3000)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save actions', 'error')
    } finally {
      setActionsSaving(false)
    }
  }

  const handleSaveConfig = async () => {
    if (!name || configSaving) return
    setConfigSaving(true)
    setConfigSaved(false)
    try {
      await updateProjectConfig(name, {
        test_command: testCommandInput,
        test_cron_enabled: testCronEnabledInput,
        test_cron_schedule: testCronScheduleInput,
        auto_commit_enabled: autoCommitEnabledInput,
        auto_push_enabled: autoPushEnabledInput,
        auto_pr_merge_enabled: autoPrMergeEnabledInput,
        release_after_run: releaseAfterRunInput,
        pr_workflow_enabled: prWorkflowEnabledInput,
        issue_auto_branch: issueAutoBranchInput,
        tests_disabled: testsDisabledInput,
        review_disabled: reviewDisabledInput,
      })
      setConfigSaved(true)
      // Reload config to show effective command
      const data = await fetchProjectConfig(name)
      setConfig(data)
      setTestCommandInput(data.test_command)
      setTestCronEnabledInput(data.test_cron_enabled)
      setTestCronScheduleInput(data.test_cron_schedule)
      setAutoCommitEnabledInput(!!data.auto_commit_enabled)
      setAutoPushEnabledInput(!!data.auto_push_enabled)
      setAutoPrMergeEnabledInput(!!data.auto_pr_merge_enabled)
      setReleaseAfterRunInput(!!data.release_after_run)
      setPrWorkflowEnabledInput(!!data.pr_workflow_enabled)
      setIssueAutoBranchInput(data.issue_auto_branch ?? true)
      setTestsDisabledInput(!!data.tests_disabled)
      setReviewDisabledInput(!!data.review_disabled)
      setTimeout(() => setConfigSaved(false), 3000)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save config', 'error')
    } finally {
      setConfigSaving(false)
    }
  }

  const configDirty =
    config !== null &&
    (testCommandInput !== config.test_command ||
      testCronEnabledInput !== config.test_cron_enabled ||
      testCronScheduleInput !== config.test_cron_schedule ||
      autoCommitEnabledInput !== !!config.auto_commit_enabled ||
      autoPushEnabledInput !== !!config.auto_push_enabled ||
      autoPrMergeEnabledInput !== !!config.auto_pr_merge_enabled ||
      releaseAfterRunInput !== !!config.release_after_run ||
      prWorkflowEnabledInput !== !!config.pr_workflow_enabled ||
      issueAutoBranchInput !== (config.issue_auto_branch ?? true) ||
      testsDisabledInput !== !!config.tests_disabled ||
      reviewDisabledInput !== !!config.review_disabled)

  const actionsDirty = JSON.stringify(editActions) !== JSON.stringify(customActions)
  const anyDirty = configDirty || actionsDirty
  const anySaving = configSaving || actionsSaving
  const allSaved = configSaved && actionsSaved

  const handleSaveAll = async () => {
    await Promise.all([
      configDirty ? handleSaveConfig() : Promise.resolve(),
      actionsDirty ? handleSaveActions() : Promise.resolve(),
    ])
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-text-primary" data-private>{project.project}</h2>
          {releaseTag && <span className="text-text-secondary text-sm" data-private>{releaseTag}</span>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {aggregateCi === 'failure' && ciFailedUrl && (
            <button
              className="px-3 py-1.5 text-sm border border-status-error text-status-error rounded-md hover:bg-status-error/10 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleFixCi}
              disabled={fixingCi || isCiFixRunning}
              title={isCiFixRunning ? 'CI fix already in progress' : 'Start CI fix'}
            >
              {fixingCi || isCiFixRunning ? 'CI Fix in Progress...' : 'Fix CI'}
            </button>
          )}
          {fixCiResult && (
            <span className={`text-xs ${fixCiResult.startsWith('CI fix started') ? 'text-status-success' : 'text-status-error'}`}>
              {fixCiResult}
            </span>
          )}
          {(() => {
            const busy = releasing || isPipelineRunning
            const nothingToRelease = project.totalChanges === 0 && (project.unpushed ?? 0) === 0
            const hasTestCommand = !!(config?.effective_test_command || config?.detected_test_command)
            // Fresh LGTM review on the current tree → hitting Release skips
            // test+review and goes straight to commit & push. Make that obvious
            // in the label/tooltip so the user isn't surprised.
            const freshLgtm = verdict === 'LGTM' && !hasUnreviewed && project.totalChanges > 0
            const steps: string[] = []
            if (freshLgtm) {
              steps.push('commit', 'push')
            } else if (project.totalChanges > 0) {
              if (hasTestCommand) steps.push('test')
              steps.push('review', 'commit', 'push')
            } else {
              steps.push('push')
            }
            const multiStep = steps.length > 1
            const chainSuffix = multiStep && !config?.auto_push_enabled && !freshLgtm
              ? ' (enable auto-push in config to auto-chain)'
              : ''
            // Show whenever we're on a non-default branch with no open PR for
            // it. Not gated by pr_workflow_enabled — even Direct Branch projects
            // benefit from an ad-hoc PR button (e.g. to review a feature branch
            // before merging manually, or to rescue commits marooned on a local
            // branch whose remote ref was deleted post-merge).
            const isOnFeatureBranch = !!currentBranch && !!defaultBranch && currentBranch !== defaultBranch
            const hasOpenPr = openPrBranches.includes(currentBranch ?? '')
            const showCreatePr = isOnFeatureBranch && !hasOpenPr
            // gh pr create rejects with "No commits between base and head" when
            // the branch has no commits ahead of origin/<default> — common
            // after a stranded-on-merged-branch state. Disable the button with
            // an explanatory tooltip rather than letting the click 500.
            const noCommitsToPr = isOnFeatureBranch && branchCommitsAhead === 0
            const createPrDisabled = creatingPr || noCommitsToPr
            const createPrTitle = noCommitsToPr
              ? `Branch ${currentBranch} has no commits ahead of origin/${defaultBranch}. Commit your changes (use 🚀 Release) or move them to ${defaultBranch} first.`
              : `Create pull request for branch ${currentBranch}`
            return (
              <>
                <button
                  className="px-3 py-1.5 text-sm border border-accent bg-accent/10 text-accent rounded-md hover:bg-accent/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                  onClick={handleRelease}
                  disabled={busy || nothingToRelease}
                  title={
                    nothingToRelease
                      ? 'Nothing to release — no changes and no unpushed commits'
                      : busy
                        ? 'Release pipeline already running'
                        : freshLgtm
                          ? `Ship it — review already LGTM, will commit & push directly (skips test + review)`
                          : `Release: ${steps.join(' → ')}${chainSuffix}`
                  }
                >
                  {busy ? 'Releasing…' : freshLgtm ? '🚢 Ship (LGTM)' : '🚀 Release'}
                </button>
                {showCreatePr && (
                  <button
                    className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                    onClick={handleCreatePr}
                    disabled={createPrDisabled}
                    title={createPrTitle}
                  >
                    {creatingPr ? 'Creating PR…' : 'Create PR'}
                  </button>
                )}
                {hasOpenPr && project.totalChanges > 0 && (
                  <button
                    className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                    onClick={handlePushToPr}
                    disabled={pushingToPr}
                    title={`Stage ${project.totalChanges} change${project.totalChanges === 1 ? '' : 's'}, commit (Claude-generated message), push — attaches to existing PR. Skips test + review (use Release for the full pipeline).`}
                  >
                    {pushingToPr ? 'Pushing…' : `Push to PR${openPrByBranch[currentBranch ?? ''] ? ` #${openPrByBranch[currentBranch ?? '']}` : ''}`}
                  </button>
                )}
              </>
            )
          })()}
          {!!(config?.effective_test_command || config?.detected_test_command) && (
            <button
              className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              onClick={handleTest}
              disabled={testing || isTestRunning}
              title={isTestRunning ? 'Tests already running' : `Run: ${config?.effective_test_command || config?.detected_test_command}`}
            >
              {testing || isTestRunning ? 'Testing…' : 'Test'}
            </button>
          )}
          {customActions.map((action) => (
            <button
              key={action.name}
              className="btn-custom"
              style={{ '--btn-color': action.color || 'var(--color-accent)' } as React.CSSProperties}
              onClick={() => handleCustomAction(action.name)}
              disabled={runningActions.has(action.name)}
              title={`Run: ${action.command}`}
            >
              {runningActions.has(action.name) ? `${action.name}...` : action.name}
            </button>
          ))}
          {(project.unpushed ?? 0) > 0 && project.totalChanges === 0 && (
            <button
              className="px-3 py-1.5 text-sm border border-status-warning/60 bg-status-warning/10 text-status-warning rounded-md hover:bg-status-warning/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              onClick={handlePush}
              disabled={pushing}
              title={`Push ${project.unpushed} commit${project.unpushed !== 1 ? 's' : ''} to origin`}
            >
              {pushing ? 'Pushing…' : `Push (${project.unpushed})`}
            </button>
          )}
          {pullDiverged ? (
            <>
              <span className="text-xs text-status-error font-medium">Diverged:</span>
              <button
                className="px-3 py-1.5 text-sm border border-status-info/50 bg-status-info/10 text-status-info rounded-md hover:bg-status-info/20 cursor-pointer disabled:opacity-50 font-medium"
                onClick={() => handlePull('rebase')}
                disabled={pulling}
                title="git pull --rebase"
              >
                {pulling ? 'Working…' : 'Rebase'}
              </button>
              <button
                className="px-3 py-1.5 text-sm border border-border bg-bg-secondary text-text-primary rounded-md hover:bg-bg-tertiary cursor-pointer disabled:opacity-50 font-medium"
                onClick={() => handlePull('merge')}
                disabled={pulling}
                title="git pull --no-ff"
              >
                {pulling ? 'Working…' : 'Merge'}
              </button>
              <button
                className="px-2 py-1 text-xs text-text-tertiary hover:text-text-secondary cursor-pointer"
                onClick={() => setPullDiverged(false)}
              >✕</button>
            </>
          ) : (
            <button
              className={`px-3 py-1.5 text-sm border rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                project.totalChanges > 0
                  ? 'border-border bg-bg-secondary text-text-primary cursor-not-allowed'
                  : behindCount > 0
                  ? 'border-status-warning/60 bg-status-warning/10 text-status-warning hover:bg-status-warning/20 cursor-pointer'
                  : 'border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer'
              }`}
              onClick={() => handlePull('ff-only')}
              disabled={pulling || project.totalChanges > 0 || behindCount === 0}
              title={
                project.totalChanges > 0
                  ? `Commit or stash your ${project.totalChanges} local change${project.totalChanges !== 1 ? 's' : ''} before pulling`
                  : behindCount > 0
                  ? `${behindCount} commit${behindCount !== 1 ? 's' : ''} behind origin — git pull --ff-only`
                  : 'Already up to date'
              }
            >
              {pulling ? 'Pulling…' : behindCount > 0 ? `Pull (${behindCount})` : 'Pull'}
            </button>
          )}
          {pullResult && (
            <span className={`text-xs ${pullResult.includes('failed') || pullResult.includes('error') ? 'text-status-error' : 'text-status-success'}`}>
              {pullResult}
            </span>
          )}
          {name && (
            <Link
              href={`/pipeline?project=${encodeURIComponent(name)}`}
              className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer inline-flex items-center no-underline font-medium"
            >
              Pipeline
            </Link>
          )}
          {githubUrl && (
            <a
              className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer inline-flex items-center font-medium"
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub &#8599;
            </a>
          )}
        </div>
      </div>

      {/* Tab Navigation */}
      <nav className="flex gap-1 border-b border-border mb-4">
        <button
          className={`px-3 py-1.5 text-sm cursor-pointer ${activeTab === 'overview' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </button>
        <button
          className={`px-3 py-1.5 text-sm cursor-pointer ${activeTab === 'terminal' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
          onClick={async () => {
            try {
              const data = await fetchJobs(name)
              const lastSession = data.jobs
                .filter(j => j.kind === 'run' && j.session_id)
                .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0]
              if (lastSession?.session_id) {
                router.push(`/project/${name}/terminal/${lastSession.session_id}`)
                return
              }
            } catch { /* ignore */ }
            setActiveTab('terminal')
          }}
        >
          Terminal
        </button>
        <button
          className={`px-3 py-1.5 text-sm cursor-pointer ${activeTab === 'changes' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
          onClick={() => setActiveTab('changes')}
        >
          Changes
          {project.totalChanges > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-accent-light text-accent font-medium">
              {project.totalChanges}
            </span>
          )}
        </button>
        <button
          className={`px-3 py-1.5 text-sm cursor-pointer ${activeTab === 'history' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
          onClick={() => setActiveTab('history')}
        >
          History
        </button>
        <button
          className={`px-3 py-1.5 text-sm cursor-pointer ${activeTab === 'issues' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
          onClick={() => setActiveTab('issues')}
        >
          Issues / PRs
          {issueCount && (issueCount.prs + issueCount.issues) > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-accent-light text-accent font-medium">
              {issueCount.prs + issueCount.issues}
            </span>
          )}
        </button>
        <button
          className={`px-3 py-1.5 text-sm cursor-pointer ${activeTab === 'docs' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
          onClick={() => setActiveTab('docs')}
        >
          Docs
        </button>
        <button
          className={`px-3 py-1.5 text-sm cursor-pointer ${activeTab === 'config' ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}
          onClick={() => setActiveTab('config')}
        >
          Config
        </button>
      </nav>

      {/* Overview Tab — Agents */}
      {activeTab === 'overview' && name && (
        <>
          {/* Running-now banner: surfaces any in-progress work without requiring a tab switch. */}
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
                    onClick={() => router.push(`/project/${name}/terminal?job=${encodeURIComponent(j.id)}`)}
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

          {/* Changes / Review / Tests / CI status strip */}
          <StatusStrip
            projectName={name}
            totalChanges={project.totalChanges}
            unpushed={project.unpushed ?? 0}
            hasUnreviewed={hasUnreviewed}
            verdict={verdict}
            isReviewRunning={isReviewRunning}
            latestReview={latestReview}
            isTestRunning={isTestRunning}
            latestTest={latestTest}
            testCronSchedule={config?.test_cron_enabled ? config.test_cron_schedule : null}
            ciStatus={aggregateCi === 'success' || aggregateCi === 'failure' || aggregateCi === 'in_progress' ? aggregateCi : null}
            ciFailedUrl={ciFailedUrl}
            releaseTag={releaseTag}
            onOpenChanges={() => setActiveTab('changes')}
            onOpenJob={(jobId) => router.push(`/project/${name}/terminal?job=${encodeURIComponent(jobId)}`)}
          />

          <AgentsTab
            projectName={name}
            currentBranch={currentBranch}
            prWorkflowEnabled={!!config?.pr_workflow_enabled}
          />
        </>
      )}

      {/* Config Tab */}
      {activeTab === 'config' && (
        <div className="mt-4">
          {configLoading ? (
            <div className="space-y-4 animate-pulse">
              <div className="bg-bg-secondary rounded-lg border border-border h-32" />
              <div className="bg-bg-secondary rounded-lg border border-border h-48" />
              <div className="bg-bg-secondary rounded-lg border border-border h-64" />
            </div>
          ) : config ? (
            <div className="space-y-4">

              {/* File config banner */}
              {config.file_config && config.file_config.length > 0 && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-tertiary border border-border text-xs text-text-secondary">
                  <span className="font-mono text-accent">.tamtam/config.yml</span>
                  <span>—</span>
                  <span>overrides: {config.file_config.join(', ')}</span>
                  {config.file_config_is_default_branch === false && config.current_branch && (
                    <>
                      <span>·</span>
                      <span className="text-amber-400">
                        showing <span className="font-mono">{config.file_config_branch}</span> config
                        (you are on <span className="font-mono">{config.current_branch}</span>);
                        changes take effect after merge
                      </span>
                    </>
                  )}
                  <span className="ml-auto text-text-tertiary">saved automatically on change</span>
                </div>
              )}

              {/* Save bar */}
              <div className="flex items-center justify-end gap-3">
                {anyDirty && !anySaving && (
                  <span className="text-xs text-text-tertiary">Unsaved changes</span>
                )}
                <button
                  className={`px-4 py-2 text-white border-none rounded-lg font-semibold text-sm transition-colors ${
                    allSaved    ? 'bg-status-success cursor-default' :
                    anyDirty    ? 'bg-accent hover:bg-accent-hover cursor-pointer' :
                                  'bg-accent/40 cursor-default'
                  } ${anySaving ? 'opacity-50 cursor-wait' : ''}`}
                  onClick={handleSaveAll}
                  disabled={anySaving || !anyDirty}
                >
                  {anySaving ? 'Saving…' : allSaved ? 'Saved!' : 'Save'}
                </button>
              </div>

              {/* Testing */}
              <div className="bg-bg-secondary rounded-lg border border-border">
                <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
                  <h3 className="text-sm font-semibold text-text-primary">Testing</h3>
                  <p className="text-xs text-text-tertiary">Test command run before every release</p>
                </div>
                <div className="px-5 py-4 space-y-4">
                  <div>
                    <label className="block font-medium text-sm text-text-primary mb-1.5" htmlFor="test-command">
                      Test Command
                    </label>
                    <input
                      id="test-command"
                      type="text"
                      className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors placeholder:text-text-tertiary"
                      value={testCommandInput}
                      onChange={(e) => setTestCommandInput(e.target.value)}
                      placeholder={config.detected_test_command || 'e.g. npm test, pytest, forge test'}
                    />
                    <p className="text-xs text-text-tertiary mt-1.5">
                      Auto-detected: <code className="bg-bg-tertiary px-1 rounded">{config.detected_test_command || 'none'}</code>
                      {' · '}
                      Effective: <code className="bg-bg-tertiary px-1 rounded text-accent">{config.effective_test_command || 'none'}</code>
                    </p>
                  </div>

                  <div className="pt-3 border-t border-border">
                    <label className="flex items-center gap-2.5 cursor-pointer select-none">
                      <input
                        id="test-cron-enabled"
                        type="checkbox"
                        className="w-4 h-4 cursor-pointer accent-accent"
                        checked={testCronEnabledInput}
                        onChange={(e) => setTestCronEnabledInput(e.target.checked)}
                      />
                      <span className="text-sm font-medium text-text-primary">Run on schedule</span>
                    </label>
                    {testCronEnabledInput && (
                      <div className="mt-2.5 ml-6 flex items-center gap-2">
                        <input
                          type="text"
                          className="w-36 px-3 py-1.5 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary font-mono"
                          value={testCronScheduleInput}
                          onChange={(e) => setTestCronScheduleInput(e.target.value)}
                          placeholder="1h"
                        />
                        <span className="text-xs text-text-tertiary">e.g. <code className="font-mono">30m</code>, <code className="font-mono">6h</code>, <code className="font-mono">1d</code></span>
                      </div>
                    )}
                    {!testCronEnabledInput && (
                      <p className="mt-1 ml-6 text-xs text-text-tertiary">Tests only run manually or via release pipeline.</p>
                    )}
                  </div>
                </div>

              </div>

              {/* "Work on" pipeline — governs what happens when the user
                  clicks the Work on button on a GitHub issue. */}
              <div className="bg-bg-secondary rounded-lg p-5">
                <h3 className="text-sm font-semibold text-text-primary mb-1">When you click <span className="font-mono">Work on</span></h3>
                <p className="text-xs text-text-tertiary mb-4">
                  Each step of the issue-driven pipeline. Toggle what should fire when you click <span className="font-mono">Work on</span> on a GitHub issue.
                </p>
                <div className="space-y-4">
                  <label className="flex items-start gap-2.5 cursor-pointer select-none">
                    <input
                      id="issue-auto-branch"
                      type="checkbox"
                      className="w-4 h-4 mt-0.5 cursor-pointer accent-accent"
                      checked={issueAutoBranchInput}
                      onChange={(e) => setIssueAutoBranchInput(e.target.checked)}
                    />
                    <div>
                      <span className="text-sm font-medium text-text-primary">Create feature branch</span>
                      <p className="mt-0.5 text-xs text-text-tertiary">
                        Provision <code className="font-mono">fix/issue-&lt;n&gt;-&lt;slug&gt;</code> and check it out before Claude starts editing. Turn off to have Claude work on whatever branch is currently checked out.
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Release Pipeline */}
              <div className="bg-bg-secondary rounded-lg border border-border">
                <div className="px-5 py-3 border-b border-border">
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <h3 className="text-sm font-semibold text-text-primary">Release Pipeline</h3>
                    <p className="text-xs text-text-tertiary">Click a step to toggle. Fix is gated by review.{prWorkflowEnabledInput ? ' dod always runs in PR Workflow.' : ''}</p>
                  </div>
                </div>

                {/* Mode selector */}
                <div className="px-5 pt-4 pb-3 border-b border-border">
                  <div className="flex gap-1 p-1 bg-bg-tertiary rounded-lg border border-border w-fit">
                    <button
                      type="button"
                      onClick={() => { setPrWorkflowEnabledInput(false); setAutoPrMergeEnabledInput(false) }}
                      className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${!prWorkflowEnabledInput ? 'bg-bg-secondary text-text-primary shadow-sm border border-border' : 'text-text-tertiary hover:text-text-secondary'}`}
                    >
                      Direct Branch
                    </button>
                    <button
                      type="button"
                      onClick={() => setPrWorkflowEnabledInput(true)}
                      className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${prWorkflowEnabledInput ? 'bg-bg-secondary text-text-primary shadow-sm border border-border' : 'text-text-tertiary hover:text-text-secondary'}`}
                    >
                      PR Workflow
                    </button>
                  </div>
                  <p className="text-xs text-text-tertiary mt-2">
                    {prWorkflowEnabledInput
                      ? 'Changes are pushed to a feature/issue branch and reviewed via pull request. DoD checkboxes from the linked GitHub issue are verified before merge.'
                      : 'Changes are committed and pushed directly to the current branch. No pull request is created.'}
                  </p>
                </div>

                {/* Clickable pipeline flow strip — authoritative control for per-step toggles */}
                <div className="px-5 py-4 border-b border-border">
                  {(() => {
                    const stepCtx: StepToggleContext = {
                      config: {
                        effective_test_command: config.effective_test_command,
                        tests_disabled: testsDisabledInput,
                        review_disabled: reviewDisabledInput,
                        auto_commit_enabled: autoCommitEnabledInput,
                        auto_push_enabled: autoPushEnabledInput,
                        auto_pr_merge_enabled: autoPrMergeEnabledInput,
                        pr_workflow_enabled: prWorkflowEnabledInput,
                      },
                      setters: {
                        setAutoCommit: setAutoCommitEnabledInput,
                        setAutoPush: setAutoPushEnabledInput,
                        setAutoMerge: setAutoPrMergeEnabledInput,
                        setTestsDisabled: setTestsDisabledInput,
                        setReviewDisabled: setReviewDisabledInput,
                      },
                      focusElement: (id: string) => {
                        const el = document.getElementById(id) as HTMLElement | null
                        if (el) {
                          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                          el.focus()
                        }
                      },
                    }
                    const steps = getPipelineSteps(prWorkflowEnabledInput ? 'pr' : 'direct')
                    return (
                      <>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {steps.map((step, i) => {
                            const active = step.isActive(stepCtx)
                            const toggleable = !!step.onToggle && !step.mandatory
                            const title = step.description(stepCtx)
                            const baseChip = 'px-2 py-1 text-xs rounded font-mono border transition-colors'
                            const chipClass = active
                              ? 'bg-accent/15 text-accent border-accent/30 hover:bg-accent/25'
                              : 'bg-bg-tertiary text-text-tertiary border-border hover:bg-bg-primary hover:text-text-secondary'
                            const cursorClass = toggleable ? 'cursor-pointer' : 'cursor-default'
                            return (
                              <span key={step.id} className="flex items-center gap-1.5">
                                {toggleable ? (
                                  <button
                                    type="button"
                                    title={title}
                                    onClick={() => step.onToggle!(stepCtx)}
                                    className={`${baseChip} ${chipClass} ${cursorClass}`}
                                  >
                                    {step.label}
                                  </button>
                                ) : (
                                  <span
                                    title={title}
                                    aria-disabled
                                    className={`${baseChip} ${chipClass} ${cursorClass} opacity-90`}
                                  >
                                    {step.mandatory
                                      ? null
                                      : <span className="mr-1 text-[10px] opacity-60">↻</span>}
                                    {step.label}
                                  </span>
                                )}
                                {i < steps.length - 1 && <span className="text-text-tertiary text-xs">→</span>}
                              </span>
                            )
                          })}
                        </div>
                        {/* Inline per-step descriptions — keeps cascade/tooltip copy
                            visible without relying on hover (touch devices, accessibility). */}
                        <ul className="mt-3 space-y-1">
                          {steps.map((step) => {
                            const active = step.isActive(stepCtx)
                            return (
                              <li key={step.id} className="flex items-start gap-2 text-xs text-text-tertiary">
                                <span className={`font-mono shrink-0 w-14 ${active ? 'text-accent' : 'text-text-tertiary'}`}>{step.label}</span>
                                <span className="flex-1">{step.description(stepCtx)}</span>
                              </li>
                            )
                          })}
                        </ul>
                      </>
                    )
                  })()}
                </div>

                {/* Trigger cadence — WHEN the pipeline starts, not WHICH steps run. */}
                <div className="px-5 py-2">
                  <label className="flex items-start gap-3 p-3 rounded-lg hover:bg-bg-tertiary/50 cursor-pointer transition-colors select-none -mx-3">
                    <input
                      id="release-after-run"
                      type="checkbox"
                      className="w-4 h-4 accent-accent rounded mt-0.5 shrink-0 cursor-pointer"
                      checked={releaseAfterRunInput}
                      onChange={(e) => setReleaseAfterRunInput(e.target.checked)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm text-text-primary">Trigger pipeline after each agent run</div>
                      <div className="text-xs text-text-tertiary">When a terminal or agent run finishes successfully, automatically start the release pipeline.</div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Custom Actions */}
              <div className="bg-bg-secondary rounded-lg border border-border">
                <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
                  <div className="flex items-baseline gap-3">
                    <h3 className="text-sm font-semibold text-text-primary">Custom Actions</h3>
                    <p className="text-xs text-text-tertiary">Bash commands that appear as buttons on the project page</p>
                  </div>
                  <button
                    className="px-3 py-1.5 text-xs bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer transition-colors"
                    onClick={() => setEditActions([...editActions, { name: '', command: '', color: '#2563eb' }])}
                  >
                    + Add Action
                  </button>
                </div>

                <div className="px-5 py-4">
                  {editActions.length === 0 ? (
                    <p className="text-sm text-text-tertiary text-center py-4">No custom actions yet.</p>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid gap-x-2 px-1 mb-1" style={{ gridTemplateColumns: '9rem 1fr 2.5rem 2rem' }}>
                        <span className="text-xs font-medium text-text-tertiary">Label</span>
                        <span className="text-xs font-medium text-text-tertiary">Command</span>
                        <span className="text-xs font-medium text-text-tertiary">Color</span>
                        <span />
                      </div>
                      {editActions.map((action, i) => (
                        <div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns: '9rem 1fr 2.5rem 2rem' }}>
                          <input
                            type="text"
                            className="px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
                            value={action.name}
                            onChange={(e) => {
                              const next = [...editActions]
                              next[i] = { ...next[i], name: e.target.value }
                              setEditActions(next)
                            }}
                            placeholder="Deploy"
                          />
                          <input
                            type="text"
                            className="px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
                            value={action.command}
                            onChange={(e) => {
                              const next = [...editActions]
                              next[i] = { ...next[i], command: e.target.value }
                              setEditActions(next)
                            }}
                            placeholder="./deploy.sh"
                          />
                          <input
                            type="color"
                            className="w-10 h-9 p-0.5 bg-bg-primary border border-border rounded-lg cursor-pointer"
                            value={action.color || '#2563eb'}
                            onChange={(e) => {
                              const next = [...editActions]
                              next[i] = { ...next[i], color: e.target.value }
                              setEditActions(next)
                            }}
                            title="Button color"
                          />
                          <button
                            className="flex items-center justify-center h-9 w-8 text-text-tertiary hover:text-status-error hover:bg-status-error/10 rounded-lg cursor-pointer transition-colors"
                            onClick={() => setEditActions(editActions.filter((_, j) => j !== i))}
                            title="Remove"
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                </div>
              </div>

            </div>
          ) : (
            <div className="text-text-secondary text-sm">Failed to load configuration</div>
          )}
        </div>
      )}

      {activeTab === 'changes' && name && (
        <ChangesTab projectName={name} />
      )}

      {activeTab === 'issues' && name && (
        <IssuesTab projectName={name} onCountChange={setIssueCount} />
      )}

      {activeTab === 'docs' && name && (
        <DocsTab projectName={name} />
      )}

      {/* Runs Tab */}
      {activeTab === 'history' && name && (
        <ProjectRunsTab projectName={name} />
      )}

      {/* Terminal Tab */}
      {activeTab === 'terminal' && name && (
        <>
          {(() => {
            const hasTestCommand = !!(
              config?.effective_test_command ||
              config?.detected_test_command ||
              projectJobs.some(j => j.kind === 'test' && j.started_at >= (Date.now() / 1000 - 60 * 60))
            )
            type StepState = 'pending' | 'running' | 'done' | 'warning' | 'failed'
            // Show strip only while the release pipeline is actively running.
            const pipelineKinds = ['test', 'review', 'fix', 'commit', 'push', 'mark-dod']
            const pipelineRunning = projectJobs.some(
              j => pipelineKinds.includes(j.kind) && j.status === 'running'
            )
            if (!pipelineRunning) return null

            // Find the active release job to link the strip to the trace view.
            const activeReleaseJob = projectJobs
              .filter(j => j.kind === 'release' && j.status === 'running')
              .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0]

            // Each release is a clean slate. Find the currently-running step
            // and use its start time as the anchor.
            // - Steps AFTER the running step in sequence → always pending (haven't run yet).
            // - Steps BEFORE the running step → only valid if they started within
            //   MAX_PIPELINE_DURATION seconds of the running step (i.e. same run).
            //   Anything older is from a previous release and must not carry its ✓ forward.
            const pipelineSequence = ['test', 'review', 'fix', 'commit', 'push', 'mark-dod']
            const runningJob = projectJobs.find(j => pipelineKinds.includes(j.kind) && j.status === 'running')
            const runningIdx = runningJob ? pipelineSequence.indexOf(runningJob.kind) : -1
            const MAX_PIPELINE_DURATION = 30 * 60 // seconds — longer than any realistic test run
            const releaseWindowStart = runningJob ? (runningJob.started_at ?? 0) - MAX_PIPELINE_DURATION : 0

            const latestOfKind = (kind: string): JobInfo | undefined => {
              const idx = pipelineSequence.indexOf(kind)
              // Steps after the currently-running step haven't executed in this release.
              if (runningIdx >= 0 && idx > runningIdx) return undefined
              return projectJobs
                .filter(j => j.kind === kind && (j.started_at ?? 0) >= releaseWindowStart)
                .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0]
            }

            const testJob = latestOfKind('test')
            const reviewJob = latestOfKind('review')
            const fixJob = latestOfKind('fix')
            const commitJob = latestOfKind('commit')
            const pushJob = latestOfKind('push')
            const dodJob = latestOfKind('mark-dod')
            const priorPushStart = pushJob?.started_at ?? 0

            const stateOf = (job: JobInfo | undefined): StepState => {
              if (!job) return 'pending'
              if (job.status === 'running') return 'running'
              if (job.exit_code === 0) return 'done'
              return 'failed'
            }

            const testState: StepState = hasTestCommand ? stateOf(testJob) : 'pending'
            // Review is only "done" when the verdict is LGTM. Any other verdict
            // (NEEDS ATTENTION / DO NOT SHIP) is "failed" — a green check would
            // mislead. Stale LGTM (files changed after) also drops to pending.
            const reviewRawState = stateOf(reviewJob)
            const reviewVerdict = reviewJob?.verdict
            let reviewState: StepState
            let reviewHint = ''
            let reviewFixAction: (() => void) | null = null
            // Clicking any step with a job attached always opens that job's
            // terminal (session URL if available, else single-job URL) — the
            // primary job of clicking is to INSPECT. Starting or retrying a
            // stage belongs to the Release button and to explicit Fix actions,
            // not to pipeline-step clicks.
            const openJob = (j: JobInfo) => {
              const sid = j.session_id
              return () => router.push(sid ? `/project/${name}/terminal/${sid}` : `/project/${name}/terminal?job=${encodeURIComponent(j.id)}`)
            }
            if (reviewRawState === 'running') {
              reviewState = 'running'
              reviewHint = 'review in progress — click to open terminal'
              reviewFixAction = openJob(reviewJob!)
            }
            else if (!reviewJob) { reviewState = 'pending'; reviewHint = 'not run yet — click 🚀 Release' }
            else if (reviewRawState === 'failed') {
              reviewState = 'failed'
              reviewHint = `review job failed (exit ${reviewJob.exit_code}) — click to view log`
              reviewFixAction = openJob(reviewJob)
            }
            else if (reviewVerdict === 'LGTM') {
              // LGTM is a verdict, not a file-hash predicate. Once Claude
              // emitted LGTM, the step stays ✓ — build artifacts, cache
              // files, hook side-effects, and gitignored edits routinely
              // drift the porcelain hash without invalidating the review.
              // A real code edit will trigger a new release → new review
              // job → this resets naturally.
              const commitHookJustFailed = !!config?.last_push_error
                && config.last_push_error.startsWith('Commit failed')
              const pushInFlight = pushJob?.status === 'running'
              reviewState = 'done'
              reviewHint = commitHookJustFailed
                ? 'LGTM — commit blocked by pre-commit hook; click to view review'
                : pushInFlight
                  ? 'LGTM — commit & push in progress; click to view review'
                  : hasUnreviewed
                    ? 'LGTM — files changed since, but verdict is still valid; click to view review'
                    : 'LGTM — click to view review log'
              reviewFixAction = openJob(reviewJob)
            } else if (reviewVerdict === 'NEEDS ATTENTION') {
              reviewState = 'warning'
              reviewHint = 'verdict: NEEDS ATTENTION — click to view findings'
              reviewFixAction = openJob(reviewJob)
            } else {
              // DO NOT SHIP / unknown
              reviewState = 'failed'
              reviewHint = `verdict: ${reviewVerdict || 'unknown'} — click to view findings`
              reviewFixAction = openJob(reviewJob)
            }
            // Fix in progress after a non-LGTM review → show as running, open fix's terminal.
            if ((reviewState === 'failed' || reviewState === 'warning') && fixJob && fixJob.status === 'running') {
              reviewState = 'running'
              reviewHint = 'fix in progress — click to open terminal'
              reviewFixAction = openJob(fixJob)
            }
            const reviewPassed = reviewState === 'done'

            // Fix step state — distinct from the review step
            const fixState: StepState = fixJob?.status === 'running' ? 'running'
              : fixJob && fixJob.exit_code === 0 ? 'done'
              : fixJob && fixJob.exit_code !== 0 ? 'failed'
              : reviewState === 'done' ? 'done'  // LGTM → no fix needed
              : 'pending'
            const fixHint = fixJob?.status === 'running' ? 'fix in progress — click to open terminal'
              : fixJob?.exit_code === 0 ? 'fix applied — click to view log'
              : fixJob && fixJob.exit_code !== 0 ? `fix failed (exit ${fixJob.exit_code}) — click to view log`
              : reviewState === 'done' ? 'no fix needed (LGTM)'
              : 'waiting for review verdict'
            const fixAction = fixJob ? openJob(fixJob) : null

            // DoD step state (PR Workflow only) — uses 'mark-dod' job kind
            const dodState: StepState = stateOf(dodJob)
            const dodHint = dodJob?.status === 'running' ? 'DoD verification in progress — click to open terminal'
              : dodJob?.exit_code === 0 ? 'DoD verified — click to view log'
              : dodJob && dodJob.exit_code !== 0 ? 'DoD verification failed — click to view log'
              : reviewPassed ? 'waiting for push'
              : 'waiting for LGTM review'
            const dodAction = dodJob ? openJob(dodJob) : null

            const hasChanges = project.totalChanges > 0
            const unpushed = (project.unpushed ?? 0) > 0
            const autoPush = !!config?.auto_push_enabled
            // Surface failures via `last_push_error` stored on the project after each push/commit attempt.
            const pushError = config?.last_push_error ?? null
            // Suppress a stale push error when the current pipeline attempt has
            // advanced past it: if any non-push step (test/review/fix) started
            // more recently than the last push job, we're in a new release run
            // that hasn't reached push yet — the old error is irrelevant.
            const pipelineEpoch = Math.max(
              testJob?.started_at ?? 0,
              reviewJob?.started_at ?? 0,
              fixJob?.started_at ?? 0,
            )
            const effectivePushError = pipelineEpoch > priorPushStart ? null : pushError
            const pushErrorIsCommit = !!effectivePushError && effectivePushError.startsWith('Commit failed')

            // Commit step: use actual commit job if available, otherwise derive from project state.
            const commitRunning = commitJob?.status === 'running'
            const commitStateEffective: StepState = commitRunning
              ? 'running'
              : commitJob?.exit_code === 0 ? 'done'
              : commitJob && commitJob.exit_code !== 0 ? 'failed'
              : pushErrorIsCommit ? 'failed'
              : hasChanges ? 'pending' : 'done'

            // Push step: use actual push job if available, otherwise derive from project state.
            const pushRunning = pushJob?.status === 'running'
            const pushStateEffective: StepState = pushRunning
              ? 'running'
              : pushJob?.exit_code === 0 ? 'done'
              : pushJob && pushJob.exit_code !== 0 ? 'failed'
              : effectivePushError && !pushErrorIsCommit ? 'failed'
              : !hasChanges && !unpushed ? 'done' : 'pending'

            const testHint = !hasTestCommand
              ? 'no test command'
              : testState === 'running' ? 'tests running'
              : testState === 'done' && testJob ? `tests passed (${formatAgo(testJob.finished_at ?? testJob.started_at)})`
              : testState === 'failed' ? `tests failed (exit ${testJob?.exit_code})`
              : 'tests not run yet'
            const pushHint = pushStateEffective === 'failed'
              ? (effectivePushError ?? 'push failed')
              : pushStateEffective === 'done'
                ? 'nothing to push'
                : unpushed
                  ? `${project.unpushed} unpushed commit${project.unpushed === 1 ? '' : 's'}${autoPush && reviewPassed ? ' — auto-push pending' : ''}`
                  : `${project.totalChanges} uncommitted change${project.totalChanges === 1 ? '' : 's'} — need review & commit first`
            const commitHint = commitStateEffective === 'failed'
              ? (commitJob ? `commit failed (exit ${commitJob.exit_code}) — click to view log` : (effectivePushError ?? 'commit failed'))
              : commitStateEffective === 'done'
                ? 'nothing to commit'
                : commitStateEffective === 'running'
                  ? 'commit in progress — click to open terminal'
                  : reviewPassed
                    ? `${project.totalChanges} uncommitted change${project.totalChanges === 1 ? '' : 's'} — ${autoPush ? 'auto-commit pending' : 'commit manually'}`
                    : `${project.totalChanges} uncommitted change${project.totalChanges === 1 ? '' : 's'} — need LGTM review to proceed`

            const openCommitJob = commitJob ? () => router.push(`/project/${name}/terminal?job=${encodeURIComponent(commitJob.id)}`) : null
            const openPushJob = pushJob ? () => router.push(`/project/${name}/terminal?job=${encodeURIComponent(pushJob.id)}`) : null
            const handleRetryPush = async () => {
              if (retryingPush) return
              setRetryingPush(true)
              try {
                const result = await pushProject(name)
                if (result.job_id) {
                  router.push(`/project/${name}/terminal?job=${encodeURIComponent(result.job_id)}`)
                } else {
                  toast('Push started', 'success')
                  onRefresh()
                }
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Push failed', 'error')
              } finally {
                setRetryingPush(false)
              }
            }

            const handleAbortPipeline = async () => {
              if (aborting) return
              if (!confirm('Abort the running pipeline? The current step will be killed and no further steps will run.')) return
              setAborting(true)
              try {
                const res = await fetch(`/api/projects/by-project/${encodeURIComponent(name)}/release/abort`, { method: 'POST' })
                const data = await res.json() as { status: string }
                if (data.status === 'aborted') {
                  toast('Pipeline aborted', 'success')
                } else {
                  toast('No active pipeline', 'info')
                }
                onRefresh()
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Abort failed', 'error')
              } finally {
                setAborting(false)
              }
            }

            const steps: Array<{ label: string; state: StepState; hint: string; action?: (() => void) | null; retryAction?: (() => void) | null }> = []
            if (hasTestCommand) steps.push({ label: 'test', state: testState, hint: testHint, action: testJob ? () => router.push(`/project/${name}/terminal?job=${encodeURIComponent(testJob.id)}`) : null })
            steps.push({ label: 'review', state: reviewState, hint: reviewHint, action: reviewFixAction })
            steps.push({ label: 'fix', state: fixState, hint: fixHint, action: fixAction })
            steps.push({ label: 'commit', state: commitStateEffective, hint: commitHint, action: openCommitJob })
            steps.push({ label: 'push', state: pushStateEffective, hint: pushHint, action: openPushJob, retryAction: pushStateEffective === 'failed' && !pushErrorIsCommit ? handleRetryPush : null })
            if (config?.auto_pr_merge_enabled) {
              steps.push({ label: 'dod', state: dodState, hint: dodHint, action: dodAction })
              steps.push({ label: 'merge', state: 'pending', hint: 'auto-merge after CI passes', action: null })
            }

            const runningStepIdx = steps.findIndex(s => s.state === 'running')

            const stepChipClass = (s: StepState, isRunning: boolean) => {
              if (s === 'done') return 'bg-status-success/12 text-status-success border-status-success/25'
              if (s === 'failed') return 'bg-status-error/15 text-status-error border-status-error/40'
              if (s === 'warning') return 'bg-status-warning/15 text-status-warning border-status-warning/40'
              if (s === 'running') return `bg-accent/15 text-accent border-accent/50 ring-2 ring-accent/25 ${isRunning ? 'shadow-sm' : ''}`
              return 'bg-transparent text-text-tertiary border-border/50'
            }

            const stepIcon = (s: StepState) => {
              if (s === 'done') return <span className="text-[10px] leading-none">✓</span>
              if (s === 'failed') return <span className="text-[10px] leading-none">✗</span>
              if (s === 'warning') return <span className="text-[10px] leading-none">!</span>
              if (s === 'running') return <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0" />
              return <span className="text-[10px] leading-none opacity-50">○</span>
            }

            // Connector colour reflects the upstream step's state — done steps
            // build a green progress trail; failed steps a red one.
            const connectorClass = (prev: StepState) => {
              if (prev === 'done') return 'bg-status-success/40'
              if (prev === 'failed') return 'bg-status-error/40'
              if (prev === 'warning') return 'bg-status-warning/40'
              if (prev === 'running') return 'bg-accent/40'
              return 'bg-border/50'
            }

            const doneCount = steps.filter(s => s.state === 'done').length
            const totalSteps = steps.length

            return (
              <div className="mt-3 mb-3 px-3 py-2 rounded-md border border-border bg-bg-secondary flex items-center gap-1 flex-wrap">
                {steps.map((s, i) => {
                  const clickable = !!s.action
                  const dimmed = s.state === 'pending' && runningStepIdx >= 0 && i > runningStepIdx
                  const isCurrent = i === runningStepIdx
                  const chipClass = `inline-flex items-center gap-1.5 px-2 py-1 rounded-md border font-mono text-[11px] font-medium transition-colors ${stepChipClass(s.state, isCurrent)} ${dimmed ? 'opacity-35' : ''} ${isCurrent ? 'font-semibold' : ''}`
                  const chip = (
                    <>
                      {stepIcon(s.state)}
                      <span>{s.label}</span>
                    </>
                  )
                  return (
                    <div key={s.label} className="flex items-center gap-1">
                      {clickable ? (
                        <button
                          type="button"
                          className={`${chipClass} cursor-pointer hover:brightness-110`}
                          onClick={s.action!}
                          title={s.hint}
                        >{chip}</button>
                      ) : (
                        <div className={chipClass} title={s.hint}>{chip}</div>
                      )}
                      {s.retryAction && (
                        <button
                          type="button"
                          className="text-[10px] px-1.5 py-0.5 rounded border border-status-error/40 text-status-error hover:bg-status-error/10 cursor-pointer disabled:opacity-50 font-mono leading-none"
                          onClick={s.retryAction}
                          disabled={retryingPush}
                          title="Retry push"
                        >
                          {retryingPush ? '…' : '↻'}
                        </button>
                      )}
                      {i < steps.length - 1 && (
                        <span className={`h-px w-3 ${connectorClass(s.state)} transition-colors`} aria-hidden />
                      )}
                    </div>
                  )
                })}
                <span className="ml-2 text-[10px] font-mono text-text-tertiary tabular-nums shrink-0" title={`${doneCount} of ${totalSteps} steps complete`}>
                  {doneCount}/{totalSteps}
                </span>
                {activeReleaseJob && (
                  <Link
                    href={`/project/${encodeURIComponent(name)}/release/${encodeURIComponent(activeReleaseJob.id)}`}
                    className="ml-auto text-[10px] text-accent hover:underline font-mono shrink-0"
                    title="View unified release trace"
                  >
                    trace →
                  </Link>
                )}
                <button
                  type="button"
                  className={`text-[10px] font-mono leading-none shrink-0 px-1.5 py-0.5 rounded text-text-tertiary hover:text-status-error hover:bg-status-error/10 cursor-pointer disabled:opacity-50 transition-colors ${activeReleaseJob ? '' : 'ml-auto'}`}
                  onClick={handleAbortPipeline}
                  disabled={aborting}
                  title="Abort the running pipeline"
                >
                  {aborting ? '…' : 'abort'}
                </button>
              </div>
            )
          })()}
          <Suspense fallback={null}>
            <TerminalTab projectName={name} initialSessionId={params.sessionId} />
          </Suspense>
        </>
      )}

    </div>
  )
}

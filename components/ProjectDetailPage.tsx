'use client'

import { useState, useEffect, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { fixCi, releaseProject, fetchJobs, fetchProjectConfig, updateProjectConfig, fetchCustomActions, runCustomAction, saveCustomActions, pullProject, fetchBehind, PullDivergedError, testProject, fetchIssuesAndPRs, pushProject } from '@/lib/client-api'
import type { JobInfo, ProjectConfig, CustomAction } from '@/lib/client-api'
import { FleetHealth } from '@/hooks/useProjectHealth'
import { priorityColor, getHighestPriority, getAggregateCi, formatDuration } from '@/lib/statusConstants'
import { formatAgo } from '@/lib/format'
import { TerminalTab } from '@/components/TerminalTab'
import { AgentsTab } from '@/components/AgentsTab'
import { ProjectRunsTab } from '@/components/ProjectRunsTab'
import { ChangesTab } from '@/components/ChangesTab'
import { IssuesTab } from '@/components/IssuesTab'
import { DocsTab } from '@/components/DocsTab'
import { useToast } from '@/components/Toast'
import { isPipelineBusy } from '@/lib/pipeline-status'

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
      className={`flex-1 min-w-0 text-left border rounded-lg p-3 flex flex-col gap-1 transition-colors ${TONE_RING[tone]} ${
        clickable ? 'bg-bg-secondary hover:bg-bg-tertiary cursor-pointer' : 'bg-bg-secondary cursor-default'
      } ${disabled ? 'opacity-60' : ''}`}
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-semibold">{label}</span>
        <span className={`inline-block w-2 h-2 rounded-full ${TONE_DOT[tone]} ${running ? 'animate-pulse' : ''}`} />
      </div>
      <div className="text-sm font-medium text-text-primary truncate">{primary}</div>
      {detail && <div className="text-xs text-text-tertiary truncate">{detail}</div>}
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

  const colCount = pushCard ? 'grid-cols-2 lg:grid-cols-5' : 'grid-cols-2 lg:grid-cols-4'

  return (
    <div className={`grid ${colCount} gap-2 mb-4`}>
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
  priorities: string[]
  onPriorityChange: (taskId: string, priority: string) => Promise<void>
  onPause: (taskId: string) => Promise<void>
  onResume: (taskId: string) => Promise<void>
  onRefresh: () => Promise<void>
}

export function ProjectDetailPage({
  fleet,
  priorities,
  onPriorityChange,
  onPause,
  onResume,
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
  const [projectJobs, setProjectJobs] = useState<JobInfo[]>([])
  const [issueCount, setIssueCount] = useState<{ prs: number; issues: number } | null>(null)

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
  const [releaseAfterRunInput, setReleaseAfterRunInput] = useState(false)
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

  useEffect(() => {
    if (!name) return
    fetchIssuesAndPRs(name).then((data) => {
      setIssueCount({ prs: data.prs.length, issues: data.issues.length })
    }).catch(() => {})
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
          setReleaseAfterRunInput(!!configData.release_after_run)
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

  const highestPriority = getHighestPriority(project)
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
    const RELEASE_CHILD_KINDS = new Set(['test', 'review', 'fix', 'push', 'fix-push'])
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
      toast(err instanceof Error ? err.message : 'Failed to start release', 'error')
    } finally {
      setReleasing(false)
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
        release_after_run: releaseAfterRunInput,
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
      setReleaseAfterRunInput(!!data.release_after_run)
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
      releaseAfterRunInput !== !!config.release_after_run)

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-text-primary" data-private>{project.project}</h2>
          {releaseTag && <span className="text-text-secondary text-sm" data-private>{releaseTag}</span>}
        </div>
        {highestPriority && (
          <div className="flex items-center gap-3">
            <span style={{ color: priorityColor[highestPriority] }} className="text-sm">
              {highestPriority}
            </span>
          </div>
        )}
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
            return (
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
          {githubUrl && (
            <a
              className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer inline-flex items-center"
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

          <AgentsTab projectName={name} />
        </>
      )}

      {/* Config Tab */}
      {activeTab === 'config' && (
        <div className="mt-4">
          {configLoading ? (
            <div className="flex items-center gap-2 text-text-secondary text-sm py-4">
              <div className="spinner-sm" />
              Loading configuration…
            </div>
          ) : config ? (
            <div className="flex flex-col gap-4 max-w-2xl">

              {/* Testing */}
              <div className="bg-bg-secondary rounded-lg p-5">
                <h3 className="text-sm font-semibold text-text-primary mb-4">Testing</h3>

                <div className="flex flex-col gap-3">
                  <div>
                    <label className="block mb-1.5 text-xs font-medium text-text-secondary uppercase tracking-wider" htmlFor="test-command">
                      Test command
                    </label>
                    <input
                      id="test-command"
                      type="text"
                      className="w-full px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary font-mono"
                      value={testCommandInput}
                      onChange={(e) => setTestCommandInput(e.target.value)}
                      placeholder={config.detected_test_command || 'e.g. npm test, pytest, forge test'}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-tertiary">
                      <span>Auto-detected: <code className="font-mono text-text-secondary">{config.detected_test_command || 'none'}</code></span>
                      <span>Effective: <code className="font-mono text-accent font-medium">{config.effective_test_command || 'none'}</code></span>
                    </div>
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

                <div className="mt-4 flex items-center gap-3">
                  <button
                    className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={handleSaveConfig}
                    disabled={configSaving || !configDirty}
                  >
                    {configSaving ? 'Saving…' : configSaved ? 'Saved' : 'Save'}
                  </button>
                  {configDirty && !configSaving && (
                    <span className="text-xs text-text-tertiary">Unsaved changes</span>
                  )}
                </div>
              </div>

              {/* Release Pipeline */}
              <div className="bg-bg-secondary rounded-lg p-5">
                <h3 className="text-sm font-semibold text-text-primary mb-4">Release Pipeline</h3>

                <div className="space-y-4">
                  <label className="flex items-start gap-2.5 cursor-pointer select-none">
                    <input
                      id="auto-commit-enabled"
                      type="checkbox"
                      className="w-4 h-4 mt-0.5 cursor-pointer accent-accent"
                      checked={autoCommitEnabledInput}
                      onChange={(e) => {
                        const next = e.target.checked
                        setAutoCommitEnabledInput(next)
                        if (!next) setAutoPushEnabledInput(false)
                      }}
                    />
                    <div>
                      <span className="text-sm font-medium text-text-primary">Auto-commit when review passes</span>
                      <p className="mt-0.5 text-xs text-text-tertiary">
                        On <code className="font-mono">LGTM</code> verdict, stage and commit changes automatically — without pushing.
                      </p>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 cursor-pointer select-none">
                    <input
                      id="auto-push-enabled"
                      type="checkbox"
                      className="w-4 h-4 mt-0.5 cursor-pointer accent-accent"
                      checked={autoPushEnabledInput}
                      onChange={(e) => {
                        const next = e.target.checked
                        setAutoPushEnabledInput(next)
                        if (next) setAutoCommitEnabledInput(true)
                      }}
                    />
                    <div>
                      <span className="text-sm font-medium text-text-primary">Auto-push after committing</span>
                      <p className="mt-0.5 text-xs text-text-tertiary">
                        After auto-commit, also push to origin. Implies auto-commit.
                      </p>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 cursor-pointer select-none">
                    <input
                      id="release-after-run"
                      type="checkbox"
                      className="w-4 h-4 mt-0.5 cursor-pointer accent-accent"
                      checked={releaseAfterRunInput}
                      onChange={(e) => setReleaseAfterRunInput(e.target.checked)}
                    />
                    <div>
                      <span className="text-sm font-medium text-text-primary">Run release pipeline after each agent run</span>
                      <p className="mt-0.5 text-xs text-text-tertiary">
                        When a terminal or agent run finishes successfully, automatically trigger the full release pipeline (test → review → commit → push).
                      </p>
                    </div>
                  </label>
                </div>

                <div className="mt-4 flex items-center gap-3">
                  <button
                    className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={handleSaveConfig}
                    disabled={configSaving || !configDirty}
                  >
                    {configSaving ? 'Saving…' : configSaved ? 'Saved' : 'Save'}
                  </button>
                  {configDirty && !configSaving && (
                    <span className="text-xs text-text-tertiary">Unsaved changes</span>
                  )}
                </div>
              </div>

              {/* Custom Actions */}
              <div className="bg-bg-secondary rounded-lg p-5">
                <h3 className="text-sm font-semibold text-text-primary mb-1">Custom Actions</h3>
                <p className="text-xs text-text-tertiary mb-4">
                  Bash commands that appear as buttons on the project page, run in the project directory.
                </p>

                {editActions.length > 0 && (
                  <div className="mb-3">
                    <div className="grid gap-x-2 mb-1.5 px-1" style={{ gridTemplateColumns: '8rem 1fr 2.5rem 2rem' }}>
                      <span className="text-xs font-medium text-text-tertiary uppercase tracking-wider">Label</span>
                      <span className="text-xs font-medium text-text-tertiary uppercase tracking-wider">Command</span>
                      <span className="text-xs font-medium text-text-tertiary uppercase tracking-wider">Color</span>
                      <span />
                    </div>
                    <div className="flex flex-col gap-2">
                      {editActions.map((action, i) => (
                        <div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns: '8rem 1fr 2.5rem 2rem' }}>
                          <input
                            type="text"
                            className="px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary"
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
                            className="px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary font-mono"
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
                            className="w-10 h-9 p-0.5 bg-bg-tertiary border border-border rounded-md cursor-pointer"
                            value={action.color || '#6366f1'}
                            onChange={(e) => {
                              const next = [...editActions]
                              next[i] = { ...next[i], color: e.target.value }
                              setEditActions(next)
                            }}
                            title="Button color"
                          />
                          <button
                            className="flex items-center justify-center h-9 w-8 text-text-tertiary hover:text-status-error hover:bg-status-error/10 rounded-md cursor-pointer transition-colors"
                            onClick={() => setEditActions(editActions.filter((_, j) => j !== i))}
                            title="Remove"
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2 mt-2">
                  <button
                    className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
                    onClick={() => setEditActions([...editActions, { name: '', command: '', color: '#6366f1' }])}
                  >
                    + Add Action
                  </button>
                  <button
                    className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={handleSaveActions}
                    disabled={actionsSaving}
                  >
                    {actionsSaving ? 'Saving…' : actionsSaved ? 'Saved' : 'Save Actions'}
                  </button>
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
        <IssuesTab projectName={name} />
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
            // Show strip only while the release pipeline is actively running,
            // or when a step just failed/needs attention (so the user can see
            // why). At rest, hide it — stale ✓s from a past release are noise.
            const recentCutoff = Date.now() / 1000 - 60 * 60
            const pipelineKinds = ['test', 'review', 'fix', 'push']
            const pipelineRunning = projectJobs.some(
              j => pipelineKinds.includes(j.kind) && j.status === 'running'
            )
            const hasPushError = !!config?.last_push_error
            const recentFailedJob = projectJobs.some(
              j => pipelineKinds.includes(j.kind)
                && j.status === 'done'
                && j.exit_code !== 0
                && j.started_at >= recentCutoff
            )
            // Review done but verdict isn't LGTM — this includes "unknown"
            // (verdict undefined/empty because getVerdict returned null).
            // The user needs to see ✗ with the hint, so the strip must stay
            // visible.
            const recentReviewNotLgtm = projectJobs.some(
              j => j.kind === 'review'
                && j.status === 'done'
                && j.started_at >= recentCutoff
                && j.verdict !== 'LGTM'
            )
            // LGTM verdict but the pipeline hasn't actually finished shipping
            // (changes still uncommitted or commits still unpushed). Keep the
            // strip up so the user can tell the release is mid-flight.
            const recentLgtmWithWorkRemaining = projectJobs.some(
              j => j.kind === 'review'
                && j.status === 'done'
                && j.verdict === 'LGTM'
                && j.started_at >= recentCutoff
            ) && (project.totalChanges > 0 || (project.unpushed ?? 0) > 0)
            if (!pipelineRunning && !hasPushError && !recentFailedJob && !recentReviewNotLgtm && !recentLgtmWithWorkRemaining) return null

            // Look back 24h so Ship-path (skips test+review) still shows the
            // previously-done steps as ✓ instead of blank ○. The prior LGTM
            // is what authorized the ship, so it belongs on the strip.
            const dayAgo = Date.now() / 1000 - 24 * 60 * 60
            const latestOfKind = (kind: string) => projectJobs
              .filter(j => j.kind === kind && j.started_at >= dayAgo)
              .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0]

            const testJob = latestOfKind('test')
            const reviewJob = latestOfKind('review')
            const fixJob = latestOfKind('fix')
            const pushJob = latestOfKind('push')

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
            const hasChanges = project.totalChanges > 0
            const unpushed = (project.unpushed ?? 0) > 0
            const autoPush = !!config?.auto_push_enabled
            // Commit/push run synchronously inside the review completion hook,
            // so there's no distinct job to observe. We surface failures via
            // `last_push_error` stored on the project after each push attempt.
            const pushError = config?.last_push_error ?? null
            const pushErrorIsCommit = !!pushError && pushError.startsWith('Commit failed')
            const commitState: StepState = pushErrorIsCommit
              ? 'failed'
              : hasChanges ? 'pending' : 'done'
            const pushState: StepState = pushError && !pushErrorIsCommit
              ? 'failed'
              : !hasChanges && !unpushed ? 'done' : 'pending'

            const testHint = !hasTestCommand
              ? 'no test command'
              : testState === 'running' ? 'tests running'
              : testState === 'done' && testJob ? `tests passed (${formatAgo(testJob.finished_at ?? testJob.started_at)})`
              : testState === 'failed' ? `tests failed (exit ${testJob?.exit_code})`
              : 'tests not run yet'
            const pushHint = pushState === 'failed'
              ? (pushError ?? 'push failed')
              : pushState === 'done'
                ? 'nothing to push'
                : unpushed
                  ? `${project.unpushed} unpushed commit${project.unpushed === 1 ? '' : 's'}${autoPush && reviewPassed ? ' — auto-push pending' : ''}`
                  : `${project.totalChanges} uncommitted change${project.totalChanges === 1 ? '' : 's'} — need review & commit first`
            const commitHint = commitState === 'failed'
              ? (pushError ?? 'commit failed')
              : commitState === 'done'
                ? 'nothing to commit'
                : reviewPassed
                  ? `${project.totalChanges} uncommitted change${project.totalChanges === 1 ? '' : 's'} — ${autoPush ? 'auto-commit pending' : 'commit manually'}`
                  : `${project.totalChanges} uncommitted change${project.totalChanges === 1 ? '' : 's'} — need LGTM review to proceed`

            const openPushJob = pushJob ? () => router.push(`/project/${name}/terminal?job=${encodeURIComponent(pushJob.id)}`) : null
            // If a push job is running, show commit/push as running and let
            // clicking either step open its log — it's a single tracked job
            // that does both git commit and git push.
            const pushRunning = pushJob?.status === 'running'
            const commitStateEffective: StepState = pushRunning ? 'running' : commitState
            const pushStateEffective: StepState = pushRunning ? 'running' : pushState
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

            const steps: Array<{ label: string; state: StepState; hint: string; action?: (() => void) | null; retryAction?: (() => void) | null }> = []
            if (hasTestCommand) steps.push({ label: 'test', state: testState, hint: testHint, action: testJob ? () => router.push(`/project/${name}/terminal?job=${encodeURIComponent(testJob.id)}`) : null })
            steps.push({ label: 'review', state: reviewState, hint: reviewHint, action: reviewFixAction })
            steps.push({ label: 'commit', state: commitStateEffective, hint: commitHint, action: openPushJob })
            steps.push({ label: 'push', state: pushStateEffective, hint: pushHint, action: openPushJob, retryAction: pushStateEffective === 'failed' && !pushErrorIsCommit ? handleRetryPush : null })

            const glyph = (s: StepState) => {
              if (s === 'done') return <span className="text-status-success">✓</span>
              if (s === 'failed') return <span className="text-status-error">✗</span>
              if (s === 'warning') return <span className="text-status-warning">!</span>
              if (s === 'running') return <span className="inline-block w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin align-middle" />
              return <span className="text-text-tertiary">○</span>
            }

            return (
              <div className="mt-3 mb-3 px-3 py-2 rounded-md border border-border bg-bg-secondary text-sm flex items-center gap-2 flex-wrap">
                {steps.map((s, i) => {
                  const clickable = !!s.action
                  const inner = (
                    <>
                      <span className="inline-flex items-center justify-center w-5 h-5">{glyph(s.state)}</span>
                      <span className={`font-mono text-xs ${s.state === 'running' ? 'text-accent font-semibold' : s.state === 'done' ? 'text-text-primary' : s.state === 'failed' ? 'text-status-error' : s.state === 'warning' ? 'text-status-warning' : 'text-text-secondary'}`}>
                        {s.label}
                      </span>
                    </>
                  )
                  return (
                    <div key={s.label} className="flex items-center gap-1.5">
                      {clickable ? (
                        <button
                          type="button"
                          className="flex items-center gap-1.5 hover:bg-bg-tertiary rounded px-1 py-0.5 -mx-1 -my-0.5 cursor-pointer"
                          onClick={s.action!}
                          title={s.hint}
                        >{inner}</button>
                      ) : (
                        <div className="flex items-center gap-1.5" title={s.hint}>{inner}</div>
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
                      {i < steps.length - 1 && <span className="text-text-tertiary mx-1">→</span>}
                    </div>
                  )
                })}
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

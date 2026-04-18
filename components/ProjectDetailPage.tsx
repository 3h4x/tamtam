'use client'

import { useState, useEffect, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { reviewProject, testProject, fixCi, fetchJobs, fetchProjectConfig, updateProjectConfig, fetchCustomActions, runCustomAction, saveCustomActions } from '@/lib/client-api'
import type { JobInfo, ProjectConfig, CustomAction } from '@/lib/client-api'
import { FleetHealth } from '@/hooks/useProjectHealth'
import { statusDot, priorityColor, getHighestPriority, getAggregateCi, formatDuration } from '@/lib/statusConstants'
import { formatAgo } from '@/lib/format'
import { SmartPushModal } from '@/components/SmartPushModal'
import { RunModal } from '@/components/RunModal'
import { TerminalTab } from '@/components/TerminalTab'
import { AgentsTab } from '@/components/AgentsTab'
import { ProjectRunsTab } from '@/components/ProjectRunsTab'
import { ChangesTab } from '@/components/ChangesTab'
import { useToast } from '@/components/Toast'

type Tab = 'overview' | 'config' | 'history' | 'terminal' | 'changes'

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
  } else if (verdict && latestReview) {
    const tone: StatusCardProps['tone'] =
      verdict === 'LGTM' ? 'success' : verdict === 'NEEDS ATTENTION' ? 'warning' : 'error'
    reviewCard = (
      <StatusCard
        label="Review"
        primary={verdict}
        detail={`${formatAgo(latestReview.finished_at ?? latestReview.started_at)} — view log`}
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

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-4">
      {changesCard}
      {reviewCard}
      {testsCard}
      {ciCard}
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
  onPush?: () => void
}

export function ProjectDetailPage({
  fleet,
  priorities,
  onPriorityChange,
  onPause,
  onResume,
  onRefresh,
  onPush,
}: ProjectDetailPageProps) {
  const params = useParams<{ name: string; tab?: string; sessionId?: string }>()
  const name = params.name
  const router = useRouter()
  const { toast } = useToast()
  const VALID_TABS: Tab[] = ['overview', 'config', 'history', 'terminal', 'changes']
  const activeTab: Tab = params.sessionId
    ? 'terminal'
    : VALID_TABS.includes(params.tab as Tab) ? (params.tab as Tab) : 'overview'
  const setActiveTab = (tab: Tab) => {
    router.push(tab === 'overview' ? `/project/${name}` : `/project/${name}/${tab}`)
  }
  const [fixingCi, setFixingCi] = useState(false)
  const [fixCiResult, setFixCiResult] = useState<string | null>(null)
  const [projectJobs, setProjectJobs] = useState<JobInfo[]>([])
  const [showPushModal, setShowPushModal] = useState(false)
  const [showRunModal, setShowRunModal] = useState(false)

  // Custom actions
  const [customActions, setCustomActions] = useState<CustomAction[]>([])
  const [runningActions, setRunningActions] = useState<Set<string>>(new Set())

  // Config state
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [testCommandInput, setTestCommandInput] = useState('')
  const [testCronEnabledInput, setTestCronEnabledInput] = useState(false)
  const [testCronScheduleInput, setTestCronScheduleInput] = useState('')
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
    if ((activeTab !== 'config' && activeTab !== 'overview') || !name) return
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

  const dot = statusDot[project.status]
  const highestPriority = getHighestPriority(project)
  const aggregateCi = getAggregateCi(project)

  const ciFailedUrl = project.tasks.find(t => t.task.ci_failed_url)?.task.ci_failed_url || null
  const releaseTag = project.tasks.find(t => t.task.release_tag)?.task.release_tag || null
  const githubUrl = project.tasks.find(t => t.task.github)?.task.github || null
  const hasUnreviewed = project.unreviewedCount > 0
  const isReviewRunning = projectJobs.some(j => j.kind === 'review' && j.status === 'running')
  const isCiFixRunning = projectJobs.some(j => j.kind === 'fix-ci' && j.status === 'running')
  const isTestRunning = projectJobs.some(j => j.kind === 'test' && j.status === 'running')

  // Get latest review verdict
  const latestReview = projectJobs
    .filter(j => j.kind === 'review' && j.status === 'done' && j.verdict)
    .sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))[0]
  const verdict = latestReview?.verdict

  // Get latest test result
  const latestTest = projectJobs
    .filter(j => j.kind === 'test' && j.status === 'done')
    .sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))[0]

  const runningJobs = projectJobs
    .filter(j => j.status === 'running')
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))

  const [reviewError, setReviewError] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  const handleReview = async () => {
    if (!name) return
    setReviewError(null)
    try {
      const result = await reviewProject(name)
      router.push(`/project/${name}/terminal?job=${encodeURIComponent(result.job_id)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start review'
      toast(msg, 'error')
      setReviewError(msg)
    }
  }

  const handleTest = async () => {
    if (!name) return
    setTestError(null)
    try {
      const result = await testProject(name)
      router.push(`/project/${name}/terminal?job=${encodeURIComponent(result.job_id)}`)
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Failed to start tests')
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
      })
      setConfigSaved(true)
      // Reload config to show effective command
      const data = await fetchProjectConfig(name)
      setConfig(data)
      setTestCommandInput(data.test_command)
      setTestCronEnabledInput(data.test_cron_enabled)
      setTestCronScheduleInput(data.test_cron_schedule)
      setTimeout(() => setConfigSaved(false), 3000)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save config', 'error')
    } finally {
      setConfigSaving(false)
    }
  }

  const showToast = (message: string, type: 'success' | 'error') => {
    const toast = document.createElement('div')
    toast.textContent = message
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 6px;
      font-size: 14px;
      background: ${type === 'success' ? '#22c55e' : '#ef4444'};
      color: white;
      z-index: 1000;
      animation: slideInUp 0.3s ease-out;
    `
    document.body.appendChild(toast)
    setTimeout(() => {
      toast.style.animation = 'slideOutDown 0.3s ease-out'
      setTimeout(() => toast.remove(), 300)
    }, 3000)
  }

  const configDirty =
    config !== null &&
    (testCommandInput !== config.test_command ||
      testCronEnabledInput !== config.test_cron_enabled ||
      testCronScheduleInput !== config.test_cron_schedule)

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-text-primary">{project.project}</h2>
          {releaseTag && <span className="text-text-secondary text-sm">{releaseTag}</span>}
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-block w-2 h-2 rounded-full" title={dot.label} style={{ background: dot.color }} />
          {highestPriority && (
            <span style={{ color: priorityColor[highestPriority] }} className="text-sm">
              {highestPriority}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {aggregateCi === 'failure' && ciFailedUrl && (
            <button
              className="px-3 py-1.5 text-sm border border-status-error text-status-error rounded-md hover:bg-status-error/10 disabled:opacity-50 disabled:cursor-not-allowed"
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
          <button
            className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleReview}
            disabled={isReviewRunning || project.totalChanges === 0}
            title={isReviewRunning ? 'Review already in progress' : project.totalChanges === 0 ? 'No changes to review' : 'Start review'}
          >
            {isReviewRunning ? 'Reviewing...' : 'Review'}
          </button>
          <button
            className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleTest}
            disabled={isTestRunning}
            title={isTestRunning ? 'Tests already running' : 'Run test suite'}
          >
            {isTestRunning ? 'Testing...' : 'Run Tests'}
          </button>
          {reviewError && (
            <span className="text-status-error text-xs">
              {reviewError}
            </span>
          )}
          {testError && (
            <span className="text-status-error text-xs">
              {testError}
            </span>
          )}
          <button
            className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => setShowPushModal(true)}
            disabled={project.totalChanges === 0}
            title={project.totalChanges === 0 ? 'No changes to push' : 'Push changes to git'}
          >
            Push
          </button>
          <button
            className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
            onClick={() => setShowRunModal(true)}
            title="Run a custom Claude prompt"
          >
            Run
          </button>
          {customActions.map((action) => (
            <button
              key={action.name}
              className="px-3 py-1.5 text-sm border rounded-md cursor-pointer font-medium"
              style={{
                borderColor: action.color || 'var(--color-accent)',
                color: action.color || 'var(--color-accent)',
              }}
              onMouseEnter={(e) => {
                const c = action.color || 'var(--color-accent)'
                ;(e.currentTarget as HTMLElement).style.backgroundColor = `${action.color ? action.color + '1a' : 'var(--color-accent-light)'}`
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
              }}
              onClick={() => handleCustomAction(action.name)}
              disabled={runningActions.has(action.name)}
              title={`Run: ${action.command}`}
            >
              {runningActions.has(action.name) ? `${action.name}...` : action.name}
            </button>
          ))}
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
            <div className="flex flex-col gap-6">
              <div className="bg-bg-secondary rounded-lg p-4">
                <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-2">Test Command</h3>
                <p className="text-text-secondary text-sm mb-4">
                  Configure the command used when running tests for this project.
                  Leave empty to use auto-detection.
                </p>

                <div className="mb-4">
                  <label className="block mb-1 font-medium text-sm text-text-primary" htmlFor="test-command">
                    Custom test command
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="test-command"
                      type="text"
                      className="flex-1 px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary font-mono"
                      value={testCommandInput}
                      onChange={(e) => setTestCommandInput(e.target.value)}
                      placeholder={config.detected_test_command || 'e.g. npm test, pytest, forge test'}
                    />
                    <button
                      className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover"
                      onClick={handleSaveConfig}
                      disabled={configSaving || !configDirty}
                    >
                      {configSaving ? 'Saving...' : configSaved ? 'Saved' : 'Save'}
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-1 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-text-secondary">Auto-detected:</span>
                    <code className="font-mono text-xs bg-bg-tertiary px-1.5 py-0.5 rounded text-text-primary">
                      {config.detected_test_command || 'none'}
                    </code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-text-secondary">Effective command:</span>
                    <code className="font-mono text-xs bg-accent-light px-1.5 py-0.5 rounded text-accent font-semibold">
                      {config.effective_test_command || 'none'}
                    </code>
                  </div>
                </div>

                <div className="mt-5 pt-4 border-t border-border">
                  <div className="flex items-center gap-2 mb-2">
                    <input
                      id="test-cron-enabled"
                      type="checkbox"
                      className="w-4 h-4 cursor-pointer accent-accent"
                      checked={testCronEnabledInput}
                      onChange={(e) => setTestCronEnabledInput(e.target.checked)}
                    />
                    <label htmlFor="test-cron-enabled" className="font-medium text-sm text-text-primary cursor-pointer">
                      Run tests on schedule
                    </label>
                  </div>
                  <p className="text-text-secondary text-xs mb-3">
                    When enabled, the effective test command runs on the schedule below. Examples: <code className="font-mono">30m</code>, <code className="font-mono">1h</code>, <code className="font-mono">6h</code>, <code className="font-mono">1d</code>, or a raw cron expression.
                  </p>
                  <input
                    type="text"
                    className="w-48 px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary font-mono disabled:opacity-50"
                    value={testCronScheduleInput}
                    onChange={(e) => setTestCronScheduleInput(e.target.value)}
                    placeholder="1h"
                    disabled={!testCronEnabledInput}
                  />
                </div>
              </div>

              {/* Custom Actions */}
              <div className="bg-bg-secondary rounded-lg p-4">
                <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-2">Custom Actions</h3>
                <p className="text-text-secondary text-sm mb-4">
                  Define bash commands that appear as buttons on the project page. Each action runs in the project directory.
                </p>

                <div className="flex flex-col gap-3 mb-4">
                  {editActions.map((action, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="text"
                        className="w-32 px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary"
                        value={action.name}
                        onChange={(e) => {
                          const next = [...editActions]
                          next[i] = { ...next[i], name: e.target.value }
                          setEditActions(next)
                        }}
                        placeholder="Name"
                      />
                      <input
                        type="text"
                        className="flex-1 px-3 py-2 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary font-mono"
                        value={action.command}
                        onChange={(e) => {
                          const next = [...editActions]
                          next[i] = { ...next[i], command: e.target.value }
                          setEditActions(next)
                        }}
                        placeholder="bash command"
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
                        className="px-2 py-2 text-sm text-status-error hover:bg-status-error/10 rounded-md cursor-pointer"
                        onClick={() => setEditActions(editActions.filter((_, j) => j !== i))}
                        title="Remove action"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
                    onClick={() => setEditActions([...editActions, { name: '', command: '', color: '#6366f1' }])}
                  >
                    + Add Action
                  </button>
                  <button
                    className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover"
                    onClick={handleSaveActions}
                    disabled={actionsSaving}
                  >
                    {actionsSaving ? 'Saving...' : actionsSaved ? 'Saved' : 'Save Actions'}
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

      {/* Runs Tab */}
      {activeTab === 'history' && name && (
        <ProjectRunsTab projectName={name} />
      )}

      {/* Terminal Tab */}
      {activeTab === 'terminal' && name && (
        <Suspense fallback={null}>
          <TerminalTab projectName={name} initialSessionId={params.sessionId} />
        </Suspense>
      )}

      {showPushModal && name && (
        <SmartPushModal
          projectName={name}
          onClose={() => setShowPushModal(false)}
          onSuccess={() => {
            setShowPushModal(false)
            showToast('Changes pushed successfully', 'success')
            if (onPush) onPush()
            onRefresh()
          }}
        />
      )}

      {showRunModal && name && (
        <RunModal
          projectName={name}
          onClose={() => setShowRunModal(false)}
        />
      )}
    </div>
  )
}

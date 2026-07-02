'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { fixCi, releaseProject, fetchJobs, fetchProjectConfig, updateProjectConfig, fetchCustomActions, runCustomAction, saveCustomActions, pullProject, fetchBehind, PullDivergedError, testProject, fetchIssuesAndPRs, fetchIssuesSummary, pushProject, fetchBranch, createProjectPR, CreatePRPrePushHookError, fetchSettings } from '@/lib/client-api'
import type { JobInfo, ProjectConfig, CustomAction } from '@/lib/client-api'
import { FleetHealth } from '@/hooks/useProjectHealth'
import { getAggregateCi } from '@/lib/shared/statusConstants'
import { TerminalTab } from '@/components/TerminalTab'
import { ProjectRunsTab } from '@/components/ProjectRunsTab'
import { ChangesTab } from '@/components/ChangesTab'
import { IssuesTab } from '@/components/IssuesTab'
import { DocsTab } from '@/components/DocsTab'
import { useToast } from '@/components/Toast'
import { isPipelineBusy } from '@/lib/pipeline/pipeline-status'
import { subscribeToJobsPausedChanged } from '@/lib/shared/jobs-paused-events'
import { ConfigTab } from '@/components/project-detail/ConfigTab'
import { RetrievalReindexPanel } from '@/components/project-detail/RetrievalReindexPanel'
import { PipelineStrip } from '@/components/project-detail/PipelineStrip'
import { ProjectActions } from '@/components/project-detail/ProjectActions'
import { ReleasePlanPanel } from '@/components/project-detail/ReleasePlanPanel'
import { TabNav } from '@/components/project-detail/TabNav'
import { ProjectPageLoadingState } from '@/components/project-detail/ProjectPageLoadingState'
import { OverviewTab } from '@/components/project-detail/OverviewTab'
import { AgentsTab } from '@/components/AgentsTab'
import { buildProjectPath, buildProjectSetupPath, buildProjectTerminalPath } from '@/lib/client/project-routes'
import { resolveGithubBoardUrl } from '@/lib/client/resolve-github-board-url'
import { ProjectLogo } from '@/components/ProjectLogo'
import { Button, buttonVariants } from '@/components/ui/Button'
import { Pill, PillButton } from '@/components/ui/Pill'

type Tab = 'overview' | 'config' | 'history' | 'terminal' | 'changes' | 'issues' | 'docs' | 'agents'
const VALID_TABS: readonly Tab[] = ['overview', 'config', 'history', 'terminal', 'changes', 'issues', 'docs', 'agents']
const RELEASE_CHILD_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'mark-dod', 'pr-wait', 'soak'])

type Verdict = 'LGTM' | 'NEEDS ATTENTION' | 'DO NOT SHIP'
interface ProjectDetailPageProps {
  fleet: FleetHealth
  onRefresh: () => Promise<void>
}

function latestFinishedJob(
  jobs: JobInfo[],
  matches: (job: JobInfo) => boolean,
): JobInfo | undefined {
  let latest: JobInfo | undefined
  for (const job of jobs) {
    if (!matches(job)) continue
    if (!latest || (job.finished_at || 0) > (latest.finished_at || 0)) {
      latest = job
    }
  }
  return latest
}

// Per-project UI cache for state that drives always-visible header controls
// (custom-action buttons, Test/Release buttons). Changing tab does a
// `router.push` to a sibling `[tab]` segment, which REMOUNTS this page (there is
// no shared `[name]/layout.tsx`), resetting all useState. Without this cache the
// buttons flashed empty (customActions=[], config=null) on every tab switch
// until their fetches re-resolved. Seeding the initial state from the last known
// values keeps the buttons stable across remounts; the background re-fetch still
// refreshes them. Module-level (one browser realm) is enough — no need to pin to
// globalThis.
const projectUiCache = new Map<string, { actions?: CustomAction[]; config?: ProjectConfig }>()
function readUiCache(project: string): { actions?: CustomAction[]; config?: ProjectConfig } {
  return projectUiCache.get(project) ?? {}
}
function writeUiCache(project: string, patch: { actions?: CustomAction[]; config?: ProjectConfig }): void {
  projectUiCache.set(project, { ...readUiCache(project), ...patch })
}

export function ProjectDetailPage({
  fleet,
  onRefresh,
}: ProjectDetailPageProps) {
  const params = useParams<{ name: string; tab?: string; sessionId?: string }>()
  const name = params.name
  const router = useRouter()
  const { toast } = useToast()
  const activeTab: Tab = params.sessionId
    ? 'terminal'
    : VALID_TABS.includes(params.tab as Tab) ? (params.tab as Tab) : 'overview'
  const project = fleet.projects.find(p => p.project === name)
  const projectId = project?.project
  const setActiveTab = (tab: Tab) => {
    router.push(tab === 'overview' ? buildProjectPath(name) : buildProjectPath(name, tab))
  }
  const [fixingCi, setFixingCi] = useState(false)
  const [fixCiResult, setFixCiResult] = useState<string | null>(null)
  const [projectJobs, setProjectJobs] = useState<JobInfo[]>([])
  const [jobsLoaded, setJobsLoaded] = useState(false)
  const [issueCount, setIssueCount] = useState<{ prs: number; issues: number } | null>(null)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null)
  const [branchCommitsAhead, setBranchCommitsAhead] = useState<number | null>(null)
  const [openPrBranches, setOpenPrBranches] = useState<string[]>([])
  const [openPrByBranch, setOpenPrByBranch] = useState<Record<string, number>>({})
  const [creatingPr, setCreatingPr] = useState(false)
  const [pushingToPr, setPushingToPr] = useState(false)
  const [boardUrl, setBoardUrl] = useState<string>('')
  const [jobsPaused, setJobsPaused] = useState(false)
  const jobsPausedEventSeqRef = useRef(0)

  // Custom actions
  const [customActions, setCustomActions] = useState<CustomAction[]>(() => readUiCache(name).actions ?? [])
  const [runningActions, setRunningActions] = useState<Set<string>>(new Set())

  // Config state
  const [config, setConfig] = useState<ProjectConfig | null>(() => readUiCache(name).config ?? null)
  const [configLoading, setConfigLoading] = useState(false)
  const [configReloadNonce, setConfigReloadNonce] = useState(0)
  const [testCommandInput, setTestCommandInput] = useState('')
  const [releaseTimeoutMinutesInput, setReleaseTimeoutMinutesInput] = useState('')
  const [testCronEnabledInput, setTestCronEnabledInput] = useState(false)
  const [testCronScheduleInput, setTestCronScheduleInput] = useState('')
  const [autoCommitEnabledInput, setAutoCommitEnabledInput] = useState(false)
  const [autoPushEnabledInput, setAutoPushEnabledInput] = useState(false)
  const [autoPrMergeEnabledInput, setAutoPrMergeEnabledInput] = useState(false)
  const [postMergeWatchMinutesInput, setPostMergeWatchMinutesInput] = useState('')
  const [autoRevertEnabledInput, setAutoRevertEnabledInput] = useState(false)
  const [releaseAfterRunInput, setReleaseAfterRunInput] = useState(false)
  const [issueAutoBranchInput, setIssueAutoBranchInput] = useState(true)
  const [testsDisabledInput, setTestsDisabledInput] = useState(false)
  const [reviewDisabledInput, setReviewDisabledInput] = useState(false)
  const [reviewPromptAddendumInput, setReviewPromptAddendumInput] = useState('')
  const [reviewPrerequisiteCommandInput, setReviewPrerequisiteCommandInput] = useState('')
  const [fixPromptAddendumInput, setFixPromptAddendumInput] = useState('')
  const [commitStyleInput, setCommitStyleInput] = useState('')
  const [websiteInput, setWebsiteInput] = useState('')
  const [qaUrlInput, setQaUrlInput] = useState('')
  const [devServerStartCommandInput, setDevServerStartCommandInput] = useState('')
  const [devServerStopCommandInput, setDevServerStopCommandInput] = useState('')
  const [devServerReadyUrlInput, setDevServerReadyUrlInput] = useState('')
  const [dailySpendCapUsdInput, setDailySpendCapUsdInput] = useState('')
  const [releaseSpendCapUsdInput, setReleaseSpendCapUsdInput] = useState('')
  const [configSaving, setConfigSaving] = useState(false)
  const [configSaved, setConfigSaved] = useState(false)

  // Custom actions editor state
  const [editActions, setEditActions] = useState<CustomAction[]>([])
  const [actionsSaving, setActionsSaving] = useState(false)
  const [actionsSaved, setActionsSaved] = useState(false)
  const [actionsLoaded, setActionsLoaded] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [pullResult, setPullResult] = useState<string | null>(null)
  const [pullDiverged, setPullDiverged] = useState(false)
  const [behindCount, setBehindCount] = useState(0)

  useEffect(() => {
    if (!name || !projectId) return
    let active = true
    setProjectJobs([])
    setJobsLoaded(false)
    const poll = async () => {
      try {
        const data = await fetchJobs(name)
        if (active) {
          setProjectJobs(data.jobs)
          setJobsLoaded(true)
        }
      } catch { if (active) setJobsLoaded(true) }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [name, projectId])

  // Load custom actions
  useEffect(() => {
    if (!name || !projectId) return
    fetchCustomActions(name).then((data) => { setCustomActions(data.actions); writeUiCache(name, { actions: data.actions }) }).catch(() => {})
  }, [name, projectId])

  // Load board URL for the optional "Board ↗" header chip
  useEffect(() => {
    let cancelled = false
    const unsubscribe = subscribeToJobsPausedChanged((paused) => {
      jobsPausedEventSeqRef.current += 1
      setJobsPaused(paused)
    })
    const loadSettings = () => {
      const fetchSeq = jobsPausedEventSeqRef.current
      fetchSettings()
        .then((data) => {
          if (cancelled) return
          const s = data?.settings ?? data
          if (jobsPausedEventSeqRef.current === fetchSeq) {
            setJobsPaused(s?.jobs_paused === 'true')
          }
          setBoardUrl(resolveGithubBoardUrl(s))
        })
        .catch(() => undefined)
    }
    loadSettings()
    const interval = setInterval(loadSettings, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
      unsubscribe()
    }
  }, [])

  // Poll issues/PRs + current/default branch together.
  // The parent page only needs counts + the open-PR branch map to render the
  // header badges and gate the Push-to-PR / Create PR buttons — it never
  // renders the full PR/issue lists itself. Use the summary endpoint and a
  // 30 s cadence (issue counts don't change faster than that, and the
  // server-side cache TTL is 5 min anyway). The Issues tab does its own
  // full-list fetch when the user opens it.
  useEffect(() => {
    if (!name || !projectId) return
    let active = true
    const poll = async () => {
      const [issuesRes, branchRes] = await Promise.allSettled([
        fetchIssuesSummary(name),
        fetchBranch(name),
      ])
      if (!active) return
      if (issuesRes.status === 'fulfilled') {
        setIssueCount({ prs: issuesRes.value.prCount, issues: issuesRes.value.issueCount })
        setOpenPrBranches(issuesRes.value.openPrBranches.map(b => b.branch))
        setOpenPrByBranch(Object.fromEntries(issuesRes.value.openPrBranches.map(b => [b.branch, b.number])))
      }
      if (branchRes.status === 'fulfilled') {
        setCurrentBranch(branchRes.value.branch)
        setDefaultBranch(branchRes.value.defaultBranch)
        setBranchCommitsAhead(branchRes.value.commitsAhead)
      }
    }
    poll()
    const interval = setInterval(poll, 30000)
    return () => { active = false; clearInterval(interval) }
  }, [name, projectId])

  const applyConfigData = (data: ProjectConfig) => {
    setConfig(data)
    writeUiCache(name, { config: data })
    setTestCommandInput(data.test_command)
    setReleaseTimeoutMinutesInput(data.release_timeout_minutes != null ? String(data.release_timeout_minutes) : '')
    setTestCronEnabledInput(data.test_cron_enabled)
    setTestCronScheduleInput(data.test_cron_schedule)
    setAutoCommitEnabledInput(!!data.auto_commit_enabled)
    setAutoPushEnabledInput(!!data.auto_push_enabled)
    setAutoPrMergeEnabledInput(!!data.auto_pr_merge_enabled)
    setPostMergeWatchMinutesInput(
      data.post_merge_watch_minutes != null ? String(data.post_merge_watch_minutes) : '0',
    )
    setAutoRevertEnabledInput(!!data.auto_revert_enabled)
    setReleaseAfterRunInput(!!data.release_after_run)
    setIssueAutoBranchInput(data.issue_auto_branch ?? true)
    setTestsDisabledInput(!!data.tests_disabled)
    setReviewDisabledInput(!!data.review_disabled)
    setReviewPromptAddendumInput(data.review_prompt_addendum ?? '')
    setReviewPrerequisiteCommandInput(data.review_prerequisite_command ?? '')
    setFixPromptAddendumInput(data.fix_prompt_addendum ?? '')
    setCommitStyleInput(data.commit_style ?? '')
    setWebsiteInput(data.website ?? '')
    setQaUrlInput(data.qa_url ?? '')
    setDevServerStartCommandInput(data.dev_server_start_command ?? '')
    setDevServerStopCommandInput(data.dev_server_stop_command ?? '')
    setDevServerReadyUrlInput(data.dev_server_ready_url ?? '')
    setDailySpendCapUsdInput(data.daily_spend_cap_usd != null ? String(data.daily_spend_cap_usd) : '')
    setReleaseSpendCapUsdInput(data.release_spend_cap_usd != null ? String(data.release_spend_cap_usd) : '')
  }

  const handleCustomAction = async (actionName: string) => {
    if (!name || runningActions.has(actionName)) return
    if (jobsPaused) {
      toast('Jobs are paused globally. Resume jobs to run this custom action.', 'info')
      return
    }
    setRunningActions((prev) => new Set(prev).add(actionName))
    try {
      const result = await runCustomAction(name, actionName)
      toast(`${actionName} started for ${name}`, 'success')
      router.push(buildProjectTerminalPath(name, { jobId: result.job_id }))
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

  // Load config on every tab — the header pill ("Auto release") and the
  // action menu (Test / Website buttons) both depend on it, so tying the fetch
  // to a tab-allowlist made the header silently change shape when switching
  // tabs. Project config is small enough to fetch once per project mount.
  useEffect(() => {
    if (!name || !projectId) return
    let active = true
    setConfigLoading(true)
    Promise.all([
      fetchProjectConfig(name),
      !actionsLoaded ? fetchCustomActions(name) : null,
    ])
      .then(([configData, actionsData]) => {
        if (active) {
          applyConfigData(configData)
          if (actionsData) {
            setEditActions(actionsData.actions)
            setActionsLoaded(true)
          }
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => { if (active) setConfigLoading(false) })
    return () => { active = false }
  }, [name, projectId, configReloadNonce])

  useEffect(() => {
    if (!name || activeTab !== 'overview' || configLoading || !config || config.setup_complete !== false) return
    router.replace(buildProjectSetupPath(name))
  }, [activeTab, config, configLoading, name, router])

  useEffect(() => {
    if (!name || !projectId) return
    let active = true
    const refresh = () => {
      fetchBehind(name).then((r) => { if (active) setBehindCount(r.behind) }).catch(() => {})
    }
    refresh()
    const interval = setInterval(refresh, 60000)
    return () => { active = false; clearInterval(interval) }
  }, [name, projectId])

  if (!project) {
    // An empty fleet means the projects list hasn't loaded yet — the cold
    // `/api/projects` sweep does git ops across every tracked repo and can take
    // many seconds under host/git contention (e.g. right after a restart, while
    // agents hammer the same repos). Rendering "not found" during that window is
    // wrong and alarming. Only treat the project as genuinely absent once OTHER
    // projects have loaded; until then show the same loading state as the shell.
    if (fleet.projects.length === 0) {
      return <ProjectPageLoadingState />
    }
    return (
      <div className="py-2">
        <Button
          variant="link"
          className="mb-4 font-normal"
          onClick={() => router.push('/')}
        >
          &larr; Back to projects
        </Button>
        <p className="text-text-secondary text-sm">
          Project &quot;{name}&quot; not found.
        </p>
      </div>
    )
  }

  const aggregateCi = getAggregateCi(project)

  const ciFailedUrl = project.tasks.find(t => t.task.ci_failed_url)?.task.ci_failed_url || null
  const releaseTag = project.tasks.find(t => t.task.release_tag)?.task.release_tag || null
  const githubUrl = project.tasks.find(t => t.task.github)?.task.github || null
  const hasUnreviewed = project.unreviewedCount > 0
  const runningReview = projectJobs.find(j => j.kind === 'review' && j.status === 'running')
  const isReviewRunning = !!runningReview
  const isCiFixRunning = projectJobs.some(j => j.kind === 'fix-ci' && j.status === 'running')
  const runningTest = projectJobs.find(j => j.kind === 'test' && j.status === 'running')
  const isTestRunning = !!runningTest
  const isPipelineRunning = isPipelineBusy(projectJobs)

  // Get latest review verdict
  const latestReview = latestFinishedJob(projectJobs, j => j.kind === 'review' && j.status === 'done' && !!j.verdict)
  const verdict = latestReview?.verdict as Verdict | undefined

  // Get latest test result
  const latestTest = latestFinishedJob(projectJobs, j => j.kind === 'test' && j.status === 'done')

  const running = projectJobs.filter(j => j.status === 'running')
  const releaseRunning = running.some(j => j.kind === 'release')
  const runningJobs = (releaseRunning ? running.filter(j => !RELEASE_CHILD_KINDS.has(j.kind)) : running)
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))
  // Parent-job lookup for the active-work tile so a running release whose
  // parent agent triggered it renders as the AGENT's card (its prompt as the
  // title) rather than the generic "Release pipeline" wrapper — keeping the
  // workflow visually unified instead of splitting "agent run" from
  // "release pipeline meta-step".
  const runningParentLookup = new Map<string, JobInfo>()
  for (const j of runningJobs) {
    if (j.kind !== 'release' || !j.parent_job_id) continue
    const parent = projectJobs.find(p => p.id === j.parent_job_id)
    if (parent) runningParentLookup.set(j.id, parent)
  }

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
      router.push(buildProjectTerminalPath(name, { jobId: result.job_id }))
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
      router.push(buildProjectTerminalPath(name, { jobId: result.job_id }))
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
      const jobIdToOpen = result.release_job_id ?? result.job_id
      if (jobIdToOpen) {
        router.push(buildProjectTerminalPath(name, { jobId: jobIdToOpen }))
      }
    } catch (err) {
      const error = err as Error & { isPipelineLocked?: boolean; blockingJobId?: string }
      if (error.isPipelineLocked) {
        const msg = error.blockingJobId
          ? `Pipeline is running (job ${error.blockingJobId}). Click the job to watch its progress.`
          : (error.message || 'Pipeline is already running. Wait for it to complete before starting another release.')
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
      router.push(buildProjectTerminalPath(name, { jobId: result.job_id }))
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to push to PR', 'error')
    } finally {
      setPushingToPr(false)
    }
  }

  const runCreatePr = async (opts: { force?: boolean } = {}) => {
    const result = await createProjectPR(name!, opts)
    toast(result.url ? `Pull request created: ${result.url}` : 'Pull request created', 'success')
    fetchIssuesAndPRs(name!, true).then((data) => {
      setIssueCount({ prs: data.prs.length, issues: data.issues.length })
      setOpenPrBranches(data.prs.map(pr => pr.headRefName))
      setOpenPrByBranch(Object.fromEntries(data.prs.map(pr => [pr.headRefName, pr.number])))
    }).catch(() => {})
  }

  const handleCreatePr = async () => {
    if (!name || creatingPr) return
    setCreatingPr(true)
    try {
      await runCreatePr()
    } catch (err) {
      // Pre-push hook blocked the push (e.g. repo's local tests/lint failed).
      // Offer the user a one-click force-create that pushes with --no-verify.
      if (err instanceof CreatePRPrePushHookError) {
        const detail = err.message.length > 800 ? err.message.slice(0, 800) + '\n\n…(truncated)' : err.message
        const summary = err.hookFailure === 'pre-push-tests'
          ? "The repo's pre-push tests failed."
          : 'The repo\'s pre-push hook (lint/typecheck) failed.'
        const confirmed = typeof window !== 'undefined' && window.confirm(
          `${summary}\n\n${detail}\n\nForce-create the PR anyway? (pushes with --no-verify, skipping the hook).`,
        )
        if (confirmed) {
          try {
            await runCreatePr({ force: true })
          } catch (forceErr) {
            toast(forceErr instanceof Error ? forceErr.message : 'Failed to force-create PR', 'error')
          }
        } else {
          toast('PR creation cancelled — fix the failing tests/lint, or click Create PR again to force.', 'info')
        }
      } else {
        toast(err instanceof Error ? err.message : 'Failed to create PR', 'error')
      }
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
      router.push(buildProjectTerminalPath(name, { jobId: result.job_id }))
    } catch (err) {
      setFixCiResult(err instanceof Error ? err.message : 'Failed to start CI fix')
      setFixingCi(false)
    }
  }

  const handleSaveActions = async () => {
    if (!name || actionsSaving) return
    const valid = editActions.filter(a => a.name.trim() && a.command.trim())
    setActionsSaving(true)
    setActionsSaved(false)
    try {
      const result = await saveCustomActions(name, valid)
      setEditActions(result.actions)
      setCustomActions(result.actions)
      writeUiCache(name, { actions: result.actions })
      setActionsSaved(true)
      setTimeout(() => setActionsSaved(false), 3000)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save actions', 'error')
    } finally {
      setActionsSaving(false)
    }
  }

  const configInputs = {
    test_command: testCommandInput,
    release_timeout_minutes: releaseTimeoutMinutesInput,
    test_cron_enabled: testCronEnabledInput,
    test_cron_schedule: testCronScheduleInput,
    auto_commit_enabled: autoCommitEnabledInput,
    auto_push_enabled: autoPushEnabledInput,
    auto_pr_merge_enabled: autoPrMergeEnabledInput,
    post_merge_watch_minutes: postMergeWatchMinutesInput,
    auto_revert_enabled: autoRevertEnabledInput,
    release_after_run: releaseAfterRunInput,
    issue_auto_branch: issueAutoBranchInput,
    tests_disabled: testsDisabledInput,
    review_disabled: reviewDisabledInput,
    review_prompt_addendum: reviewPromptAddendumInput,
    review_prerequisite_command: reviewPrerequisiteCommandInput,
    fix_prompt_addendum: fixPromptAddendumInput,
    commit_style: commitStyleInput,
    website: websiteInput,
    qa_url: qaUrlInput,
    dev_server_start_command: devServerStartCommandInput,
    dev_server_stop_command: devServerStopCommandInput,
    dev_server_ready_url: devServerReadyUrlInput,
    daily_spend_cap_usd: dailySpendCapUsdInput,
    release_spend_cap_usd: releaseSpendCapUsdInput,
  }

  const handleSaveConfig = async () => {
    if (!name || configSaving) return
    setConfigSaving(true)
    setConfigSaved(false)
    try {
      await updateProjectConfig(name, configInputs)
      setConfigSaved(true)
      applyConfigData(await fetchProjectConfig(name, { force: true }))
      setTimeout(() => setConfigSaved(false), 3000)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save config', 'error')
    } finally {
      setConfigSaving(false)
    }
  }

  const configDirty = config !== null && (
    configInputs.test_command !== config.test_command ||
    configInputs.release_timeout_minutes !== String(config.release_timeout_minutes ?? '') ||
    configInputs.test_cron_enabled !== config.test_cron_enabled ||
    configInputs.test_cron_schedule !== config.test_cron_schedule ||
    configInputs.auto_commit_enabled !== !!config.auto_commit_enabled ||
    configInputs.auto_push_enabled !== !!config.auto_push_enabled ||
    configInputs.auto_pr_merge_enabled !== !!config.auto_pr_merge_enabled ||
    configInputs.post_merge_watch_minutes !== String(config.post_merge_watch_minutes ?? 0) ||
    configInputs.auto_revert_enabled !== !!config.auto_revert_enabled ||
    configInputs.release_after_run !== !!config.release_after_run ||
    configInputs.issue_auto_branch !== (config.issue_auto_branch ?? true) ||
    configInputs.tests_disabled !== !!config.tests_disabled ||
    configInputs.review_disabled !== !!config.review_disabled ||
    configInputs.review_prompt_addendum !== (config.review_prompt_addendum ?? '') ||
    configInputs.review_prerequisite_command !== (config.review_prerequisite_command ?? '') ||
    configInputs.fix_prompt_addendum !== (config.fix_prompt_addendum ?? '') ||
    configInputs.commit_style !== (config.commit_style ?? '') ||
    configInputs.website !== (config.website ?? '') ||
    configInputs.qa_url !== (config.qa_url ?? '') ||
    configInputs.dev_server_start_command !== (config.dev_server_start_command ?? '') ||
    configInputs.dev_server_stop_command !== (config.dev_server_stop_command ?? '') ||
    configInputs.dev_server_ready_url !== (config.dev_server_ready_url ?? '') ||
    configInputs.daily_spend_cap_usd !== String(config.daily_spend_cap_usd ?? '') ||
    configInputs.release_spend_cap_usd !== String(config.release_spend_cap_usd ?? '')
  )

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
    <div className="px-0 py-1">
      {/* Header is split into two stacked rows: project identity on top and the
          action toolbar below. This keeps the toolbar left-aligned and stable
          regardless of branch-chip length or active tab. */}
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <ProjectLogo projectName={project.project} size={24} />
          <h2 className="text-xl font-semibold text-text-primary" data-private>{project.project}</h2>
          {currentBranch && (() => {
            const isDefault = !!defaultBranch && currentBranch === defaultBranch
            // On the default branch the pill is noise — hide entirely.
            // On a feature branch, show just the git-branch icon (+ ahead/behind
            // counts) and put the full branch name in the tooltip. The branch
            // name itself is usually long and redundant with the issue chip
            // that renders next to this.
            if (isDefault) return null
            const ahead = branchCommitsAhead ?? 0
            const behind = behindCount
            return (
              <Pill
                tone="accent"
                size="xs"
                className="rounded-full border-accent/30 bg-accent-light font-mono"
                title={`On feature branch ${currentBranch} — default is ${defaultBranch ?? 'unknown'}`}
                data-private
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" className="shrink-0">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
                </svg>
                {ahead > 0 && (
                  <span className="text-status-warning tabular-nums" title={`${ahead} commit${ahead !== 1 ? 's' : ''} ahead of origin/${defaultBranch ?? 'default'}`}>
                    ↑{ahead}
                  </span>
                )}
                {behind > 0 && (
                  <span className="text-status-info tabular-nums" title={`${behind} commit${behind !== 1 ? 's' : ''} behind origin`}>
                    ↓{behind}
                  </span>
                )}
              </Pill>
            )
          })()}
          {currentBranch && githubUrl && (() => {
            const m = currentBranch.match(/^fix\/issue-(\d+)/)
            if (!m) return null
            const issueNumber = m[1]
            return (
              <a
                href={`${githubUrl}/issues/${issueNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({
                  variant: 'info',
                  size: 'sm',
                  className: 'rounded-full py-0.5 font-mono',
                })}
                title={`Open linked GitHub issue #${issueNumber}`}
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" className="shrink-0">
                  <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/>
                  <path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/>
                </svg>
                <span>#{issueNumber}</span>
              </a>
            )
          })()}
          {releaseTag && (
            <Pill
              size="xs"
              className="gap-1 rounded-full bg-bg-secondary font-mono tabular-nums"
              title="Latest release"
              data-private
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" className="shrink-0">
                <path d="M2.5 7.775V2.75a.25.25 0 01.25-.25h5.025a.25.25 0 01.177.073l6.25 6.25a.25.25 0 010 .354l-5.025 5.025a.25.25 0 01-.354 0l-6.25-6.25a.25.25 0 01-.073-.177zm-1.5 0V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM6 5a1 1 0 100 2 1 1 0 000-2z" />
              </svg>
              {releaseTag}
            </Pill>
          )}
          {boardUrl && (
            <a
              href={`${boardUrl}?filterQuery=${encodeURIComponent(name)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({
                variant: 'secondary',
                size: 'sm',
                className: 'rounded-full py-0.5 font-normal text-text-secondary hover:border-accent/40 hover:text-accent',
              })}
              title="Open this project on the TamTam GitHub board"
            >
              Board ↗
            </a>
          )}
          <PillButton
            type="button"
            tone="warning"
            active={!!config?.paused}
            inactiveStyle="subtle"
            aria-label={config?.paused ? 'Resume project' : 'Pause project'}
            aria-pressed={!!config?.paused}
            onClick={async () => {
              const next = !config?.paused
              try {
                const res = await fetch(`/api/projects/by-project/${encodeURIComponent(name)}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ paused: next }),
                })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                applyConfigData(await fetchProjectConfig(name, { force: true }))
                toast(next ? `${name} paused — automated runs blocked` : `${name} resumed`, 'success')
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Failed to toggle pause', 'error')
              }
            }}
            className={
              config?.paused
                ? 'gap-1 rounded-full border-status-warning/40 bg-status-warning/10 hover:bg-status-warning/20'
                : 'gap-1 rounded-full bg-bg-secondary hover:border-accent/40 hover:bg-bg-secondary hover:text-accent'
            }
            title={config?.paused
              ? 'Project is paused — scheduled agents, agent API runs, and releases are blocked. Manual terminal sessions still work. Click to resume.'
              : 'Pause this project: blocks scheduled agents, agent API runs, and releases without affecting other projects.'}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${config?.paused ? 'bg-status-warning' : 'border border-text-tertiary'}`} aria-hidden />
            {config?.paused ? 'Paused' : 'Pause'}
          </PillButton>
          <PillButton
            type="button"
            tone="accent"
            active={!!config?.release_after_run}
            inactiveStyle="subtle"
            aria-pressed={!!config?.release_after_run}
            onClick={async () => {
              const next = !config?.release_after_run
              try {
                const res = await fetch(`/api/projects/by-project/${encodeURIComponent(name)}/config`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ release_after_run: next }),
                })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                applyConfigData(await fetchProjectConfig(name, { force: true }))
                toast(next ? `Auto release enabled for ${name}` : `Auto release disabled for ${name}`, 'success')
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Failed to toggle auto release', 'error')
              }
            }}
            className={
              config?.release_after_run
                ? 'gap-1 rounded-full border-accent/40 hover:bg-accent/20'
                : 'gap-1 rounded-full bg-bg-secondary hover:border-accent/40 hover:bg-bg-secondary hover:text-accent'
            }
            title={config?.release_after_run
              ? 'Auto release is ON — release pipeline triggers after each terminal or agent run finishes. Click to disable.'
              : 'Auto release is OFF — click to auto-trigger the release pipeline after each terminal or agent run.'}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${config?.release_after_run ? 'bg-status-success' : 'border border-text-tertiary'}`} aria-hidden />
            {config?.release_after_run ? 'Auto release ON' : 'Auto release'}
          </PillButton>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <ProjectActions
            projectName={name}
            totalChanges={project.totalChanges}
            unpushed={project.unpushed ?? 0}
            aggregateCi={aggregateCi}
            ciFailedUrl={ciFailedUrl}
            githubUrl={githubUrl}
            websiteUrl={config?.website ?? null}
            jobsPaused={jobsPaused}
            config={config}
            verdict={verdict}
            hasUnreviewed={hasUnreviewed}
            isPipelineRunning={isPipelineRunning}
            isTestRunning={isTestRunning}
            isCiFixRunning={isCiFixRunning}
            fixingCi={fixingCi}
            fixCiResult={fixCiResult}
            releasing={releasing}
            testing={testing}
            pushing={pushing}
            pulling={pulling}
            pullResult={pullResult}
            pullDiverged={pullDiverged}
            behindCount={behindCount}
            creatingPr={creatingPr}
            pushingToPr={pushingToPr}
            currentBranch={currentBranch}
            defaultBranch={defaultBranch}
            branchCommitsAhead={branchCommitsAhead}
            openPrBranches={openPrBranches}
            openPrByBranch={openPrByBranch}
            customActions={customActions}
            runningActions={runningActions}
            onFixCi={handleFixCi}
            onRelease={handleRelease}
            onCreatePr={handleCreatePr}
            onPushToPr={handlePushToPr}
            onTest={handleTest}
            onCustomAction={handleCustomAction}
            onPush={handlePush}
            onPull={handlePull}
            onDismissDiverged={() => setPullDiverged(false)}
          />
        </div>
      </div>

      <div className="mb-3 flex justify-end">
        <ReleasePlanPanel
          projectName={name}
          refreshKey={[
            currentBranch ?? '',
            defaultBranch ?? '',
            project.totalChanges,
            project.unpushed ?? 0,
            verdict ?? '',
            config?.review_disabled ? 1 : 0,
            config?.tests_disabled ? 1 : 0,
            config?.auto_pr_merge_enabled ? 1 : 0,
            config?.post_merge_watch_minutes ?? '',
          ].join('|')}
        />
      </div>

      <TabNav
        projectName={name}
        activeTab={activeTab}
        totalChanges={project.totalChanges}
        issueCount={issueCount}
        runningCount={runningJobs.length}
        onSetTab={setActiveTab}
      />

      {/* Overview Tab */}
      {activeTab === 'overview' && name && (
        <OverviewTab
          projectName={name}
          totalChanges={project.totalChanges}
          unpushed={project.unpushed ?? 0}
          hasUnreviewed={hasUnreviewed}
          verdict={verdict}
          isReviewRunning={isReviewRunning}
          latestReview={latestReview}
          runningReview={runningReview}
          isTestRunning={isTestRunning}
          latestTest={latestTest}
          runningTest={runningTest}
          ciStatus={aggregateCi === 'success' || aggregateCi === 'failure' || aggregateCi === 'in_progress' ? aggregateCi : null}
          ciFailedUrl={ciFailedUrl}
          releaseTag={releaseTag}
          aggregateCi={aggregateCi}
          config={config}
          projectJobs={projectJobs}
          runningJobs={runningJobs}
          runningParentLookup={runningParentLookup}
          jobsLoaded={jobsLoaded}
          jobsPaused={jobsPaused}
          onOpenChanges={() => setActiveTab('changes')}
          onRefresh={onRefresh}
        />
      )}

      {/* Config Tab */}
      {activeTab === 'config' && (
        <div className="mt-4">
                <ConfigTab
                  config={config}
                  configLoading={configLoading}
                  onRetry={() => setConfigReloadNonce((n) => n + 1)}
                  testCommandInput={testCommandInput}
                  setTestCommandInput={setTestCommandInput}
                  releaseTimeoutMinutesInput={releaseTimeoutMinutesInput}
                  setReleaseTimeoutMinutesInput={setReleaseTimeoutMinutesInput}
                  testCronEnabledInput={testCronEnabledInput}
            setTestCronEnabledInput={setTestCronEnabledInput}
            testCronScheduleInput={testCronScheduleInput}
            setTestCronScheduleInput={setTestCronScheduleInput}
            autoCommitEnabledInput={autoCommitEnabledInput}
            setAutoCommitEnabledInput={setAutoCommitEnabledInput}
            autoPushEnabledInput={autoPushEnabledInput}
            setAutoPushEnabledInput={setAutoPushEnabledInput}
            autoPrMergeEnabledInput={autoPrMergeEnabledInput}
            setAutoPrMergeEnabledInput={setAutoPrMergeEnabledInput}
            postMergeWatchMinutesInput={postMergeWatchMinutesInput}
            setPostMergeWatchMinutesInput={setPostMergeWatchMinutesInput}
            autoRevertEnabledInput={autoRevertEnabledInput}
            setAutoRevertEnabledInput={setAutoRevertEnabledInput}
            releaseAfterRunInput={releaseAfterRunInput}
            setReleaseAfterRunInput={setReleaseAfterRunInput}
            issueAutoBranchInput={issueAutoBranchInput}
            setIssueAutoBranchInput={setIssueAutoBranchInput}
            testsDisabledInput={testsDisabledInput}
            setTestsDisabledInput={setTestsDisabledInput}
            reviewDisabledInput={reviewDisabledInput}
            setReviewDisabledInput={setReviewDisabledInput}
            reviewPromptAddendumInput={reviewPromptAddendumInput}
            setReviewPromptAddendumInput={setReviewPromptAddendumInput}
            reviewPrerequisiteCommandInput={reviewPrerequisiteCommandInput}
            setReviewPrerequisiteCommandInput={setReviewPrerequisiteCommandInput}
            fixPromptAddendumInput={fixPromptAddendumInput}
            setFixPromptAddendumInput={setFixPromptAddendumInput}
            commitStyleInput={commitStyleInput}
            setCommitStyleInput={setCommitStyleInput}
            websiteInput={websiteInput}
            setWebsiteInput={setWebsiteInput}
            qaUrlInput={qaUrlInput}
            setQaUrlInput={setQaUrlInput}
            devServerStartCommandInput={devServerStartCommandInput}
            setDevServerStartCommandInput={setDevServerStartCommandInput}
            devServerStopCommandInput={devServerStopCommandInput}
            setDevServerStopCommandInput={setDevServerStopCommandInput}
            devServerReadyUrlInput={devServerReadyUrlInput}
            setDevServerReadyUrlInput={setDevServerReadyUrlInput}
            dailySpendCapUsdInput={dailySpendCapUsdInput}
            setDailySpendCapUsdInput={setDailySpendCapUsdInput}
            releaseSpendCapUsdInput={releaseSpendCapUsdInput}
            setReleaseSpendCapUsdInput={setReleaseSpendCapUsdInput}
            editActions={editActions}
            setEditActions={setEditActions}
            anyDirty={anyDirty}
            anySaving={anySaving}
            allSaved={allSaved}
            onSaveAll={handleSaveAll}
            onRunSetup={() => router.push(buildProjectSetupPath(name))}
          />
          {name && (
            <div className="mt-6">
              <RetrievalReindexPanel projectName={name} />
            </div>
          )}
        </div>
      )}

      {activeTab === 'changes' && name && (
        <ChangesTab projectName={name} jobsPaused={jobsPaused} />
      )}

      {activeTab === 'issues' && name && (
          <IssuesTab projectName={name} onCountChange={setIssueCount} jobsPaused={jobsPaused} />
      )}

      {activeTab === 'docs' && name && (
        <DocsTab projectName={name} />
      )}

      {activeTab === 'history' && name && (
        <ProjectRunsTab projectName={name} jobsPaused={jobsPaused} />
      )}

      {activeTab === 'agents' && name && (
        <AgentsTab
          projectName={name}
          currentBranch={currentBranch}
          projectJobs={projectJobs}
          jobsPaused={jobsPaused}
        />
      )}

      {/* Terminal Tab */}
      {activeTab === 'terminal' && name && (
        <>
          <PipelineStrip
            projectName={name}
            projectJobs={projectJobs}
            config={config}
            totalChanges={project.totalChanges}
            unpushed={project.unpushed ?? 0}
            hasUnreviewed={hasUnreviewed}
            verdict={verdict}
            jobsPaused={jobsPaused}
            onRefresh={onRefresh}
          />
          <Suspense fallback={null}>
            <TerminalTab projectName={name} initialSessionId={params.sessionId} />
          </Suspense>
        </>
      )}

    </div>
  )
}

'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { fetchJobs, fetchProjectConfig, updateProjectConfig, fetchCustomActions, runCustomAction, saveCustomActions, fetchBehind, fetchIssuesAndPRs, fetchIssuesSummary, fetchBranch, fetchSettings } from '@/lib/client-api'
import type { JobInfo, ProjectConfig, CustomAction } from '@/lib/client-api'
import { FleetHealth } from '@/hooks/useProjectHealth'
import { useProjectActions } from '@/hooks/useProjectActions'
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
import { ProjectHeader } from '@/components/project-detail/ProjectHeader'
import { ProjectSignals } from '@/components/project-detail/ProjectSignals'
import { ReleasePlanPanel } from '@/components/project-detail/ReleasePlanPanel'
import { TabNav } from '@/components/project-detail/TabNav'
import { ProjectPageLoadingState } from '@/components/project-detail/ProjectPageLoadingState'
import { OverviewTab } from '@/components/project-detail/OverviewTab'
import { AgentsTab } from '@/components/AgentsTab'
import { buildProjectPath, buildProjectSetupPath, buildProjectTerminalPath } from '@/lib/client/project-routes'
import { resolveGithubBoardUrl } from '@/lib/client/resolve-github-board-url'
import { Button } from '@/components/ui/Button'

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
  const [projectJobs, setProjectJobs] = useState<JobInfo[]>([])
  const [jobsLoaded, setJobsLoaded] = useState(false)
  const [issueCount, setIssueCount] = useState<{ prs: number; issues: number } | null>(null)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null)
  const [branchCommitsAhead, setBranchCommitsAhead] = useState<number | null>(null)
  const [openPrBranches, setOpenPrBranches] = useState<string[]>([])
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

  const refreshIssuesAfterPr = () => {
    fetchIssuesAndPRs(name, true).then((data) => {
      setIssueCount({ prs: data.prs.length, issues: data.issues.length })
      setOpenPrBranches(data.prs.map((pr) => pr.headRefName))
    }).catch(() => {})
  }
  const runningTest = projectJobs.find(j => j.kind === 'test' && j.status === 'running')
  const isTestRunning = !!runningTest
  const projectActions = useProjectActions(name, {
    isTestRunning,
    onPrCreated: refreshIssuesAfterPr,
  })

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

  const handleTogglePause = async () => {
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
  }

  const handleToggleAutoRelease = async () => {
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
  }

  return (
    <div className="px-0 py-1">
      <ProjectHeader
        project={project}
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
        fixingCi={projectActions.fixingCi}
        fixCiResult={projectActions.fixCiResult}
        releasing={projectActions.releasing}
        testing={projectActions.testing}
        behindCount={behindCount}
        creatingPr={projectActions.creatingPr}
        currentBranch={currentBranch}
        defaultBranch={defaultBranch}
        branchCommitsAhead={branchCommitsAhead}
        openPrBranches={openPrBranches}
        customActions={customActions}
        runningActions={runningActions}
        releaseTag={releaseTag}
        boardUrl={boardUrl}
        onFixCi={projectActions.handleFixCi}
        onRelease={projectActions.handleRelease}
        onCreatePr={projectActions.handleCreatePr}
        onTest={projectActions.handleTest}
        onCustomAction={handleCustomAction}
        onTogglePause={handleTogglePause}
        onToggleAutoRelease={handleToggleAutoRelease}
      />

      <ProjectSignals projectName={name} />

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
            onDiscard={config ? () => applyConfigData(config) : undefined}
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
        <ChangesTab projectName={name} jobsPaused={jobsPaused} isPipelineRunning={isPipelineRunning} />
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

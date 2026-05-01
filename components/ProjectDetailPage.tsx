'use client'

import { useState, useEffect, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { fixCi, releaseProject, fetchJobs, fetchProjectConfig, updateProjectConfig, fetchCustomActions, runCustomAction, saveCustomActions, pullProject, fetchBehind, PullDivergedError, testProject, fetchIssuesAndPRs, pushProject, fetchBranch, createProjectPR } from '@/lib/client-api'
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
import { ConfigTab } from '@/components/project-detail/ConfigTab'
import { PipelineStrip } from '@/components/project-detail/PipelineStrip'
import { ProjectActions } from '@/components/project-detail/ProjectActions'
import { TabNav } from '@/components/project-detail/TabNav'
import { OverviewTab } from '@/components/project-detail/OverviewTab'

type Tab = 'overview' | 'config' | 'history' | 'terminal' | 'changes' | 'issues' | 'docs'

type Verdict = 'LGTM' | 'NEEDS ATTENTION' | 'DO NOT SHIP'
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
  const [projectJobs, setProjectJobs] = useState<JobInfo[]>([])
  const [issueCount, setIssueCount] = useState<{ prs: number; issues: number } | null>(null)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null)
  const [branchCommitsAhead, setBranchCommitsAhead] = useState<number | null>(null)
  const [openPrBranches, setOpenPrBranches] = useState<string[]>([])
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

  // Poll issues/PRs + current/default branch together
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

  const applyConfigData = (data: ProjectConfig) => {
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
  }

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

  // Load config when the overview or config tab is active
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
  }, [activeTab, name])


  const project = fleet.projects.find(p => p.project === name)

  if (!project) {
    return (
      <div className="py-2">
        <button className="text-accent hover:underline text-sm mb-4 inline-block" onClick={() => router.push('/')}>
          &larr; Back to projects
        </button>
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
  const isReviewRunning = projectJobs.some(j => j.kind === 'review' && j.status === 'running')
  const isCiFixRunning = projectJobs.some(j => j.kind === 'fix-ci' && j.status === 'running')
  const isTestRunning = projectJobs.some(j => j.kind === 'test' && j.status === 'running')
  const isPipelineRunning = isPipelineBusy(projectJobs)

  // Get latest review verdict
  const latestReview = projectJobs
    .filter(j => j.kind === 'review' && j.status === 'done' && j.verdict)
    .sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))[0]
  const verdict = latestReview?.verdict as Verdict | undefined

  // Get latest test result
  const latestTest = projectJobs
    .filter(j => j.kind === 'test' && j.status === 'done')
    .sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))[0]

  const RELEASE_CHILD_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'mark-dod', 'pr-wait'])
  const running = projectJobs.filter(j => j.status === 'running')
  const releaseRunning = running.some(j => j.kind === 'release')
  const runningJobs = (releaseRunning ? running.filter(j => !RELEASE_CHILD_KINDS.has(j.kind)) : running)
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))

  const [releasing, setReleasing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [pullResult, setPullResult] = useState<string | null>(null)
  const [pullDiverged, setPullDiverged] = useState(false)
  const [behindCount, setBehindCount] = useState(0)

  useEffect(() => {
    if (!name) return
    let active = true
    const refresh = () => {
      fetchBehind(name).then((r) => { if (active) setBehindCount(r.behind) }).catch(() => {})
    }
    refresh()
    const interval = setInterval(refresh, 60000)
    return () => { active = false; clearInterval(interval) }
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
      toast(result.url ? `Pull request created: ${result.url}` : 'Pull request created', 'success')
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

  const configInputs = {
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
  }

  const handleSaveConfig = async () => {
    if (!name || configSaving) return
    setConfigSaving(true)
    setConfigSaved(false)
    try {
      await updateProjectConfig(name, configInputs)
      setConfigSaved(true)
      applyConfigData(await fetchProjectConfig(name))
      setTimeout(() => setConfigSaved(false), 3000)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save config', 'error')
    } finally {
      setConfigSaving(false)
    }
  }

  const configDirty = config !== null && (
    configInputs.test_command !== config.test_command ||
    configInputs.test_cron_enabled !== config.test_cron_enabled ||
    configInputs.test_cron_schedule !== config.test_cron_schedule ||
    configInputs.auto_commit_enabled !== !!config.auto_commit_enabled ||
    configInputs.auto_push_enabled !== !!config.auto_push_enabled ||
    configInputs.auto_pr_merge_enabled !== !!config.auto_pr_merge_enabled ||
    configInputs.release_after_run !== !!config.release_after_run ||
    configInputs.pr_workflow_enabled !== !!config.pr_workflow_enabled ||
    configInputs.issue_auto_branch !== (config.issue_auto_branch ?? true) ||
    configInputs.tests_disabled !== !!config.tests_disabled ||
    configInputs.review_disabled !== !!config.review_disabled
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
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <h2 className="text-xl font-semibold text-text-primary" data-private>{project.project}</h2>
          {currentBranch && (() => {
            const isDefault = !!defaultBranch && currentBranch === defaultBranch
            const ahead = branchCommitsAhead ?? 0
            const behind = behindCount
            const tone = isDefault
              ? 'border-border bg-bg-secondary text-text-secondary'
              : 'border-accent/30 bg-accent-light text-accent'
            return (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-mono ${tone}`}
                title={isDefault ? `On default branch (${currentBranch})` : `On feature branch — default is ${defaultBranch ?? 'unknown'}`}
                data-private
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" className="shrink-0">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
                </svg>
                <span className="truncate max-w-[16rem]">{currentBranch}</span>
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
              </span>
            )
          })()}
          {releaseTag && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-secondary px-2 py-0.5 text-xs text-text-secondary font-mono tabular-nums"
              title="Latest release"
              data-private
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" className="shrink-0">
                <path d="M2.5 7.775V2.75a.25.25 0 01.25-.25h5.025a.25.25 0 01.177.073l6.25 6.25a.25.25 0 010 .354l-5.025 5.025a.25.25 0 01-.354 0l-6.25-6.25a.25.25 0 01-.073-.177zm-1.5 0V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM6 5a1 1 0 100 2 1 1 0 000-2z" />
              </svg>
              {releaseTag}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <ProjectActions
            projectName={name}
            totalChanges={project.totalChanges}
            unpushed={project.unpushed ?? 0}
            aggregateCi={aggregateCi}
            ciFailedUrl={ciFailedUrl}
            githubUrl={githubUrl}
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
          isTestRunning={isTestRunning}
          latestTest={latestTest}
          ciStatus={aggregateCi === 'success' || aggregateCi === 'failure' || aggregateCi === 'in_progress' ? aggregateCi : null}
          ciFailedUrl={ciFailedUrl}
          releaseTag={releaseTag}
          aggregateCi={aggregateCi}
          config={config}
          currentBranch={currentBranch}
          runningJobs={runningJobs}
          onOpenChanges={() => setActiveTab('changes')}
        />
      )}

      {/* Config Tab */}
      {activeTab === 'config' && (
        <div className="mt-4">
          <ConfigTab
            config={config}
            configLoading={configLoading}
            testCommandInput={testCommandInput}
            setTestCommandInput={setTestCommandInput}
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
            releaseAfterRunInput={releaseAfterRunInput}
            setReleaseAfterRunInput={setReleaseAfterRunInput}
            prWorkflowEnabledInput={prWorkflowEnabledInput}
            setPrWorkflowEnabledInput={setPrWorkflowEnabledInput}
            issueAutoBranchInput={issueAutoBranchInput}
            setIssueAutoBranchInput={setIssueAutoBranchInput}
            testsDisabledInput={testsDisabledInput}
            setTestsDisabledInput={setTestsDisabledInput}
            reviewDisabledInput={reviewDisabledInput}
            setReviewDisabledInput={setReviewDisabledInput}
            editActions={editActions}
            setEditActions={setEditActions}
            anyDirty={anyDirty}
            anySaving={anySaving}
            allSaved={allSaved}
            onSaveAll={handleSaveAll}
          />
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

      {activeTab === 'history' && name && (
        <ProjectRunsTab projectName={name} />
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

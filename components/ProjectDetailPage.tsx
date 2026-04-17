'use client'

import { useState, useEffect, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { reviewProject, testProject, fixCi, fetchJobs, fetchProjectConfig, updateProjectConfig, fetchCustomActions, runCustomAction, saveCustomActions } from '@/lib/client-api'
import type { JobInfo, ProjectConfig, CustomAction } from '@/lib/client-api'
import { FleetHealth } from '@/hooks/useProjectHealth'
import { statusDot, priorityColor, getHighestPriority, getAggregateCi, formatDuration } from '@/lib/statusConstants'
import { SmartPushModal } from '@/components/SmartPushModal'
import { RunModal } from '@/components/RunModal'
import { TerminalTab } from '@/components/TerminalTab'
import { AgentsTab } from '@/components/AgentsTab'
import { ProjectRunsTab } from '@/components/ProjectRunsTab'
import { ChangesTab } from '@/components/ChangesTab'
import { useToast } from '@/components/Toast'

type Tab = 'overview' | 'config' | 'history' | 'terminal' | 'changes'

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

  // Load config when config tab is active
  useEffect(() => {
    if (activeTab !== 'config' || !name) return
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

  const [reviewError, setReviewError] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  const handleReview = async () => {
    if (!name) return
    setReviewError(null)
    try {
      await reviewProject(name)
      toast(`Review started for ${name}`, 'success')
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
      await updateProjectConfig(name, { test_command: testCommandInput })
      setConfigSaved(true)
      // Reload config to show effective command
      const data = await fetchProjectConfig(name)
      setConfig(data)
      setTestCommandInput(data.test_command)
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

  const configDirty = config !== null && testCommandInput !== config.test_command

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-text-primary">{project.project}</h2>
          {releaseTag && <span className="text-text-secondary text-sm">{releaseTag}</span>}
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: dot.color }} />
            <span className="text-sm">{dot.label}</span>
          </span>
          {highestPriority && (
            <span style={{ color: priorityColor[highestPriority] }} className="text-sm">
              {highestPriority}
            </span>
          )}
          {aggregateCi === 'success' && <span className="text-status-success text-sm">CI ✓</span>}
          {aggregateCi === 'failure' && (
            ciFailedUrl ? (
              <a href={ciFailedUrl} target="_blank" rel="noopener noreferrer" className="text-status-error hover:underline text-sm">CI ✗</a>
            ) : (
              <span className="text-status-error text-sm">CI ✗</span>
            )
          )}
          {aggregateCi === 'in_progress' && <span className="text-status-warning text-sm">CI ⋯</span>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {aggregateCi === 'failure' && ciFailedUrl && (
            <button
              className="px-3 py-1.5 text-sm border border-status-error text-status-error rounded-md hover:bg-status-error/10"
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
            className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
            onClick={handleReview}
            disabled={isReviewRunning || project.totalChanges === 0}
            title={isReviewRunning ? 'Review already in progress' : project.totalChanges === 0 ? 'No changes to review' : 'Start review'}
          >
            {isReviewRunning ? 'Reviewing...' : 'Review'}
          </button>
          <button
            className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
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
            className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
            onClick={() => setShowPushModal(true)}
            disabled={project.totalChanges === 0}
            title={project.totalChanges === 0 ? 'No changes to push' : 'Push changes to git'}
          >
            Push
          </button>
          <button
            className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover"
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
          {/* Review & Test status */}
          {(project.totalChanges > 0 || verdict || latestTest) && (
            <div className="bg-bg-secondary rounded-lg p-4 mb-4 flex flex-col gap-2">
              {project.totalChanges > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-text-secondary text-sm font-medium">Changes:</span>
                  <span className={hasUnreviewed ? 'text-status-error' : 'text-status-success'}>
                    {project.totalChanges} file{project.totalChanges !== 1 ? 's' : ''}
                  </span>
                  {hasUnreviewed ? (
                    <span className="px-2 py-0.5 text-xs rounded-full font-medium bg-status-warning/15 text-status-warning">unreviewed</span>
                  ) : (
                    <span className="px-2 py-0.5 text-xs rounded-full font-medium bg-status-success/15 text-status-success">reviewed</span>
                  )}
                </div>
              )}
              {(verdict || isReviewRunning) && (
                <div className="flex items-center gap-2">
                  <span className="text-text-secondary text-sm font-medium">Review:</span>
                  {isReviewRunning ? (
                    <span className="text-status-warning">in progress...</span>
                  ) : verdict ? (
                    <span className={`text-xs font-medium ${verdict === 'LGTM' ? 'text-status-success' : verdict === 'NEEDS ATTENTION' ? 'text-status-warning' : 'text-status-error'}`}>
                      {verdict === 'LGTM' ? '✅' : verdict === 'NEEDS ATTENTION' ? '⚠️' : '❌'} {verdict}
                    </span>
                  ) : null}
                  {latestReview && (
                    <button
                      className="px-2 py-0.5 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
                      onClick={() => router.push(`/project/${name}/terminal?job=${encodeURIComponent(latestReview.id)}`)}
                    >
                      View
                    </button>
                  )}
                </div>
              )}
              {(latestTest || isTestRunning) && (
                <div className="flex items-center gap-2">
                  <span className="text-text-secondary text-sm font-medium">Tests:</span>
                  {isTestRunning ? (
                    <span className="text-status-warning">running...</span>
                  ) : latestTest ? (
                    latestTest.exit_code === 0 ? (
                      <span className="text-status-success">passed</span>
                    ) : (
                      <span className="text-status-error">failed (exit {latestTest.exit_code})</span>
                    )
                  ) : null}
                  {latestTest && (
                    <button
                      className="px-2 py-0.5 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
                      onClick={() => router.push(`/project/${name}/terminal?job=${encodeURIComponent(latestTest.id)}`)}
                    >
                      View
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <AgentsTab projectName={name} />
        </>
      )}

      {/* Config Tab */}
      {activeTab === 'config' && (
        <div className="mt-4">
          {configLoading ? (
            <div className="text-text-secondary text-sm">Loading configuration...</div>
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

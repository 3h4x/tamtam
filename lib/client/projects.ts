import type { ProjectsResponse } from '@/lib/shared/types'
import type {
  TaskDetail,
  IssuesResponse,
  Persona,
  RunProjectOptions,
  LogEntry,
  ChangesResponse,
  ChangeDiffResponse,
  ProjectConfig,
  ProjectSetupStatus,
  ProjectSetupState,
  ProjectSetupStep,
  MarkDodResult,
  Recommendation,
  ProjectPipelineStats,
} from './types'
import { cachedGet, invalidateGet, CachedGetError } from './request-cache'
import {
  AUTO_APPLICABLE_RECOMMENDATION_TYPES,
  AUTO_RECOMMENDATION_TYPES,
  MANUAL_RECOMMENDATION_TYPES,
  isAutoRecommendation,
  isManualRecommendation,
} from '@/lib/recommendations/classification'

export const API_BASE = '/api/projects'

export async function fetchProjects(opts: { force?: boolean } = {}): Promise<ProjectsResponse> {
  // Deduped + short-TTL memo. The shell-level ProjectsProvider AND each page's
  // own component (logs, skills, initiatives) both call this on mount, and it is
  // backed by the heavy cross-repo git sweep (`fetchProjectData`) — so the raw
  // duplicate hammered the single event-loop thread on every page load. Routing
  // it through the shared GET cache collapses the concurrent/near-concurrent
  // duplicates into ONE request. `force` (the provider's authoritative + post-
  // mutation loads) bypasses the memo so a pause/resume/priority change is never
  // read back stale; background polls use the memo. The server already SWR-caches
  // the sweep for 10s, so a 2s client memo just avoids the redundant round-trip.
  try {
    return await cachedGet<ProjectsResponse>(API_BASE, { ttlMs: 2000, force: opts.force })
  } catch (e) {
    if (e instanceof CachedGetError) throw new Error(`Failed to fetch projects: ${e.statusText}`, { cause: e })
    throw e
  }
}

export async function setPriority(
  taskId: string,
  priority: string
): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE}/${encodeURIComponent(taskId)}/priority`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority }),
  })
  if (!response.ok) {
    throw new Error(`Failed to set priority: ${response.statusText}`)
  }
  return response.json()
}

async function setProjectPaused(projectName: string, paused: boolean): Promise<{ status: string }> {
  const response = await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused }),
  })
  if (!response.ok) {
    throw new Error(`Failed to ${paused ? 'pause' : 'resume'}: ${response.statusText}`)
  }
  return { status: 'ok' }
}

export function pauseProject(projectName: string): Promise<{ status: string }> {
  return setProjectPaused(projectName, true)
}

export function resumeProject(projectName: string): Promise<{ status: string }> {
  return setProjectPaused(projectName, false)
}

export async function fetchTaskDetail(taskId: string): Promise<TaskDetail> {
  const response = await fetch(`${API_BASE}/${encodeURIComponent(taskId)}/detail`)
  if (!response.ok) {
    throw new Error(`Failed to fetch task detail: ${response.statusText}`)
  }
  return response.json()
}

export async function fetchProjectPipelineStats(
  projectName: string,
  window_: '24h' | '7d' | '30d' | 'all' = '24h',
): Promise<ProjectPipelineStats> {
  const params = new URLSearchParams({
    project: projectName,
    window: window_,
  })
  const response = await fetch(`/api/stats/pipeline?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch pipeline stats: ${response.statusText}`)
  }
  return response.json()
}

export async function fixCi(projectName: string): Promise<{ status: string; job_id: string; pid: number; log_path: string; ci_url: string }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/fix-ci`, {
    method: 'POST',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to start CI fix: ${response.statusText}`)
  }
  return response.json()
}

export async function reviewProject(projectName: string): Promise<{ status: string; job_id: string; pid: number; log_path: string }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/review`, {
    method: 'POST',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to start review: ${response.statusText}`)
  }
  return response.json()
}

export interface ReleaseProjectOptions {
  queueIfBlocked?: boolean
  sourceJobId?: string
}

export async function releaseProject(
  projectName: string,
  options: ReleaseProjectOptions = {},
): Promise<{ status: string; step?: 'test' | 'review' | 'commit' | 'push'; job_id?: string; release_job_id?: string; message: string; blocking_job_id?: string }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/release`, {
    method: 'POST',
    headers: options.queueIfBlocked || options.sourceJobId ? { 'Content-Type': 'application/json' } : undefined,
    body: options.queueIfBlocked || options.sourceJobId
      ? JSON.stringify({
          queue_if_blocked: !!options.queueIfBlocked,
          source_job_id: options.sourceJobId,
        })
      : undefined,
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const detail = data.detail as string | undefined
    const blockingJobId = typeof data.blocking_job_id === 'string' ? data.blocking_job_id : undefined
    const isPipelineLocked =
      response.status === 409
      && typeof detail === 'string'
      && (
        /\bpipeline\s+(?:is\s+)?running\b/i.test(detail)
        || /\bpipeline\s+already\s+running\b/i.test(detail)
        || /\brelease(?:\s+pipeline)?\s+already\s+running\b/i.test(detail)
      )
    const err = Object.assign(
      new Error(detail || `Failed to start release: ${response.statusText}`),
      {
        blockingJobId,
        isPipelineLocked,
      }
    )
    throw err
  }
  return response.json()
}

export async function fetchReleasePlan(
  projectName: string,
): Promise<import('@/lib/pipeline/release-plan').ReleasePlan> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/release/plan`)
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error((data.detail as string | undefined) || `Failed to fetch release plan: ${response.statusText}`)
  }
  return response.json()
}

export async function testProject(projectName: string): Promise<{ status: string; job_id: string; pid: number; log_path: string }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/test`, {
    method: 'POST',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to start tests: ${response.statusText}`)
  }
  return response.json()
}

export async function fetchIssuesAndPRs(projectName: string, forceRefresh = false): Promise<IssuesResponse> {
  const url = `${API_BASE}/by-project/${encodeURIComponent(projectName)}/issues?full=1${forceRefresh ? '&refresh=1' : ''}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch issues: ${response.statusText}`)
  }
  return response.json()
}

export interface IssuesSummaryResponse {
  repo: string
  prCount: number
  issueCount: number
  openPrBranches: { branch: string; number: number }[]
  error: string | null
  cached: boolean
  cachedAt: number
}

export async function fetchIssuesSummary(projectName: string): Promise<IssuesSummaryResponse> {
  const url = `${API_BASE}/by-project/${encodeURIComponent(projectName)}/issues?summary=1`
  return cachedGet(url, { ttlMs: 5000 })
}

export async function mergePR(
  projectName: string,
  prNumber: number,
  mergeMethod: 'merge' | 'squash' | 'rebase' = 'merge'
): Promise<{ status: string; pr: number; repo: string }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prNumber, mergeMethod, action: 'merge' }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error((data as { detail?: string }).detail || `Merge failed: ${response.statusText}`)
  }
  return response.json()
}

// Kick off operator-initiated automated conflict resolution for a PR branch.
// Fire-and-forget: the server spawns an agent that rebases + resolves, then
// force-pushes and re-drives the merge via pr-wait. Returns the job it started.
export async function resolveConflicts(
  projectName: string,
  prNumber: number
): Promise<{ status: string; job_id: string; pr_number: number; branch: string }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/resolve-conflicts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prNumber }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error((data as { detail?: string }).detail || `Resolve conflicts failed: ${response.statusText}`)
  }
  return response.json()
}

// Close a GitHub issue from the Issues tab. Wraps the existing `issue-close`
// route (which runs `gh issue close` and invalidates the issue caches so the
// next fetch drops it from the open set). `reason` maps to GitHub's close
// reason: 'completed' (done) or 'not planned' (won't do).
export async function closeIssue(
  projectName: string,
  number: number,
  reason: 'completed' | 'not planned',
  comment?: string,
): Promise<{ status: string; number: number; reason: string; repo: string }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/issue-close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number, reason, ...(comment ? { comment } : {}) }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error((data as { detail?: string }).detail || `Close failed: ${response.statusText}`)
  }
  return response.json()
}

export async function approvePR(
  projectName: string,
  prNumber: number
): Promise<{ status: string; pr: number; repo: string }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prNumber, action: 'approve' }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error((data as { detail?: string }).detail || `Approve failed: ${response.statusText}`)
  }
  return response.json()
}

export async function reviewPR(
  projectName: string,
  prNumber: number,
  prTitle: string,
  headRef: string,
  baseRef: string,
): Promise<{ status: string; job_id: string; pid: number; log_path: string }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/review-pr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prNumber, prTitle, headRef, baseRef }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error((data as { detail?: string }).detail || `Review failed: ${response.statusText}`)
  }
  return response.json()
}

export async function addressPrComments(
  projectName: string,
  pr: number,
): Promise<{ status: string; job_id: string; pid: number; log_path: string }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/address-pr-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error((data as { detail?: string }).detail || `Address review comments failed: ${response.statusText}`)
  }
  return response.json()
}

export async function fetchPersonas(): Promise<{ personas: Persona[] }> {
  const response = await fetch(`${API_BASE}/personas`)
  if (!response.ok) {
    throw new Error(`Failed to fetch personas: ${response.statusText}`)
  }
  return response.json()
}

export interface PromptEstimateResult {
  bytes: number
  estimatedInputTokens: number
  warnTokens: number
  blockTokens: number
  warning: boolean
  blocked: boolean
  modelTier: string | null
  estimatedCostUsd: number
}

export interface RunStartedResult { status: string; job_id: string; pid: number; prompt_estimate?: PromptEstimateResult }
export interface RunQueuedResult { status: 'queued'; queueId: string; position: number; blockingKind: string }
export type RunProjectResult = RunStartedResult | RunQueuedResult

export function isQueuedRunResult(r: RunProjectResult): r is RunQueuedResult {
  return r.status === 'queued'
}

export async function runProject(projectName: string, prompt: string, opts: RunProjectOptions = {}): Promise<RunProjectResult> {
  const { files, persona, personas, model, resumeSessionId, contextMeta, userPrompt, ghIssueNumber, ghIssueRepo, ghIssueTitle, provider, permissionMode } = opts
  let response: Response
  if ((files && files.length > 0) || persona) {
    const formData = new FormData()
    formData.append('prompt', prompt)
    if (persona) formData.append('persona', persona)
    if (personas?.length) formData.append('personas', JSON.stringify(personas))
    if (model) formData.append('model', model)
    if (resumeSessionId) formData.append('resumeSessionId', resumeSessionId)
    if (contextMeta) formData.append('contextMeta', contextMeta)
    if (userPrompt) formData.append('userPrompt', userPrompt)
    if (ghIssueNumber != null) formData.append('ghIssueNumber', String(ghIssueNumber))
    if (ghIssueRepo) formData.append('ghIssueRepo', ghIssueRepo)
    if (ghIssueTitle) formData.append('ghIssueTitle', ghIssueTitle)
    if (provider) formData.append('provider', provider)
    if (permissionMode) formData.append('permissionMode', permissionMode)
    if (files) {
      for (const file of files) {
        formData.append('files', file, file.name)
      }
    }
    response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/run`, {
      method: 'POST',
      body: formData,
    })
  } else {
    const body: Record<string, unknown> = { prompt }
    if (personas?.length) body.personas = personas
    if (model) body.model = model
    if (resumeSessionId) body.resumeSessionId = resumeSessionId
    if (contextMeta) body.contextMeta = contextMeta
    if (userPrompt) body.userPrompt = userPrompt
    if (ghIssueNumber != null) body.ghIssueNumber = ghIssueNumber
    if (ghIssueRepo) body.ghIssueRepo = ghIssueRepo
    if (ghIssueTitle) body.ghIssueTitle = ghIssueTitle
    if (provider) body.provider = provider
    if (permissionMode) body.permissionMode = permissionMode
    response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to start: ${response.statusText}`)
  }
  return response.json()
}

export async function fetchProjectLogs(projectName: string): Promise<{ logs: LogEntry[] }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/logs`)
  if (!response.ok) {
    throw new Error(`Failed to fetch logs: ${response.statusText}`)
  }
  return response.json()
}

// pushProject(name) — push existing commits only (legacy "Push" button).
// pushProject(name, { commit: true }) — stage everything, generate the
// commit message via the agent, commit, then auto-chain to push (used by
// the "Push to PR" button when the branch already has an open PR).
export async function pushProject(
  projectName: string,
  opts: { commit?: boolean; releaseId?: string | null } = {},
): Promise<{ status: string; job_id: string }> {
  const init: RequestInit = { method: 'POST' }
  if (opts.commit || opts.releaseId) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify({
      ...(opts.commit ? { commit: true } : {}),
      ...(opts.releaseId ? { release_id: opts.releaseId } : {}),
    })
  }
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/push`, init)
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to push: ${response.statusText}`)
  }
  return response.json()
}

export async function checkoutDefaultBranch(
  projectName: string,
  opts?: { carryChanges?: boolean },
): Promise<{ status: string; branch: string; deletedBranch?: string | null }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/checkout-default`, {
    method: 'POST',
    headers: opts?.carryChanges ? { 'Content-Type': 'application/json' } : undefined,
    body: opts?.carryChanges ? JSON.stringify({ carryChanges: true }) : undefined,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || 'Failed to switch branch')
  return data
}

export async function fetchChanges(projectName: string, opts?: { signal?: AbortSignal }): Promise<ChangesResponse> {
  const url = `${API_BASE}/by-project/${encodeURIComponent(projectName)}/changes`
  const response = await fetch(url, { signal: opts?.signal })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to fetch changes: ${response.statusText}`)
  }
  return response.json()
}

export async function fetchBehind(projectName: string): Promise<{ behind: number; ahead: number }> {
  // Cached+deduped: refetched on every project-tab switch; server already has a
  // 60s TTL, so a 5s client memo just avoids the redundant round-trip.
  try {
    return await cachedGet(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/behind`, { ttlMs: 5000 })
  } catch {
    return { behind: 0, ahead: 0 }
  }
}

export async function fetchBranch(projectName: string): Promise<{ branch: string | null; defaultBranch: string; commitsAhead: number | null }> {
  try {
    return await cachedGet(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/branch`, { ttlMs: 5000 })
  } catch {
    throw new Error('Failed to fetch branch')
  }
}

// Custom error for pre-push hook failures so the UI can offer a force-retry.
export class CreatePRPrePushHookError extends Error {
  hookFailure: 'pre-push-tests' | 'pre-push-other'
  constructor(detail: string, hookFailure: 'pre-push-tests' | 'pre-push-other') {
    super(detail)
    this.name = 'CreatePRPrePushHookError'
    this.hookFailure = hookFailure
  }
}

export async function createProjectPR(
  projectName: string,
  opts: { force?: boolean } = {},
): Promise<{ url: string | null }> {
  const init: RequestInit = { method: 'POST' }
  if (opts.force) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify({ force: true })
  }
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/create-pr`, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 409 && data?.hookFailure) {
      throw new CreatePRPrePushHookError(data.detail || 'Pre-push hook blocked the push', data.hookFailure)
    }
    throw new Error(data.detail || 'Failed to create PR')
  }
  return data
}

export async function runMarkDod(
  projectName: string,
  ctx: { issue_number?: number; pr_number?: number; repo: string },
): Promise<MarkDodResult> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/mark-dod`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ctx),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || 'Failed to run DoD verification')
  return data
}

export class PullDivergedError extends Error {
  constructor() { super('diverged') }
}

export async function pullProject(
  projectName: string,
  strategy: 'ff-only' | 'merge' | 'rebase' = 'ff-only'
): Promise<{ status: string; output: string }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/changes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    if (response.status === 409 && (data as { diverged?: boolean }).diverged) {
      throw new PullDivergedError()
    }
    throw new Error((data as { detail?: string }).detail || `Pull failed: ${response.statusText}`)
  }
  return response.json()
}

export async function fetchChangeDiff(projectName: string, filename: string): Promise<ChangeDiffResponse> {
  const response = await fetch(
    `${API_BASE}/by-project/${encodeURIComponent(projectName)}/changes/diff?file=${encodeURIComponent(filename)}`
  )
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to fetch diff: ${response.statusText}`)
  }
  return response.json()
}

export async function fetchProjectConfig(projectName: string, opts: { force?: boolean } = {}): Promise<ProjectConfig> {
  // Cached+deduped across tab switches. Pass `{ force: true }` for the reload
  // right after a config write so a save is never followed by a stale read.
  // `force` also sends `x-tamtam-refresh: 1` so the server-side /config cache is
  // bypassed and rewarmed — the URL is unchanged so the client memo entry for
  // this project is still the one that gets refreshed.
  try {
    return await cachedGet(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/config`, {
      ttlMs: 5000,
      force: opts.force,
      init: opts.force ? { headers: { 'x-tamtam-refresh': '1' } } : undefined,
    })
  } catch (e) {
    if (e instanceof CachedGetError) throw new Error(`Failed to fetch project config: ${e.statusText}`, { cause: e })
    throw e
  }
}

export async function fetchProjectSetup(projectName: string): Promise<ProjectSetupStatus> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/setup`)
  if (!response.ok) {
    throw new Error(`Failed to fetch project setup: ${response.statusText}`)
  }
  return response.json()
}

export async function updateProjectSetup(
  projectName: string,
  patch: {
    step?: ProjectSetupStep
    status?: 'completed' | 'skipped'
    setup_complete?: boolean
    write_file_config?: boolean
    test_command?: string
    safe_users?: string[]
  },
): Promise<{ status: string; setup_complete: boolean; setup_state: ProjectSetupState }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/setup`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to update setup: ${response.statusText}`)
  }
  return response.json()
}

export async function updateProjectConfig(
  projectName: string,
  config: {
    test_command?: string
    release_timeout_minutes?: string
    test_cron_enabled?: boolean
    test_cron_schedule?: string
    auto_commit_enabled?: boolean
    auto_push_enabled?: boolean
    auto_pr_merge_enabled?: boolean
    post_merge_watch_minutes?: string
    auto_revert_enabled?: boolean
    release_after_run?: boolean
    issue_auto_branch?: boolean
    tests_disabled?: boolean
    review_disabled?: boolean
    review_prompt_addendum?: string
    review_prerequisite_command?: string
    fix_prompt_addendum?: string
    commit_style?: string
    website?: string
    qa_url?: string
    dev_server_start_command?: string
    dev_server_stop_command?: string
    dev_server_ready_url?: string
  }
): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to update config: ${response.statusText}`)
  }
  // Bust the cached config/action reads for this project so the next fetch is fresh.
  invalidateGet(`/by-project/${encodeURIComponent(projectName)}/config`)
  return response.json()
}

export async function fetchCustomActions(projectName: string): Promise<{ actions: import('./types').CustomAction[] }> {
  try {
    return await cachedGet(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/action`, { ttlMs: 5000 })
  } catch {
    return { actions: [] }
  }
}

export async function saveCustomActions(projectName: string, actions: import('./types').CustomAction[]): Promise<{ status: string; actions: import('./types').CustomAction[] }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/action`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to save actions: ${response.statusText}`)
  }
  invalidateGet(`/by-project/${encodeURIComponent(projectName)}/action`)
  return response.json()
}

export async function runCustomAction(projectName: string, actionName: string): Promise<{ status: string; job_id: string; pid: number }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: actionName }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to run action: ${response.statusText}`)
  }
  return response.json()
}

export async function fetchProjectDocs(projectName: string): Promise<{ docs: import('./types').ProjectDoc[] }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/docs`)
  if (!response.ok) throw new Error('Failed to fetch docs')
  return response.json()
}

export async function updateRecommendation(
  projectName: string,
  recommendationId: string,
  status: Extract<Recommendation['status'], 'open' | 'dismissed'>,
): Promise<{ recommendation: Recommendation }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/recommendations`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: recommendationId, status }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to update recommendation: ${response.statusText}`)
  }
  return response.json()
}

export interface RecommendationsSummary {
  openCount: number
  byProject: Record<string, number>
}

export async function fetchRecommendationsSummary(): Promise<RecommendationsSummary> {
  const response = await fetch(`/api/recommendations/summary`)
  if (!response.ok) throw new Error(`Failed to fetch recommendations summary: ${response.statusText}`)
  return response.json()
}

export async function fetchAllOpenRecommendations(): Promise<{ recommendations: Recommendation[] }> {
  const response = await fetch(`/api/recommendations`)
  if (!response.ok) throw new Error(`Failed to fetch recommendations: ${response.statusText}`)
  return response.json()
}

// History = recommendations that are no longer open: auto-resolved by the
// orchestrator, or dismissed/applied by the operator. Powers the History tab.
export async function fetchRecommendationsHistory(): Promise<{ recommendations: Recommendation[] }> {
  const response = await fetch(`/api/recommendations?state=history`)
  if (!response.ok) throw new Error(`Failed to fetch recommendation history: ${response.statusText}`)
  return response.json()
}

// Recommendation type classification moved to the pure `@/lib/recommendations/classification`
// module (so server code can import it without this file's client fetch-cache). Imported
// above for local use and re-exported here so existing `@/lib/client-api` importers are unchanged.
export {
  AUTO_APPLICABLE_RECOMMENDATION_TYPES,
  AUTO_RECOMMENDATION_TYPES,
  MANUAL_RECOMMENDATION_TYPES,
  isAutoRecommendation,
  isManualRecommendation,
}

/**
 * Apply a recommendation by performing the underlying mutation it suggests
 * on the server and only then marking the recommendation as `applied`.
 * Today only `agent_schedule_backoff` is supported.
 *
 * Returns the updated recommendation row on success. The route owns the
 * validation + rollback behavior so callers don't need to orchestrate
 * multiple writes from the client.
 */
export async function applyRecommendation(
  projectName: string,
  rec: Recommendation,
): Promise<{ recommendation: Recommendation }> {
  if (!AUTO_APPLICABLE_RECOMMENDATION_TYPES.has(rec.type)) {
    throw new Error(`Recommendation type "${rec.type}" is not auto-applicable`)
  }
  if (rec.type === 'agent_schedule_backoff') {
    if (!rec.agent_id) throw new Error('Recommendation is missing agent_id — cannot apply')
    const recommended = rec.payload?.recommendedSchedule
    if (typeof recommended !== 'string' || !recommended) {
      throw new Error('Recommendation payload is missing recommendedSchedule')
    }
  }
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/recommendations/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: rec.id }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to apply recommendation: ${response.statusText}`)
  }
  return response.json()
}

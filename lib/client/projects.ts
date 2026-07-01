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

export const API_BASE = '/api/projects'

export async function fetchProjects(): Promise<ProjectsResponse> {
  const response = await fetch(`${API_BASE}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch projects: ${response.statusText}`)
  }
  return response.json()
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
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch issues summary: ${response.statusText}`)
  }
  return response.json()
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
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/behind`)
  if (!response.ok) return { behind: 0, ahead: 0 }
  return response.json()
}

export async function fetchBranch(projectName: string): Promise<{ branch: string | null; defaultBranch: string; commitsAhead: number | null }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/branch`)
  if (!response.ok) throw new Error('Failed to fetch branch')
  return response.json()
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

export async function fetchProjectConfig(projectName: string): Promise<ProjectConfig> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/config`)
  if (!response.ok) {
    throw new Error(`Failed to fetch project config: ${response.statusText}`)
  }
  return response.json()
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
  return response.json()
}

export async function fetchCustomActions(projectName: string): Promise<{ actions: import('./types').CustomAction[] }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/action`)
  if (!response.ok) return { actions: [] }
  return response.json()
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

// Auto-apply whitelist — only types whose payload is unambiguous and whose
// effect is reversible should be auto-applicable. Anything else stays
// dismiss-only until the recommendation type is explicitly designed.
export const AUTO_APPLICABLE_RECOMMENDATION_TYPES = new Set([
  'agent_schedule_backoff',
])

// AUTO vs MANUAL describes WHO can resolve the recommendation, not who detected
// it. An "AUTO" recommendation is one the orchestrator resolves end-to-end on
// its own — it already took the action and there is nothing for the operator to
// do, so it carries the green AUTO pill and offers no Fix actions (dismiss only).
//   - orchestrator_boost : the orchestrator already fired the extra run; done.
//   - agent_autopilot    : the orchestrator already throttled cadence / down-
//                          graded the model (or restored either); done.
//
// Everything else is "manual": the orchestrator can DETECT it (and will
// auto-close the card if the situation later recovers — see
// `resolveRecommendationIfOpen`), but it cannot drive the fix itself. The
// operator must act, so these carry the amber MANUAL pill plus a Fix menu:
//   - agent_unfruitful          : widen the prompt / throttle / disable
//   - orchestrator_agent_health : narrow scope / investigate / throttle
//   - agent_schedule_backoff    : apply (or not) the slower cadence
export const AUTO_RECOMMENDATION_TYPES = new Set([
  'orchestrator_boost',
  'agent_autopilot',
])

// Types that flag operator-actionable work. They show the MANUAL pill and a Fix
// menu. Kept explicit (rather than "everything not AUTO") so a future
// informational type doesn't accidentally inherit a MANUAL pill.
export const MANUAL_RECOMMENDATION_TYPES = new Set([
  'agent_unfruitful',
  'orchestrator_agent_health',
  'agent_schedule_backoff',
])

export function isAutoRecommendation(type: string): boolean {
  return AUTO_RECOMMENDATION_TYPES.has(type)
}

export function isManualRecommendation(type: string): boolean {
  return MANUAL_RECOMMENDATION_TYPES.has(type)
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

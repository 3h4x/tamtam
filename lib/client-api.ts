import type { ProjectsResponse } from './types'

export type { Task, ProjectsResponse } from './types'

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
  const response = await fetch(`${API_BASE}/${taskId}/priority`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority }),
  })
  if (!response.ok) {
    throw new Error(`Failed to set priority: ${response.statusText}`)
  }
  return response.json()
}

export async function pauseProject(taskId: string): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE}/${taskId}/pause`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`Failed to pause: ${response.statusText}`)
  }
  return response.json()
}

export async function resumeProject(taskId: string): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE}/${taskId}/resume`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`Failed to resume: ${response.statusText}`)
  }
  return response.json()
}

export interface RunHistoryEntry {
  started: string | null
  ended: string | null
  duration_s: number | null
  exit_code: number | null
}

export interface TaskDetail {
  id: string
  project: string
  job: string | null
  prompt_path: string | null
  prompt_content: string | null
  memory_path: string | null
  memory_content: string | null
  persona: string[]
  run_history: RunHistoryEntry[]
}

export async function fetchTaskDetail(taskId: string): Promise<TaskDetail> {
  const response = await fetch(`${API_BASE}/${taskId}/detail`)
  if (!response.ok) {
    throw new Error(`Failed to fetch task detail: ${response.statusText}`)
  }
  return response.json()
}

export async function fixCi(projectName: string): Promise<{ status: string; job_id: string; pid: number; log_path: string; ci_url: string }> {
  const response = await fetch(`${API_BASE}/by-project/${projectName}/fix-ci`, {
    method: 'POST',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to start CI fix: ${response.statusText}`)
  }
  return response.json()
}

export async function reviewProject(projectName: string): Promise<{ status: string; job_id: string; pid: number; log_path: string }> {
  const response = await fetch(`${API_BASE}/by-project/${projectName}/review`, {
    method: 'POST',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to start review: ${response.statusText}`)
  }
  return response.json()
}

export async function releaseProject(projectName: string): Promise<{ status: string; step: 'test' | 'review' | 'push'; job_id?: string; release_job_id?: string; message: string }> {
  const response = await fetch(`${API_BASE}/by-project/${projectName}/release`, {
    method: 'POST',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const err = Object.assign(
      new Error(data.detail || `Failed to start release: ${response.statusText}`),
      {
        blockingJobId: data.blocking_job_id as string | undefined,
        isPipelineLocked: response.status === 409,
      }
    )
    throw err
  }
  return response.json()
}

export async function testProject(projectName: string): Promise<{ status: string; job_id: string; pid: number; log_path: string }> {
  const response = await fetch(`${API_BASE}/by-project/${projectName}/test`, {
    method: 'POST',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to start tests: ${response.statusText}`)
  }
  return response.json()
}

export interface GhLabel {
  name: string
  color: string
}

export interface GhAuthor {
  login: string
}

export interface GhPullRequest {
  number: number
  title: string
  state: string
  author: GhAuthor
  url: string
  createdAt: string
  updatedAt: string
  headRefName: string
  baseRefName: string
  isDraft: boolean
  reviewDecision: string | null
  labels: GhLabel[]
  body: string
  statusCheckRollup: Array<{
    name: string
    conclusion: string | null
    status: string
    workflowName: string
    detailsUrl: string
  }> | null
}

export interface GhIssue {
  number: number
  title: string
  state: string
  author: GhAuthor
  url: string
  createdAt: string
  updatedAt: string
  assignees: GhAuthor[]
  labels: GhLabel[]
  body: string
}

export interface IssuesResponse {
  repo: string
  prs: GhPullRequest[]
  issues: GhIssue[]
  error: string | null
  cached: boolean
  cachedAt: number | null
}

export async function fetchIssuesAndPRs(projectName: string, forceRefresh = false): Promise<IssuesResponse> {
  const url = `${API_BASE}/by-project/${projectName}/issues${forceRefresh ? '?refresh=1' : ''}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch issues: ${response.statusText}`)
  }
  return response.json()
}

export async function mergePR(
  projectName: string,
  prNumber: number,
  mergeMethod: 'merge' | 'squash' | 'rebase' = 'merge'
): Promise<{ status: string; pr: number; repo: string }> {
  const response = await fetch(`${API_BASE}/by-project/${projectName}/issues`, {
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
  const response = await fetch(`${API_BASE}/by-project/${projectName}/issues`, {
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
  const response = await fetch(`${API_BASE}/by-project/${projectName}/review-pr`, {
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

export interface Persona {
  path: string
  category: string
  name: string
  description: string
  emoji: string
}

export async function fetchPersonas(): Promise<{ personas: Persona[] }> {
  const response = await fetch(`${API_BASE}/personas`)
  if (!response.ok) {
    throw new Error(`Failed to fetch personas: ${response.statusText}`)
  }
  return response.json()
}

export interface RunProjectOptions {
  files?: File[]
  persona?: string
  personas?: string[]
  model?: string
  resumeSessionId?: string
  contextMeta?: string
  userPrompt?: string
  ghIssueNumber?: number
  ghIssueRepo?: string
  ghIssueTitle?: string
}

export async function runProject(projectName: string, prompt: string, opts: RunProjectOptions = {}): Promise<{ status: string; job_id: string; pid: number }> {
  const { files, persona, personas, model, resumeSessionId, contextMeta, userPrompt, ghIssueNumber, ghIssueRepo, ghIssueTitle } = opts
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
    if (files) {
      for (const file of files) {
        formData.append('files', file, file.name)
      }
    }
    response = await fetch(`${API_BASE}/by-project/${projectName}/run`, {
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
    response = await fetch(`${API_BASE}/by-project/${projectName}/run`, {
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

export interface LogEntry {
  filename: string
  content: string
}

export async function fetchProjectLogs(projectName: string): Promise<{ logs: LogEntry[] }> {
  const response = await fetch(`${API_BASE}/by-project/${projectName}/logs`)
  if (!response.ok) {
    throw new Error(`Failed to fetch logs: ${response.statusText}`)
  }
  return response.json()
}

// pushProject(name) — push existing commits only (legacy "Push" button).
// pushProject(name, { commit: true }) — stage everything, generate the
// commit message via Claude, commit, then auto-chain to push (used by
// the "Push to PR" button when the branch already has an open PR).
export async function pushProject(
  projectName: string,
  opts: { commit?: boolean } = {},
): Promise<{ status: string; job_id: string }> {
  const init: RequestInit = { method: 'POST' }
  if (opts.commit) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify({ commit: true })
  }
  const response = await fetch(`${API_BASE}/by-project/${projectName}/push`, init)
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to push: ${response.statusText}`)
  }
  return response.json()
}

// Changes API
export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T'

export interface ChangeFile {
  status: ChangeStatus
  filename: string
  additions: number
  deletions: number
  binary: boolean
}

export interface ChangesResponse {
  files: ChangeFile[]
  totalFiles: number
  totalAdditions: number
  totalDeletions: number
  branch: string | null
  defaultBranch?: string
  branchMerged?: boolean
  openPrUrl?: string | null
  behind: number
  ahead: number
}

export async function checkoutDefaultBranch(
  projectName: string,
  opts?: { carryChanges?: boolean },
): Promise<{ status: string; branch: string; deletedBranch?: string | null }> {
  const response = await fetch(`${API_BASE}/by-project/${projectName}/checkout-default`, {
    method: 'POST',
    headers: opts?.carryChanges ? { 'Content-Type': 'application/json' } : undefined,
    body: opts?.carryChanges ? JSON.stringify({ carryChanges: true }) : undefined,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || 'Failed to switch branch')
  return data
}

export async function fetchChanges(projectName: string, opts?: { signal?: AbortSignal }): Promise<ChangesResponse> {
  const url = `${API_BASE}/by-project/${projectName}/changes`
  const response = await fetch(url, { signal: opts?.signal })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to fetch changes: ${response.statusText}`)
  }
  return response.json()
}

export async function fetchBehind(projectName: string): Promise<{ behind: number; ahead: number }> {
  const response = await fetch(`${API_BASE}/by-project/${projectName}/behind`)
  if (!response.ok) return { behind: 0, ahead: 0 }
  return response.json()
}

export async function fetchBranch(projectName: string): Promise<{ branch: string | null; defaultBranch: string; commitsAhead: number | null }> {
  const response = await fetch(`${API_BASE}/by-project/${projectName}/branch`)
  if (!response.ok) throw new Error('Failed to fetch branch')
  return response.json()
}

export async function createProjectPR(projectName: string): Promise<{ url: string | null }> {
  const response = await fetch(`${API_BASE}/by-project/${projectName}/create-pr`, { method: 'POST' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || 'Failed to create PR')
  return data
}

export interface MarkDodResult {
  ok: true
  jobId: string
  issueNumber: number
  verified: number
  total: number
  changed: boolean
}

// Trigger DoD verification for a specific issue or PR. The IssuesTab DoD
// badge calls this with the explicit context it already has from GitHub —
// avoids the implicit "latest run with ghIssueNumber" lookup that fails for
// PRs created outside the issue-driven flow.
export async function runMarkDod(
  projectName: string,
  ctx: { issue_number?: number; pr_number?: number; repo: string },
): Promise<MarkDodResult> {
  const response = await fetch(`${API_BASE}/by-project/${projectName}/mark-dod`, {
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
  const response = await fetch(`${API_BASE}/by-project/${projectName}/changes`, {
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

export interface ChangeDiffResponse {
  diff: string
  untracked: boolean
}

export async function fetchChangeDiff(projectName: string, filename: string): Promise<ChangeDiffResponse> {
  const response = await fetch(
    `${API_BASE}/by-project/${projectName}/changes/diff?file=${encodeURIComponent(filename)}`
  )
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || `Failed to fetch diff: ${response.statusText}`)
  }
  return response.json()
}

// Project Config API
export interface ProjectConfig {
  project: string
  test_command: string
  detected_test_command: string
  effective_test_command: string
  test_cron_enabled: boolean
  test_cron_schedule: string
  auto_commit_enabled?: boolean
  auto_push_enabled?: boolean
  auto_pr_merge_enabled?: boolean
  release_after_run?: boolean
  pr_workflow_enabled?: boolean
  issue_auto_branch?: boolean
  tests_disabled?: boolean
  review_disabled?: boolean
  last_push_error?: string | null
  last_push_at?: number | null
}

export async function fetchProjectConfig(projectName: string): Promise<ProjectConfig> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/config`)
  if (!response.ok) {
    throw new Error(`Failed to fetch project config: ${response.statusText}`)
  }
  return response.json()
}

export async function updateProjectConfig(
  projectName: string,
  config: {
    test_command?: string
    test_cron_enabled?: boolean
    test_cron_schedule?: string
    auto_commit_enabled?: boolean
    auto_push_enabled?: boolean
    auto_pr_merge_enabled?: boolean
    release_after_run?: boolean
    pr_workflow_enabled?: boolean
    issue_auto_branch?: boolean
    tests_disabled?: boolean
    review_disabled?: boolean
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

// Jobs API
const JOBS_BASE = '/api/jobs'

export interface JobInfo {
  id: string
  project: string
  kind: string
  prompt: string | null
  pid: number
  log_path: string
  status: 'running' | 'done'
  exit_code: number | null
  started_at: number
  finished_at: number | null
  seen: boolean
  log?: string
  verdict?: 'LGTM' | 'NEEDS ATTENTION' | 'DO NOT SHIP'
  duration_ms?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_tokens?: number | null
  cache_create_tokens?: number | null
  session_id?: string | null
  user_prompt?: string | null
  context_meta?: string | null
  log_pruned?: boolean | null
  cost_usd?: number | null
  model?: string | null
}

export async function fetchJobs(project?: string): Promise<{ jobs: JobInfo[] }> {
  const url = project ? `${JOBS_BASE}?project=${encodeURIComponent(project)}` : JOBS_BASE
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch jobs: ${response.statusText}`)
  }
  return response.json()
}

export async function fetchNotifications(): Promise<{ count: number; jobs: JobInfo[]; runningCount: number; runningJobs: JobInfo[] }> {
  const response = await fetch(`${JOBS_BASE}/notifications`)
  if (!response.ok) {
    throw new Error(`Failed to fetch notifications: ${response.statusText}`)
  }
  return response.json()
}

export async function markJobSeen(jobId: string): Promise<{ status: string }> {
  const response = await fetch(`${JOBS_BASE}/${jobId}/seen`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`Failed to mark seen: ${response.statusText}`)
  }
  return response.json()
}

export async function markNotificationsSeen(): Promise<{ status: string }> {
  const response = await fetch(`${JOBS_BASE}/notifications/mark-seen`, {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`Failed to mark seen: ${response.statusText}`)
  }
  return response.json()
}

// Custom Actions
export interface CustomAction {
  name: string
  command: string
  color?: string
}

export async function fetchCustomActions(projectName: string): Promise<{ actions: CustomAction[] }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/action`)
  if (!response.ok) return { actions: [] }
  return response.json()
}

export async function saveCustomActions(projectName: string, actions: CustomAction[]): Promise<{ status: string; actions: CustomAction[] }> {
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

// Skills
export interface Skill {
  id: string
  name: string
  description: string
  content: string
  createdAt: number
  updatedAt: number
}

export async function fetchSkills(): Promise<{ skills: Skill[] }> {
  const response = await fetch('/api/skills')
  if (!response.ok) return { skills: [] }
  return response.json()
}

export async function createSkill(skill: { name: string; description: string; content: string }): Promise<{ skill: Skill }> {
  const response = await fetch('/api/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(skill),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to create skill')
  }
  return response.json()
}

export async function updateSkill(skillId: string, updates: Partial<{ name: string; description: string; content: string }>): Promise<{ skill: Skill }> {
  const response = await fetch(`/api/skills/${skillId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to update skill')
  }
  return response.json()
}

export async function deleteSkill(skillId: string): Promise<void> {
  const response = await fetch(`/api/skills/${skillId}`, { method: 'DELETE' })
  if (!response.ok) throw new Error('Failed to delete skill')
}

// Agents
export interface Agent {
  id: string
  name: string
  project: string
  skillIds: string[]
  model: string
  prompt: string
  schedule: string | null
  runner: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export async function fetchAgents(project?: string): Promise<{ agents: Agent[] }> {
  const url = project ? `/api/agents?project=${encodeURIComponent(project)}` : '/api/agents'
  const response = await fetch(url)
  if (!response.ok) return { agents: [] }
  const data = await response.json()
  return { agents: data.agents }
}

export async function createAgent(agent: { name: string; project: string; skillIds: string[]; model: string; prompt?: string; schedule?: string | null; runner?: string; enabled?: boolean }): Promise<{ agent: Agent }> {
  const response = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agent),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to create agent')
  }
  return response.json()
}

export async function updateAgent(agentId: string, updates: Partial<{ name: string; skillIds: string[]; model: string; prompt: string; schedule: string | null; runner: string; enabled: boolean }>): Promise<{ agent: Agent }> {
  const response = await fetch(`/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to update agent')
  }
  return response.json()
}

export async function deleteAgent(agentId: string): Promise<void> {
  const response = await fetch(`/api/agents/${agentId}`, { method: 'DELETE' })
  if (!response.ok) throw new Error('Failed to delete agent')
}

export async function runAgent(agentId: string, prompt: string): Promise<{ status: string; job_id: string; pid: number }> {
  const response = await fetch(`/api/agents/${agentId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to run agent')
  }
  return response.json()
}

export interface ProjectDoc {
  name: string
  path: string
  content: string
}

export async function fetchProjectDocs(projectName: string): Promise<{ docs: ProjectDoc[] }> {
  const response = await fetch(`${API_BASE}/by-project/${encodeURIComponent(projectName)}/docs`)
  if (!response.ok) throw new Error('Failed to fetch docs')
  return response.json()
}

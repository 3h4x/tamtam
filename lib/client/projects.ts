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
  MarkDodResult,
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

export async function fetchPersonas(): Promise<{ personas: Persona[] }> {
  const response = await fetch(`${API_BASE}/personas`)
  if (!response.ok) {
    throw new Error(`Failed to fetch personas: ${response.statusText}`)
  }
  return response.json()
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

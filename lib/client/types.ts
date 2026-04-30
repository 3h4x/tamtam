export type { Task, ProjectsResponse } from '@/lib/shared/types'

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

export interface Persona {
  path: string
  category: string
  name: string
  description: string
  emoji: string
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

export interface LogEntry {
  filename: string
  content: string
}

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

export interface ChangeDiffResponse {
  diff: string
  untracked: boolean
}

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
  file_config?: string[]
  file_config_branch?: string
  file_config_is_default_branch?: boolean
  current_branch?: string
}

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
  release_id?: string | null
  parent_job_id?: string | null
}

export interface CustomAction {
  name: string
  command: string
  color?: string
}

export interface Skill {
  id: string
  name: string
  description: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface Agent {
  id: string
  name: string
  project: string
  skillIds: string[]
  docPaths: string[]
  model: string
  prompt: string
  schedule: string | null
  runner: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  source?: 'db' | 'file'
}

export interface ProjectDoc {
  name: string
  path: string
  content: string
}

export interface MarkDodResult {
  ok: true
  jobId: string
  issueNumber: number
  verified: number
  total: number
  changed: boolean
}

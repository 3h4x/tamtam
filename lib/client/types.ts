export type { Task, ProjectsResponse } from '@/lib/shared/types'
export type { PrGates, GateState } from '@/lib/github/issue-row-enrichment'
import type { PrGates } from '@/lib/github/issue-row-enrichment'

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
  // Folded in by the issues route so the Issues tab renders PR gate badges
  // without a per-row `pr-gates` request. Absent on payloads from older callers.
  gates?: PrGates | null
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
  // Folded in by the issues route: whether a resumable provider session exists
  // for this issue, driving the "Continue" vs "Work on" badge without a per-row
  // `continue-issue` request. Absent on payloads from older callers.
  hasContext?: boolean
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
  provider?: string
  permissionMode?: string
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
  release_timeout_minutes?: number | null
  detected_test_command: string
  effective_test_command: string
  test_cron_enabled: boolean
  test_cron_schedule: string
  auto_commit_enabled?: boolean
  auto_push_enabled?: boolean
  auto_pr_merge_enabled?: boolean
  post_merge_watch_minutes?: number
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
  daily_spend_cap_usd?: number | null
  release_spend_cap_usd?: number | null
  last_24h_spend_usd?: number
  setup_complete?: boolean
  setup_state?: ProjectSetupState
  paused?: boolean
  last_push_error?: string | null
  last_push_at?: number | null
  file_config?: string[]
  file_config_branch?: string
  file_config_is_default_branch?: boolean
  current_branch?: string
}

export type ProjectSetupStep =
  | 'detect'
  | 'pipeline'
  | 'automation'
  | 'notifications'
  | 'file_config'
  | 'smoke_test'

export type ProjectSetupState = Partial<Record<ProjectSetupStep, 'completed' | 'skipped'>>

export interface ProjectSetupStatus {
  project: string
  setup_complete: boolean
  setup_state: ProjectSetupState
  detection: {
    test_command: string
    default_branch: string
    github_remote: string | null
    github_repo: string | null
    gh_auth: { available: boolean; detail: string | null }
    ci_workflow: boolean
  }
}

export interface JobInfo {
  id: string
  project: string
  kind: string
  prompt: string | null
  pid: number
  log_path: string
  status: 'running' | 'done' | 'aborted'
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
  work_summary?: string | null
  detail?: string | null
  modified_files?: string | null
  provider?: string | null
  prompt_bytes?: number | null
  // On running release rows, the originating agent's kind (e.g.
  // "agent:improve"). Lets a UI client render the workflow as one unit
  // rather than "release" wrapping the agent's work.
  parent_kind?: string | null
}

export interface PipelineDurationStats {
  avg: number
  median: number
  p95: number
  count: number
  avgCostUsd?: number | null
}

export interface ProjectPipelineStats {
  window: '24h' | '7d' | '30d' | 'all'
  generatedAt: number
  project: string | null
  pipelineSuccess: {
    succeeded: number
    failed: number
    total: number
    rate: number
  }
  fixLoop: {
    total: number
    converged: number
    hitCap: number
    avgIterations: number
  }
  stepDurations: Record<string, PipelineDurationStats>
  mttr: PipelineDurationStats | null
}

export interface ModifiedFileSummary {
  path: string
  status: string
  summary?: string
  confidence?: 'high' | 'low'
}

export interface Recommendation {
  id: string
  project: string
  source_kind: string
  source_id: string | null
  agent_id: string | null
  agent_name: string | null
  type: string
  title: string
  detail: string
  // 'resolved' = auto-retired by the orchestrator when the condition cleared;
  // 'dismissed' / 'applied' = operator actions. Non-open rows appear in History.
  status: 'open' | 'dismissed' | 'applied' | 'resolved'
  payload: Record<string, unknown> | null
  created_at: number
  updated_at: number
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

export interface SkillRevision {
  id: number
  entityId: string
  snapshot: string
  parsedSnapshot: Skill | null
  author: string
  note: string | null
  createdAt: number
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
  enabled: boolean
  /** When false, the orchestrator skips this agent for *boost* fires — it
   *  still runs on its own `schedule`. Default true. */
  boostable?: boolean
  provider?: string | null
  fallbackEnabled?: boolean
  prerequisiteCommand?: string | null
  /** Per-agent permission-mode override. null/absent → inherit the global
   *  `permission_mode` setting. One of VALID_PERMISSION_MODES otherwise. */
  permissionMode?: string | null
  createdAt: number
  updatedAt: number
  source?: 'db' | 'file'
  // 'user' for normal user-defined agents, 'system' for built-in
  // auto-seeded agents that dispatch to internal handlers. File agents
  // omit this field — treat undefined as 'user' at the consumer.
  kind?: 'user' | 'system'
  // Live cron queue state — `nextFireMs` is the actual `run_at` from the
  // graphile-worker `agent-cron-<id>` row, not a UI estimate. Absent when
  // the agent has no queued cron row (disabled, or seed hasn't run yet).
  cron?: {
    nextFireMs: number
    attempts: number
    isAvailable: boolean
    lockedAt: number | null
    lastError: string | null
  } | null
  // Most recent cron fire outcome — populated by the in-process cron task
  // every time it dispatches/skips/queues this agent. Lets the UI render
  // "Skipped 14m ago (jobs paused)" instead of stale "due now".
  lastAttempt?: {
    at: number
    reason: string
    status: 'skipped' | 'dispatched' | 'queued' | string
  } | null
}

export interface AgentRevision {
  id: number
  entityId: string
  snapshot: string
  parsedSnapshot: Agent | null
  author: string
  note: string | null
  createdAt: number
}

export interface ProjectDoc {
  name: string
  path: string
  content: string
  /** Keywords from .tamtam auto_attach_docs rules that inject this doc into
      agent prompts. Empty when the doc isn't wired into auto-attach. */
  autoAttachKeywords?: string[]
}

export interface MarkDodResult {
  ok: true
  jobId: string
  issueNumber: number
  verified: number
  total: number
  changed: boolean
}

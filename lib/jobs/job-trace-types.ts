// Wire types for GET /api/jobs/[jobId]/trace — the full story of one work unit
// (an agent run, a release, or a manual chat) assembled by buildJobTrace().
// Kept free of server imports so client components can import the types.

export type JobRunStatus = 'running' | 'done' | 'aborted'

export interface JobTraceStep {
  job_id: string
  kind: string
  status: JobRunStatus
  exit_code: number | null
  started_at: number
  finished_at: number | null
  duration_ms: number | null
  verdict: string | null
  log_excerpt: string
}

export interface JobTraceTrigger {
  job_id: string
  kind: string
  label: string
  prompt: string | null
}

export interface JobTraceFiles {
  files: string[]
  linesAdded: number | null
  linesRemoved: number | null
}

export interface JobTraceUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  costUsd: number
  promptBytes: number | null
  model: string | null
  provider: string | null
}

export interface JobTraceContext {
  skills: string[]
  releaseStopReason: string | null
  outcomeVerdict: string | null
  followupIssueUrl: string | null
  followupIssueNumber: number | null
  runScore: number | null
}

export interface JobTrace {
  job_id: string
  project: string
  kind: string
  prompt: string | null
  status: JobRunStatus
  exit_code: number | null
  started_at: number
  finished_at: number | null
  duration_ms: number | null
  verdict: string | null
  session_id: string | null
  /** The release this unit is, or owns/belongs to (its pipeline steps). */
  release_id: string | null
  trigger: JobTraceTrigger | null
  steps: JobTraceStep[]
  workSummary: string | null
  files: JobTraceFiles
  usage: JobTraceUsage
  context: JobTraceContext
  /** Tail of the unit's own log (for non-pipeline units). */
  logExcerpt: string | null
  logPruned: boolean
}

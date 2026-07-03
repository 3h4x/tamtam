import type { JobInfo } from '@/lib/client-api'
import type { KindBucket } from '@/components/project-runs/kinds'

export type OutcomeVerdict = 'done' | 'needs_continue' | 'asked_question'

// An entry represents a single row in the history. For `run` jobs with a
// session_id we collapse every turn of the conversation into one entry so the
// list reads as "conversations" rather than dozens of identical chat rows.
// For `release` jobs, `children` is populated by groupReleaseChildren with
// the pipeline steps (test/review/fix/commit/push/…) that ran inside the
// release's time window.
export interface Entry {
  key: string
  project: string
  kind: string
  bucket: KindBucket
  title: string
  subtitle: string | null
  detail?: string | null
  startedAt: number
  lastActivityAt: number
  finishedAt: number | null
  status: 'running' | 'done' | 'aborted'
  exitCode: number | null
  durationMs: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
  turns: number
  model: string | null
  navJobId: string
  navSessionId: string | null
  releaseId: string | null
  verdict?: JobInfo['verdict']
  failureLabel?: string | null
  releaseOutcome?: ReleaseOutcome | null
  logPruned: boolean
  workSummary: string | null
  modifiedFiles: string | null
  // Bytes of the prompt actually piped to the provider CLI for this job (or
  // the max across merged turns / clustered children). Used to flag bloated
  // prompts in the runs list — every cache-read of an oversized prefix is
  // billed.
  promptBytes?: number | null
  // Flat list of every pipeline child that ran inside this release's time
  // window — used by `buildReleaseSummary` for the one-line "test ✓ · review
  // LGTM · …" recap on the collapsed parent row.
  children?: Entry[]
  // Tree of children built from `parent_job_id` so the expanded release row
  // can render the actual recovery chain (test → review → fix → review →
  // commit → push). Only populated for `kind === 'release'` entries; the
  // other entries reachable through this tree are the same Entry instances
  // present in `children`, but each non-root carries its direct parent's
  // edge instead of being a flat sibling.
  chainedChildren?: Entry[]
  // Individual conversational turns that were collapsed into this entry.
  // Only set on multi-turn chat/agent rows so the expanded view can break
  // out cost-per-turn instead of just showing the aggregate.
  turnEntries?: Entry[]
  parentJobId: string | null
  parentLabel: string | null
  // Verdict from the local-LLM outcome classifier (see lib/jobs/outcome-classifier.ts).
  // Populated on finished `run`/`agent:*` jobs when classification is enabled.
  // Drives Continue button visibility on otherwise-successful runs.
  outcomeVerdict?: OutcomeVerdict | null
  // When a review verdict was DO NOT SHIP / NEEDS-ATTENTION-exhausted and
  // the orchestrator filed a follow-up GitHub issue, these carry the audit
  // link so the History row can show "→ filed #N".
  followupIssueUrl?: string | null
  followupIssueNumber?: number | null
  // Set on release entries when the orchestrator recorded a stop reason in
  // context_meta (e.g. "review startup failed: prereq command exited 1").
  // Used as a fallback summary when no child job failure provides one.
  releaseStopReason?: string | null
  // Every original job id that collapsed into this entry (session-grouped
  // turns share an entry). Used by `groupReleaseChildren` to resolve
  // `parent_job_id` edges when the parent might itself be a multi-turn
  // entry. Internal — callers shouldn't read this directly.
  _jobIds?: string[]
}

export type ReleaseOutcomeStatus = 'queued' | 'blocked' | 'running' | 'failed' | 'done'

export interface ReleaseOutcome {
  status: ReleaseOutcomeStatus
  label: string
  releaseJobId: string
  blockingJobId?: string | null
  // Human-readable reason a non-done release stopped (the orchestrator's
  // recorded stop reason, or the latest failed child's summary). Set on
  // failed/blocked outcomes so the owning agent/run row can explain WHY the
  // release-after-run failed instead of just flipping to a bare "failed".
  reason?: string | null
}

import type { JobInfo } from '@/lib/client-api'
import { costUsd as computeCost } from '@/lib/shared/usage-pricing'
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes'

export function formatDuration(startedAt: number, finishedAt: number | null): string {
  const end = finishedAt || Date.now() / 1000
  const s = Math.max(0, Math.floor(end - startedAt))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function dayKey(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function dayLabel(ts: number): string {
  const now = new Date()
  const d = new Date(ts * 1000)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.round((today.getTime() - that.getTime()) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000000).toFixed(1)}M`
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export interface JobCountsResponse {
  total: number
  byKind: Record<string, number>
  byStatus: { running: number; done: number; aborted: number; failed: number }
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number; total: number }
  cost: { total: number; monthToDate: number }
}

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const numberProp = (value: unknown, key: string): number => {
  if (!value || typeof value !== 'object') return 0
  return finiteNumber((value as Record<string, unknown>)[key]) ?? 0
}

export function parseJobCountsResponse(value: unknown): JobCountsResponse | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const total = finiteNumber(raw.total)
  if (total == null) return null

  const rawByKind = raw.byKind && typeof raw.byKind === 'object'
    ? raw.byKind as Record<string, unknown>
    : {}
  const byKind: Record<string, number> = {}
  for (const [kind, count] of Object.entries(rawByKind)) {
    const n = finiteNumber(count)
    if (n != null) byKind[kind] = n
  }

  return {
    total,
    byKind,
    byStatus: {
      running: numberProp(raw.byStatus, 'running'),
      done: numberProp(raw.byStatus, 'done'),
      aborted: numberProp(raw.byStatus, 'aborted'),
      failed: numberProp(raw.byStatus, 'failed'),
    },
    tokens: {
      input: numberProp(raw.tokens, 'input'),
      output: numberProp(raw.tokens, 'output'),
      cacheRead: numberProp(raw.tokens, 'cacheRead'),
      cacheCreate: numberProp(raw.tokens, 'cacheCreate'),
      total: numberProp(raw.tokens, 'total'),
    },
    cost: {
      total: numberProp(raw.cost, 'total'),
      monthToDate: numberProp(raw.cost, 'monthToDate'),
    },
  }
}

export function jobCost(j: JobInfo): number {
  if (j.cost_usd != null) return j.cost_usd
  return computeCost({
    inputTokens: j.input_tokens ?? 0,
    outputTokens: j.output_tokens ?? 0,
    cacheReadTokens: j.cache_read_tokens ?? 0,
    cacheCreateTokens: j.cache_create_tokens ?? 0,
  })
}

// Bucket kinds for filtering + labeling. Anything that doesn't match lands in
// "other" (covers custom actions, future kinds).
export type KindBucket =
  | 'run'
  | 'release'
  | 'review'
  | 'test'
  | 'fix'
  | 'fix-ci'
  | 'commit'
  | 'push'
  | 'mark-dod'
  | 'pr-wait'
  | 'soak'
  | 'agent'
  | 'other'

export const ACTIVE_WORK_BUCKET_ORDER: KindBucket[] = [
  'run',
  'release',
  'review',
  'test',
  'fix',
  'fix-ci',
  'commit',
  'push',
  'mark-dod',
  'pr-wait',
  'soak',
  'agent',
  'other',
]

export function bucketOf(kind: string): KindBucket {
  if (kind === 'run') return 'run'
  if (kind === 'release') return 'release'
  if (kind === 'review') return 'review'
  if (kind === 'test') return 'test'
  if (kind === 'fix') return 'fix'
  if (kind === 'fix-ci') return 'fix-ci'
  if (kind === 'commit') return 'commit'
  if (kind === 'push') return 'push'
  if (kind === 'mark-dod') return 'mark-dod'
  if (kind === 'pr-wait') return 'pr-wait'
  if (kind === 'soak') return 'soak'
  if (kind.startsWith('agent:')) return 'agent'
  return 'other'
}

export const KIND_LABEL: Record<KindBucket, string> = {
  run: 'chat',
  release: 'release',
  review: 'review',
  test: 'test',
  fix: 'fix',
  'fix-ci': 'fix-ci',
  commit: 'commit',
  push: 'push',
  'mark-dod': 'dod',
  'pr-wait': 'pr-wait',
  soak: 'soak',
  agent: 'agent',
  other: 'action',
}

export const KIND_COLOR: Record<KindBucket, string> = {
  run: 'bg-accent/15 text-accent',
  release: 'bg-accent/20 text-accent border border-accent/40',
  review: 'bg-status-info/15 text-status-info',
  test: 'bg-status-success/15 text-status-success',
  fix: 'bg-status-warning/15 text-status-warning',
  'fix-ci': 'bg-status-warning/15 text-status-warning',
  commit: 'bg-status-success/15 text-status-success',
  push: 'bg-status-success/15 text-status-success',
  'mark-dod': 'bg-status-info/15 text-status-info',
  'pr-wait': 'bg-status-info/15 text-status-info',
  soak: 'bg-status-info/15 text-status-info',
  agent: 'bg-bg-tertiary text-text-secondary border border-border',
  other: 'bg-text-tertiary/15 text-text-secondary',
}

export function activeWorkBadgeLabel(kindOrBucket: string): string {
  if (kindOrBucket in KIND_LABEL) return KIND_LABEL[kindOrBucket as KindBucket]
  return KIND_LABEL[bucketOf(kindOrBucket)]
}

export function runKindDisplayName(kindOrBucket: string): string {
  const bucket = kindOrBucket in KIND_LABEL ? kindOrBucket as KindBucket : bucketOf(kindOrBucket)
  if (bucket === 'run') return 'Chat'
  if (bucket === 'release') return 'Release pipeline'
  if (bucket === 'review') return 'Code review'
  if (bucket === 'test') return 'Test run'
  if (bucket === 'fix') return 'Auto-fix'
  if (bucket === 'fix-ci') return 'Fix CI'
  if (bucket === 'commit') return 'Commit'
  if (bucket === 'push') return 'Push'
  if (bucket === 'mark-dod') return 'Mark DoD'
  if (bucket === 'pr-wait') return 'PR wait'
  if (bucket === 'soak') return 'Soak'
  if (bucket === 'agent') return 'Agent'
  return 'Action'
}

export function shouldShowStableKindTitle(entry: Pick<Entry, 'bucket' | 'kind' | 'title'>): boolean {
  if (entry.bucket === 'run' || entry.bucket === 'agent') return false

  const stableKindTitle = runKindDisplayName(entry.kind)
  if (stableKindTitle === entry.title) return false

  // These titles already carry their category and detail in one phrase. A
  // separate stable prefix would read as "Mark DoD Mark DoD - ..." or
  // "Release pipeline Pipeline steps".
  if (entry.bucket === 'mark-dod') return false
  if (entry.bucket === 'release' && entry.title === 'Pipeline steps') return false

  return true
}

export function activeWorkAccentClass(kind: string): string {
  const bucket = bucketOf(kind)
  if (bucket === 'run' || bucket === 'release') return 'border-l-accent'
  if (bucket === 'review' || bucket === 'mark-dod' || bucket === 'pr-wait' || bucket === 'soak') return 'border-l-status-info'
  if (bucket === 'test' || bucket === 'commit' || bucket === 'push') return 'border-l-status-success'
  if (bucket === 'fix' || bucket === 'fix-ci') return 'border-l-status-warning'
  return 'border-l-border'
}

export function activeWorkTitle(job: JobInfo): string {
  const bucket = bucketOf(job.kind)
  if (bucket === 'run') return 'chat'
  if (
    bucket === 'fix-ci'
    || bucket === 'mark-dod'
    || bucket === 'test'
    || bucket === 'review'
    || bucket === 'fix'
    || bucket === 'commit'
    || bucket === 'push'
    || bucket === 'pr-wait'
    || bucket === 'soak'
  ) {
    return runKindDisplayName(bucket)
  }
  return titleForJob(job, bucket)
}

// Kinds that belong to a release pipeline. When a `release` meta-job is
// active, any of these jobs started inside its [started_at, finished_at]
// window is considered a child of that release in the History UI.
// Note: `fix-ci` is intentionally absent — it is not a scheduled release-chain
// step, so the UI shows it as a top-level row rather than nesting it under a
// release card. It IS included in PIPELINE_LIKE in the notifications route so
// that a terminal release success can supersede an older fix-ci failure.
export const PIPELINE_CHILD_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'mark-dod', 'pr-wait', 'soak'])

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
}

function childTerminallyStopsRunningRelease(entry: Entry): boolean {
  if (entry.status === 'aborted' || isCancelledExitCode(entry.exitCode)) return true

  // These verification steps can legitimately sit failed/attention-needed
  // while the orchestrator is between the failed step and the fix/retry child.
  if (entry.kind === 'test' || entry.kind === 'review' || entry.kind === 'commit' || entry.kind === 'push') {
    return false
  }

  return entry.status === 'done' && entry.exitCode !== null && entry.exitCode !== 0
}

function deriveReleaseState(rel: Entry, children: Entry[]): Pick<Entry, 'status' | 'finishedAt' | 'exitCode' | 'failureLabel'> {
  if (rel.status !== 'running' || children.length === 0) {
    const failureLabel = rel.status === 'aborted'
      ? 'release cancelled'
      : rel.status === 'done' && rel.exitCode !== null && rel.exitCode !== 0
      ? children.length === 0 ? 'release blocked' : 'release failed'
      : rel.failureLabel
    return {
      status: rel.status,
      finishedAt: rel.finishedAt,
      exitCode: rel.exitCode,
      failureLabel,
    }
  }

  const sorted = sortPipelineEntriesByActivity(children)
  const runningChild = [...sorted].reverse().find((child) => child.status === 'running')
  if (runningChild) {
    return {
      status: rel.status,
      finishedAt: rel.finishedAt,
      exitCode: rel.exitCode,
      failureLabel: rel.failureLabel,
    }
  }

  const last = sorted[sorted.length - 1]
  if (!last || !childTerminallyStopsRunningRelease(last)) {
    return {
      status: rel.status,
      finishedAt: rel.finishedAt,
      exitCode: rel.exitCode,
      failureLabel: rel.failureLabel,
    }
  }

  if (last.status === 'aborted' || isCancelledExitCode(last.exitCode)) {
    return {
      status: 'aborted',
      finishedAt: last.finishedAt ?? last.lastActivityAt,
      exitCode: last.exitCode ?? -3,
      failureLabel: 'release cancelled',
    }
  }

  return {
    status: 'done',
    finishedAt: last.finishedAt ?? last.lastActivityAt,
    exitCode: last.exitCode ?? rel.exitCode ?? 1,
    failureLabel: 'release failed',
  }
}

function releaseOutcomeFor(rel: Entry): ReleaseOutcome {
  if (rel.status === 'running') {
    return { status: 'running', label: 'release running', releaseJobId: rel.navJobId }
  }
  if (rel.status === 'aborted') {
    return { status: 'failed', label: 'release cancelled', releaseJobId: rel.navJobId }
  }
  if (rel.exitCode === 0) {
    return { status: 'done', label: 'release done', releaseJobId: rel.navJobId }
  }
  if ((rel.children?.length ?? 0) === 0) {
    return { status: 'blocked', label: 'release blocked', releaseJobId: rel.navJobId }
  }
  return { status: 'failed', label: 'release failed', releaseJobId: rel.navJobId }
}

function reviewNeedsAttention(e: Entry): boolean {
  return e.kind === 'review' && e.verdict !== undefined && e.verdict !== null && e.verdict !== 'LGTM'
}

function nonTerminalRecoveryStep(e: Entry): boolean {
  return e.kind === 'fix'
}

function advisoryNonTerminalStep(e: Entry): boolean {
  return e.kind === 'mark-dod'
}

function virtualGroupAttentionState(cluster: Entry[]): { exitCode: number; failureLabel: string } | null {
  if (cluster.length === 0) return null
  const last = cluster[cluster.length - 1]
  if (last.status === 'aborted') {
    return { exitCode: last.exitCode ?? -3, failureLabel: 'pipeline cancelled' }
  }
  if (last.exitCode !== null && last.exitCode !== 0) {
    return { exitCode: last.exitCode, failureLabel: 'pipeline failed' }
  }
  if (reviewNeedsAttention(last)) {
    return { exitCode: 1, failureLabel: 'review needs attention' }
  }
  if (nonTerminalRecoveryStep(last)) {
    return { exitCode: 1, failureLabel: 'follow-up pending' }
  }
  if (advisoryNonTerminalStep(last)) {
    return { exitCode: 1, failureLabel: 'follow-up pending' }
  }
  if (last.kind === 'review' && last.verdict !== 'LGTM') {
    return { exitCode: 1, failureLabel: 'review verdict missing' }
  }
  return null
}

function virtualGroupStatus(cluster: Entry[]): 'running' | 'done' | 'aborted' {
  if (cluster.some((entry) => entry.status === 'running')) return 'running'
  const last = cluster[cluster.length - 1]
  return last?.status === 'aborted' ? 'aborted' : 'done'
}

export function entryIsRunning(e: Entry): boolean {
  return e.status === 'running' || e.releaseOutcome?.status === 'running'
}

export function entryNeedsAttention(e: Entry): boolean {
  if (e.status === 'aborted') return true
  if (e.status === 'done' && e.exitCode !== null && e.exitCode !== 0) return true
  if (reviewNeedsAttention(e)) return true
  if (e.kind === 'review' && e.status === 'done' && e.verdict == null) return true
  return e.releaseOutcome?.status === 'blocked' || e.releaseOutcome?.status === 'failed'
}

export function latestReleaseKey(entries: Entry[]): string | null {
  let bestKey: string | null = null
  let bestStartedAt = Number.NEGATIVE_INFINITY
  const walk = (nodes: Entry[]) => {
    for (const e of nodes) {
      if (e.kind === 'release' && e.startedAt > bestStartedAt) {
        bestKey = e.key
        bestStartedAt = e.startedAt
      }
      if (e.chainedChildren && e.chainedChildren.length > 0) {
        walk(e.chainedChildren)
      }
    }
  }
  walk(entries)
  return bestKey
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function reviewVerdictTitle(verdict: string): string {
  if (verdict === 'LGTM') return '✓ LGTM — looks good to ship'
  if (verdict === 'DO NOT SHIP') return '✗ Do not ship'
  return '⚠ Needs attention'
}

// Pipeline-step rows are already tagged by the [kind] pill, so a static
// "Test run" / "Code review" title just repeats it. Use the title slot to
// say what the step actually did — pass/fail, verdict, what was committed or
// pushed, what the fix changed — preferring the captured work_summary and
// falling back to a derived status (or the kind label while the step is still
// running, or when nothing was captured).
function titleForJob(job: JobInfo, bucket: KindBucket): string {
  const prompt = job.user_prompt || job.prompt
  if (bucket === 'run') return prompt ? truncate(prompt, 140) : '(empty prompt)'
  if (bucket === 'agent') return job.kind.replace(/^agent:/, '') || 'agent'
  if (bucket === 'release') return 'Release pipeline'

  const running = job.status === 'running'
  const summary = job.work_summary?.trim()

  if (bucket === 'test') {
    if (running) return 'Running tests…'
    if (summary) return truncate(summary, 140)
    if (job.status === 'aborted' || isCancelledExitCode(job.exit_code)) return 'Tests cancelled'
    return job.exit_code === 0 ? '✅ Tests passed' : '❌ Tests failed'
  }
  if (bucket === 'review') {
    if (running) return 'Reviewing changes…'
    if (summary) return truncate(summary, 140)
    if (job.verdict) return reviewVerdictTitle(job.verdict)
    return 'Code review'
  }
  if (bucket === 'fix' || bucket === 'fix-ci') {
    if (running) return bucket === 'fix-ci' ? 'Fixing CI…' : 'Applying fixes…'
    if (summary) return truncate(summary, 140)
    return bucket === 'fix-ci' ? 'Fix CI' : 'Auto-fix'
  }
  if (bucket === 'commit') {
    if (running) return 'Committing…'
    if (summary) return truncate(summary, 140)
    return 'Commit'
  }
  if (bucket === 'push') {
    if (running) return 'Pushing…'
    if (summary) return truncate(summary, 140)
    return 'Push'
  }
  if (bucket === 'mark-dod') {
    try {
      const meta = JSON.parse(job.context_meta ?? '')
      if (typeof meta.total === 'number' && meta.total > 0) {
        const failed = meta.total - (meta.verified ?? 0)
        if (failed === 0) return `Mark DoD — all ${meta.total} ✓`
        return `Mark DoD — ${meta.verified}/${meta.total} ✓, ${failed} unverified`
      }
    } catch {}
    return 'Mark DoD'
  }
  if (bucket === 'pr-wait') return 'PR wait'
  if (bucket === 'soak') return 'Soak'
  return job.kind
}

function subtitleForJob(job: JobInfo, bucket: KindBucket): string | null {
  if (bucket === 'review' && job.verdict) return null
  if ((bucket === 'review' || bucket === 'test' || bucket === 'fix-ci') && job.prompt) {
    return truncate(job.prompt, 140)
  }
  return null
}

function modelFromContext(ctx: string | null | undefined): string | null {
  if (!ctx) return null
  try {
    const m = JSON.parse(ctx)
    return typeof m.model === 'string' ? m.model : null
  } catch { return null }
}

export type OutcomeVerdict = 'done' | 'needs_continue' | 'asked_question'

export function outcomeVerdictFromContext(ctx: string | null | undefined): OutcomeVerdict | null {
  if (!ctx) return null
  try {
    const m = JSON.parse(ctx)
    const v = m?.outcomeClassification?.verdict
    if (v === 'done' || v === 'needs_continue' || v === 'asked_question') return v
    return null
  } catch { return null }
}

export function followupIssueFromContext(
  ctx: string | null | undefined,
): { url: string; number: number | null } | null {
  if (!ctx) return null
  try {
    const m = JSON.parse(ctx)
    const url = typeof m?.followupIssueUrl === 'string' ? m.followupIssueUrl : null
    if (!url) return null
    const number = typeof m?.followupIssueNumber === 'number' ? m.followupIssueNumber : null
    return { url, number }
  } catch { return null }
}

function releaseStopReasonFromContext(ctx: string | null | undefined): string | null {
  if (!ctx) return null
  try {
    const m = JSON.parse(ctx)
    return typeof m?.releaseStopReason === 'string' ? m.releaseStopReason : null
  } catch { return null }
}

function parentLabelFor(parentJob: JobInfo | undefined): string | null {
  if (!parentJob) return null
  const bucket = bucketOf(parentJob.kind)
  if (bucket === 'agent') return `agent ${parentJob.kind.replace(/^agent:/, '')}`
  if (bucket === 'release') return 'release'
  return KIND_LABEL[bucket]
}

export function buildEntries(jobs: JobInfo[]): Entry[] {
  // Sort ascending first so session groupings see the earliest prompt first.
  const sorted = [...jobs].sort((a, b) => a.started_at - b.started_at)
  const byId = new Map<string, JobInfo>()
  for (const j of jobs) byId.set(j.id, j)
  const sessionGroup = new Map<string, Entry>()
  const entries: Entry[] = []

  for (const j of sorted) {
    const bucket = bucketOf(j.kind)
    // Two distinct merge rules sharing the session_id grouping mechanism:
    //
    // 1. Conversational jobs (`run` + `agent:*`) merge across kinds — an
    //    agent run that the user follows up on via the terminal becomes
    //    multi-turn on a single Entry, even though one turn is `agent:foo`
    //    and the next is `run`.
    //
    // 2. Pipeline-step jobs (review, fix, fix-ci, commit, push,
    //    mark-dod, pr-wait) only merge with another job of the *same* kind.
    //    A `fix` job that resumes a `review`'s Claude session via
    //    `--resume <sessionId>` shares Claude's conversation memory — but
    //    the user expects them to render as two distinct steps in the
    //    chain, not as "review 2 turns".
    //
    // Release meta-jobs never merge: their aggregate log may contain a
    // child's session_id, and merging would shrink the release window.
    const isConversational = bucket === 'run' || bucket === 'agent'
    const canSessionMerge = !!j.session_id && j.kind !== 'release'
    const sessionKey = canSessionMerge
      ? (isConversational ? `${j.project}:${j.session_id}:conversation` : `${j.project}:${j.session_id}:${j.kind}`)
      : ''
    if (canSessionMerge) {
      const existing = sessionGroup.get(sessionKey)
      if (existing) {
        existing.turns += 1
        existing.lastActivityAt = j.started_at
        existing.finishedAt = j.finished_at
        existing.status = j.status
        existing.exitCode = j.exit_code
        existing.verdict = j.verdict
        existing.durationMs = (existing.durationMs ?? 0) + (j.duration_ms ?? 0)
        existing.inputTokens += j.input_tokens ?? 0
        existing.outputTokens += j.output_tokens ?? 0
        existing.cacheReadTokens += j.cache_read_tokens ?? 0
        existing.promptBytes = Math.max(existing.promptBytes ?? 0, j.prompt_bytes ?? 0) || existing.promptBytes
        existing.costUsd += jobCost(j)
        existing.navJobId = j.id
        existing.workSummary = j.work_summary ?? existing.workSummary
        existing.detail = j.detail ?? existing.detail
        if (!isConversational) {
          existing.title = titleForJob({ ...j, work_summary: existing.workSummary }, bucket)
          existing.subtitle = subtitleForJob(j, bucket)
        }
        existing.modifiedFiles = j.modified_files ?? existing.modifiedFiles
        existing.outcomeVerdict = outcomeVerdictFromContext(j.context_meta)
        const followupIssue = followupIssueFromContext(j.context_meta)
        if (followupIssue) {
          existing.followupIssueUrl = followupIssue.url
          existing.followupIssueNumber = followupIssue.number
        }
        existing._jobIds!.push(j.id)
        // Track this turn as a leaf entry so the expanded view can show
        // per-turn cost. Conversational turns only — pipeline-step merges
        // (review/fix sharing a Claude session via --resume) don't need it
        // because those already render as distinct step rows.
        if (isConversational) {
          const turnEntry = makeTurnEntry(j, bucket, byId)
          existing.turnEntries = [...(existing.turnEntries ?? []), turnEntry]
        }
        continue
      }
    }

    const entry: Entry = {
      // Conversational sessions get a stable `sess:<id>` key so the same
      // entry is reused across turns. Pipeline-step jobs sharing a session
      // (review → fix via --resume) need distinct keys per kind so they
      // don't collide on the same entry.
      key: j.session_id
        ? (isConversational ? `sess:${j.project}:${j.session_id}` : `sess:${j.project}:${j.session_id}:${j.kind}`)
        : `job:${j.id}`,
      project: j.project,
      kind: j.kind,
      bucket,
      title: titleForJob(j, bucket),
      subtitle: subtitleForJob(j, bucket),
      detail: j.detail ?? null,
      startedAt: j.started_at,
      lastActivityAt: j.started_at,
      finishedAt: j.finished_at,
      status: j.status,
      exitCode: j.exit_code,
      durationMs: j.duration_ms ?? null,
      inputTokens: j.input_tokens ?? 0,
      outputTokens: j.output_tokens ?? 0,
      cacheReadTokens: j.cache_read_tokens ?? 0,
      costUsd: jobCost(j),
      turns: 1,
      model: j.model ?? modelFromContext(j.context_meta),
      navJobId: j.id,
      navSessionId: j.session_id ?? null,
      releaseId: j.release_id ?? null,
      verdict: j.verdict,
      failureLabel: null,
      releaseOutcome: null,
      logPruned: !!j.log_pruned,
      workSummary: j.work_summary ?? null,
      modifiedFiles: j.modified_files ?? null,
      promptBytes: j.prompt_bytes ?? null,
      parentJobId: j.parent_job_id ?? null,
      parentLabel: j.parent_job_id ? parentLabelFor(byId.get(j.parent_job_id)) : null,
      outcomeVerdict: outcomeVerdictFromContext(j.context_meta),
      followupIssueUrl: followupIssueFromContext(j.context_meta)?.url ?? null,
      followupIssueNumber: followupIssueFromContext(j.context_meta)?.number ?? null,
      releaseStopReason: releaseStopReasonFromContext(j.context_meta),
      _jobIds: [j.id],
    }
    if (canSessionMerge) {
      sessionGroup.set(sessionKey, entry)
      // Seed the first turn so a session that ends up with only one turn
      // still has it available — multi-turn rows then accumulate from here.
      if (isConversational) entry.turnEntries = [makeTurnEntry(j, bucket, byId)]
    }
    entries.push(entry)
  }

  // Drop single-turn `turnEntries` arrays: there's no rollup to show, and
  // exposing a single child would duplicate the parent row.
  for (const e of entries) {
    if (e.turnEntries && e.turnEntries.length <= 1) e.turnEntries = undefined
  }

  entries.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return entries
}

// Build a leaf entry representing one conversational turn so the chat
// row can expose per-turn cost when expanded. The shape mirrors a regular
// Entry but is never re-grouped — it's a display-only artifact.
function makeTurnEntry(j: JobInfo, bucket: KindBucket, byId: Map<string, JobInfo>): Entry {
  return {
    key: `turn:${j.id}`,
    project: j.project,
    kind: j.kind,
    bucket,
    title: titleForJob(j, bucket),
    subtitle: subtitleForJob(j, bucket),
    detail: j.detail ?? null,
    startedAt: j.started_at,
    lastActivityAt: j.started_at,
    finishedAt: j.finished_at,
    status: j.status,
    exitCode: j.exit_code,
    durationMs: j.duration_ms ?? null,
    inputTokens: j.input_tokens ?? 0,
    outputTokens: j.output_tokens ?? 0,
    cacheReadTokens: j.cache_read_tokens ?? 0,
    costUsd: jobCost(j),
    turns: 1,
    model: j.model ?? modelFromContext(j.context_meta),
    navJobId: j.id,
    navSessionId: j.session_id ?? null,
    releaseId: j.release_id ?? null,
    verdict: j.verdict,
    failureLabel: null,
    releaseOutcome: null,
    logPruned: !!j.log_pruned,
    workSummary: j.work_summary ?? null,
    modifiedFiles: j.modified_files ?? null,
    promptBytes: j.prompt_bytes ?? null,
    parentJobId: j.parent_job_id ?? null,
    parentLabel: j.parent_job_id ? parentLabelFor(byId.get(j.parent_job_id)) : null,
    outcomeVerdict: outcomeVerdictFromContext(j.context_meta),
    followupIssueUrl: followupIssueFromContext(j.context_meta)?.url ?? null,
    followupIssueNumber: followupIssueFromContext(j.context_meta)?.number ?? null,
    _jobIds: [j.id],
  }
}

// Build the parent → child tree for a release's pipeline steps using
// `parent_job_id`. The release's direct children (typically just `test`)
// have `parentJobId === release.navJobId`; subsequent steps point at
// whichever step spawned them (test→review, review→fix, fix→review,
// review→commit, commit→push). Steps whose parent isn't in the same
// release window are attached as roots so nothing is dropped from the
// view — better to render them at depth 1 than hide them entirely.
function buildChain(_release: Entry, kids: Entry[]): Entry[] {
  if (kids.length === 0) return []
  // Build a job-id → child-entry index. A session-grouped entry can absorb
  // multiple jobs (e.g. review turn 1 + review turn 2), so we walk every
  // job id each entry consumed.
  const byJobId = new Map<string, Entry>()
  for (const k of kids) {
    for (const jid of k._jobIds ?? [k.navJobId]) byJobId.set(jid, k)
  }

  // childrenOf: for each entry key, the entries whose parent is that entry.
  // A kid is a "root" of the chain when its parent_job_id either points
  // outside the kids set (e.g. at the release meta-job, an agent run, or
  // anything outside this cluster's window) or isn't set at all. Anything
  // whose parent points at another kid becomes its child.
  const childrenOfKey = new Map<string, Entry[]>()
  const roots: Entry[] = []
  const seen = new Set<string>()
  for (const k of kids) {
    if (seen.has(k.key)) continue
    seen.add(k.key)
    const parentEntry = k.parentJobId ? byJobId.get(k.parentJobId) : null
    if (!parentEntry) {
      roots.push(k)
    } else if (parentEntry.key === k.key) {
      // Self-edge (a session-grouped entry whose first turn is its own
      // parent within the merge). Treat as a root, not an infinite loop.
      roots.push(k)
    } else {
      const arr = childrenOfKey.get(parentEntry.key) ?? []
      arr.push(k)
      childrenOfKey.set(parentEntry.key, arr)
    }
  }

  // Hydrate `chainedChildren` recursively. Sort children by start time at
  // each level so the chain reads forward in time.
  const visited = new Set<string>()
  const hydrate = (node: Entry): Entry => {
    if (visited.has(node.key)) return node // cycle guard
    visited.add(node.key)
    const direct = (childrenOfKey.get(node.key) ?? []).sort((a, b) => a.startedAt - b.startedAt)
    return { ...node, chainedChildren: direct.map(hydrate) }
  }
  return roots.sort((a, b) => a.startedAt - b.startedAt).map(hydrate)
}

// Collapse pipeline children (test/review/fix/commit/push/…) under their
// parent release entry. Current rows use the durable `release_id` link; the
// timestamp window remains only as a fallback for legacy rows written before
// that lineage was persisted.
//
// Exported for unit testing.
export function groupReleaseChildren(entries: Entry[]): Entry[] {
  const releases = entries.filter((e) => e.kind === 'release')
  const releasesByProjectAndId = new Map<string, Entry>()
  for (const release of releases) {
    releasesByProjectAndId.set(`${release.project}:${release.navJobId}`, release)
  }

  // Latest-starting containing release wins (in the pathological case two
  // release windows overlap). Sorted asc so the last assignment wins.
  const sortedReleases = [...releases].sort((a, b) => a.startedAt - b.startedAt)

  const findParentRelease = (child: Entry): Entry | null => {
    if (!PIPELINE_CHILD_KINDS.has(child.kind)) return null
    if (child.releaseId) {
      return releasesByProjectAndId.get(`${child.project}:${child.releaseId}`) ?? null
    }
    let best: Entry | null = null
    for (const r of sortedReleases) {
      const end = r.finishedAt ?? Number.POSITIVE_INFINITY
      if (r.project === child.project && r.startedAt <= child.startedAt && child.startedAt <= end) best = r
    }
    return best
  }

  const childrenByParent = new Map<string, Entry[]>()
  const topLevel: Entry[] = []
  for (const e of entries) {
    if (e.kind === 'release') continue
    const parent = findParentRelease(e)
    if (parent) {
      const arr = childrenByParent.get(parent.key) ?? []
      arr.push(e)
      childrenByParent.set(parent.key, arr)
    } else {
      topLevel.push(e)
    }
  }

  const releasesByKey = new Map<string, Entry>()
  for (const r of releases) {
    const kids = (childrenByParent.get(r.key) ?? []).sort((a, b) => a.startedAt - b.startedAt)
    const derivedState = deriveReleaseState(r, kids)
    // Roll up child usage onto the release row so the parent shows the total
    // of its review/fix/commit/push work — release meta-jobs themselves carry
    // zero direct cost. Children continue to show their individual values, so
    // expanding the row makes the breakdown visible without overwhelming the
    // collapsed view.
    const rolledCostUsd = kids.reduce((s, k) => s + (k.costUsd ?? 0), r.costUsd ?? 0)
    const rolledInput = kids.reduce((s, k) => s + (k.inputTokens ?? 0), r.inputTokens ?? 0)
    const rolledOutput = kids.reduce((s, k) => s + (k.outputTokens ?? 0), r.outputTokens ?? 0)
    const rolledCacheRead = kids.reduce(
      (s, k) => s + (k.cacheReadTokens ?? 0),
      r.cacheReadTokens ?? 0,
    )
    releasesByKey.set(r.key, {
      ...r,
      children: kids,
      chainedChildren: buildChain(r, kids),
      status: derivedState.status,
      finishedAt: derivedState.finishedAt,
      exitCode: derivedState.exitCode,
      failureLabel: derivedState.failureLabel,
      costUsd: rolledCostUsd,
      inputTokens: rolledInput,
      outputTokens: rolledOutput,
      cacheReadTokens: rolledCacheRead,
    })
  }

  // Cluster orphaned pipeline steps (no parent release) that are close in time
  // into virtual groups so they display as one collapsed row instead of many
  // individual entries. This handles pre-aggregator pipeline runs and manual
  // step-by-step invocations.
  const CLUSTER_GAP = 30 * 60 // 30 minutes between steps = same pipeline run
  const pipelineOrphans = topLevel.filter(e => PIPELINE_CHILD_KINDS.has(e.kind))
  const otherTopLevel = topLevel.filter(e => !PIPELINE_CHILD_KINDS.has(e.kind))

  // If a release's parentJobId points at an agent or run in the top-level
  // list, nest the release under that parent so the history reads as one
  // collapsible item instead of two separate rows.
  const topLevelByJobId = new Map<string, Entry>()
  for (const e of otherTopLevel) {
    for (const jid of e._jobIds ?? [e.navJobId]) topLevelByJobId.set(jid, e)
  }
  const agentOwnedReleaseKeys = new Set<string>()
  for (const rel of releasesByKey.values()) {
    if (!rel.parentJobId) continue
    const parentEntry = topLevelByJobId.get(rel.parentJobId)
    if (!parentEntry) continue
    parentEntry.chainedChildren = [...(parentEntry.chainedChildren ?? []), rel]
    parentEntry.releaseOutcome = releaseOutcomeFor(rel)
    // Same rollup as releases-by-key above: when an agent/chat row nests a
    // release as a chained child, add the release's already-rolled-up cost
    // (which itself sums its review/fix/commit/push kids) onto the parent so
    // the collapsed row totals match what users see when they expand.
    parentEntry.costUsd = (parentEntry.costUsd ?? 0) + (rel.costUsd ?? 0)
    parentEntry.inputTokens = (parentEntry.inputTokens ?? 0) + (rel.inputTokens ?? 0)
    parentEntry.outputTokens = (parentEntry.outputTokens ?? 0) + (rel.outputTokens ?? 0)
    parentEntry.cacheReadTokens = (parentEntry.cacheReadTokens ?? 0) + (rel.cacheReadTokens ?? 0)
    // A terminal/agent row that auto-triggered a release is an aggregate from
    // the operator's point of view, but it still has two separate outcomes:
    // the agent/run itself and the release it triggered. Keep the parent
    // job's own exit code intact and expose the release as a separate chip so
    // "agent succeeded, release blocked" is not collapsed into a misleading
    // raw `exit 1`.
    parentEntry.lastActivityAt = Math.max(parentEntry.lastActivityAt, rel.lastActivityAt)
    if (rel.status === 'running') {
      parentEntry.finishedAt = null
    } else if (rel.exitCode !== null && rel.exitCode !== 0) {
      parentEntry.status = 'done'
      parentEntry.finishedAt = rel.finishedAt ?? parentEntry.finishedAt
    } else if (parentEntry.exitCode === 0 && rel.finishedAt) {
      parentEntry.finishedAt = Math.max(parentEntry.finishedAt ?? parentEntry.startedAt, rel.finishedAt)
    }
    agentOwnedReleaseKeys.add(rel.key)
  }

  for (const parentEntry of otherTopLevel) {
    if (!parentEntry.chainedChildren || parentEntry.chainedChildren.length === 0) continue
    const releases = parentEntry.chainedChildren
      .filter((child) => child.kind === 'release')
      .sort((a, b) => {
        if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt
        return b.lastActivityAt - a.lastActivityAt
      })
    if (releases.length === 0) continue
    const nonReleases = parentEntry.chainedChildren.filter((child) => child.kind !== 'release')
    parentEntry.chainedChildren = [...releases, ...nonReleases]
    parentEntry.releaseOutcome = releaseOutcomeFor(releases[0])
  }

  const parents: Entry[] = Array.from(releasesByKey.values()).filter(
    r => !agentOwnedReleaseKeys.has(r.key)
  )
  const clustered: Entry[] = []

  if (pipelineOrphans.length > 0) {
    const orphansByProject = new Map<string, Entry[]>()
    for (const orphan of pipelineOrphans) {
      const arr = orphansByProject.get(orphan.project) ?? []
      arr.push(orphan)
      orphansByProject.set(orphan.project, arr)
    }
    const clusters: Entry[][] = []
    for (const projectOrphans of orphansByProject.values()) {
      const sortedOrphans = [...projectOrphans].sort((a, b) => a.startedAt - b.startedAt)
      const projectClusters: Entry[][] = [[sortedOrphans[0]]]
      for (let i = 1; i < sortedOrphans.length; i++) {
        const prev = sortedOrphans[i - 1]
        const curr = sortedOrphans[i]
        const gap = curr.startedAt - (prev.finishedAt ?? prev.startedAt)
        if (gap <= CLUSTER_GAP) {
          projectClusters[projectClusters.length - 1].push(curr)
        } else {
          projectClusters.push([curr])
        }
      }
      clusters.push(...projectClusters)
    }
    for (const cluster of clusters) {
      if (cluster.length < 2) {
        clustered.push(...cluster)
      } else {
        const last = cluster[cluster.length - 1]
        const status = virtualGroupStatus(cluster)
        const finished = status !== 'running'
        // Outcome is the chain's terminal state, but recovery steps are not
        // terminal. A cluster ending on fix or a non-LGTM review
        // still needs follow-up work before it can read green.
        const attention = finished ? virtualGroupAttentionState(cluster) : null
        const vgroup: Entry = {
          key: `vgroup:${cluster[0].project}:${cluster[0].startedAt}`,
          project: cluster[0].project,
          kind: 'release',
          bucket: 'release',
          title: 'Pipeline steps',
          subtitle: null,
          startedAt: cluster[0].startedAt,
          lastActivityAt: last.lastActivityAt,
          finishedAt: last.finishedAt,
          status,
          exitCode: finished ? attention?.exitCode ?? 0 : null,
          durationMs: null,
          inputTokens: cluster.reduce((s, e) => s + e.inputTokens, 0),
          outputTokens: cluster.reduce((s, e) => s + e.outputTokens, 0),
          cacheReadTokens: cluster.reduce((s, e) => s + e.cacheReadTokens, 0),
          promptBytes: cluster.reduce((m, e) => Math.max(m, e.promptBytes ?? 0), 0) || null,
          costUsd: cluster.reduce((s, e) => s + e.costUsd, 0),
          turns: 1,
          model: null,
          navJobId: last.navJobId,
          navSessionId: null,
          releaseId: null,
          verdict: undefined,
          failureLabel: attention?.failureLabel ?? null,
          releaseOutcome: null,
          logPruned: false,
          workSummary: null,
          modifiedFiles: null,
          children: cluster,
          parentJobId: null,
          parentLabel: null,
          // Synthetic — collect every job id in the cluster so buildChain
          // recognizes any cross-cluster parent_job_id link as "outside the
          // cluster" → root, and intra-cluster links as edges.
          _jobIds: cluster.flatMap(c => c._jobIds ?? [c.navJobId]),
        }
        vgroup.chainedChildren = buildChain(vgroup, cluster)
        clustered.push(vgroup)
      }
    }
  }

  const out = [...parents, ...clustered, ...otherTopLevel]
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return out
}

// Compact one-line summary built from a release's children, e.g.
// "test ✓ · review LGTM · commit ✓ · push ✓".
export function buildReleaseSummary(children: Entry[], release?: Entry): string {
  if (children.length === 0) {
    if (release?.status === 'done' && release.exitCode !== null && release.exitCode !== 0) {
      return 'release blocked before first step'
    }
    return '(no steps)'
  }
  const parts: string[] = []
  const sorted = sortPipelineEntriesByActivity(children)
  for (const c of sorted) {
    const name = c.kind === 'mark-dod' ? 'dod' : c.kind
    let mark = '…'
    if (c.status === 'running') mark = '…'
    else if (c.exitCode === 0) mark = c.kind === 'review' && c.verdict ? c.verdict : '✓'
    else mark = `✗${c.exitCode ?? ''}`
    parts.push(`${name} ${mark}`)
  }
  const last = sorted[sorted.length - 1]
  const failedTestWithoutFix = last?.kind === 'test'
    && last.status === 'done'
    && last.exitCode !== null
    && last.exitCode !== 0
    && !sorted.some((c) => c.kind === 'fix' && c.startedAt > last.startedAt)
  if (failedTestWithoutFix) parts.push('fix pending')
  return parts.join(' · ')
}

function pipelineStepLabel(kind: string): string {
  if (kind === 'mark-dod') return 'dod'
  if (kind === 'pr-wait') return 'pr wait'
  if (kind === 'soak') return 'soak'
  return kind
}

function sortPipelineEntriesByActivity(children: Entry[]): Entry[] {
  return [...children].sort((a, b) => {
    if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt - b.lastActivityAt
    if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt
    return 0
  })
}

function releaseStepDepth(entry: Entry, baseDepth: number): number {
  return entry.kind === 'fix'
    ? baseDepth + 1
    : baseDepth
}

export function buildReleaseProgressLabel(children: Entry[], release?: Entry): string | null {
  if (children.length === 0) {
    if (release?.status === 'running') return 'starting release'
    if (release?.status === 'aborted') return 'release cancelled'
    if (release?.status === 'done' && release.exitCode !== null && release.exitCode !== 0) {
      return 'blocked before first step'
    }
    return null
  }

  const sorted = sortPipelineEntriesByActivity(children)
  const running = [...sorted].reverse().find((child) => child.status === 'running')
  if (running) return `now: ${pipelineStepLabel(running.kind)}`

  const last = sorted[sorted.length - 1]
  const lastLabel = pipelineStepLabel(last.kind)
  if (release?.status === 'aborted') {
    return last.status === 'aborted' ? `cancelled at ${lastLabel}` : `cancelled after ${lastLabel}`
  }
  if (last.status === 'aborted') return `cancelled at ${lastLabel}`

  if (last.kind === 'review') {
    if (last.verdict === 'LGTM') {
      if (release?.status === 'done' && release.exitCode === 0) return 'completed through review'
      return 'review passed'
    }
    if (last.verdict === 'NEEDS ATTENTION' || last.verdict === 'DO NOT SHIP') {
      return 'stopped at review'
    }
    if (last.status === 'done' && last.exitCode === 0) return 'waiting for review verdict'
  }

  if (last.exitCode !== null && last.exitCode !== 0) return `failed at ${lastLabel}`
  if (release?.status === 'running') return `waiting after ${lastLabel}`
  if (release?.status === 'done' && release.exitCode === 0) return `completed through ${lastLabel}`
  // The release stopped, but the last child step finished cleanly. Saying
  // "stopped at test" implies test is the failure — confusing when test is
  // a green ✓. "stopped after test" reads as "test passed, then the chain
  // didn't continue", which matches the situation: the orchestrator
  // failed to spawn the next phase (or a guard aborted) after the step.
  if (release && entryNeedsAttention(release)) {
    const stepPassed = last.status === 'done' && (last.exitCode === 0 || last.exitCode === null)
    return stepPassed ? `stopped after ${lastLabel}` : `stopped at ${lastLabel}`
  }
  return `last step: ${lastLabel}`
}

export function flattenReleaseChildren(children: Entry[], baseDepth: number): Array<{ entry: Entry; depth: number }> {
  return sortPipelineEntriesByActivity(children).map((entry) => ({
    entry,
    depth: releaseStepDepth(entry, baseDepth),
  }))
}

// Flatten the pipeline chain tree into a linear {entry, depth} list. Main
// pipeline steps (test/review/commit/push/mark-dod/pr-wait) all appear at
// `baseDepth`. fix appears at baseDepth+1 so it reads as an
// indented remediation rather than as a separate tier. After any node its
// chained children resume at `baseDepth` — a review that follows a fix is a
// sibling of the preceding test, not its grandchild.
export function flattenPipelineSteps(roots: Entry[], baseDepth: number): Array<{ entry: Entry; depth: number }> {
  const result: Array<{ entry: Entry; depth: number }> = []
  const walk = (nodes: Entry[], stepDepth: number) => {
    for (const node of nodes) {
      result.push({ entry: node, depth: releaseStepDepth(node, stepDepth) })
      walk(node.chainedChildren ?? [], baseDepth)
    }
  }
  walk(roots, baseDepth)
  return result
}

import type { JobInfo } from '@/lib/client-api'
import { isCancelledExitCode } from '@/lib/shared/job-exit-codes'
import { jobCost } from '@/components/project-runs/formatting'
import { bucketOf, KIND_LABEL, runKindDisplayName } from '@/components/project-runs/kinds'
import type { KindBucket } from '@/components/project-runs/kinds'
import type { Entry, OutcomeVerdict } from '@/components/project-runs/types'

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

export function reviewNeedsAttention(e: Entry): boolean {
  return e.kind === 'review' && e.verdict !== undefined && e.verdict !== null && e.verdict !== 'LGTM'
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

    const followupIssue = followupIssueFromContext(j.context_meta)
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
      followupIssueUrl: followupIssue?.url ?? null,
      followupIssueNumber: followupIssue?.number ?? null,
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
  const followupIssue = followupIssueFromContext(j.context_meta)
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
    followupIssueUrl: followupIssue?.url ?? null,
    followupIssueNumber: followupIssue?.number ?? null,
    _jobIds: [j.id],
  }
}

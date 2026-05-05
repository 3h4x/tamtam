import type { JobInfo } from '@/lib/client-api'
import { costUsd as computeCost } from '@/lib/shared/usage-pricing'

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
  | 'fix-push'
  | 'commit'
  | 'push'
  | 'mark-dod'
  | 'pr-wait'
  | 'agent'
  | 'other'

export function bucketOf(kind: string): KindBucket {
  if (kind === 'run') return 'run'
  if (kind === 'release') return 'release'
  if (kind === 'review') return 'review'
  if (kind === 'test') return 'test'
  if (kind === 'fix') return 'fix'
  if (kind === 'fix-ci') return 'fix-ci'
  if (kind === 'fix-push') return 'fix-push'
  if (kind === 'commit') return 'commit'
  if (kind === 'push') return 'push'
  if (kind === 'mark-dod') return 'mark-dod'
  if (kind === 'pr-wait') return 'pr-wait'
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
  'fix-push': 'fix-push',
  commit: 'commit',
  push: 'push',
  'mark-dod': 'dod',
  'pr-wait': 'pr-wait',
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
  'fix-push': 'bg-status-warning/15 text-status-warning',
  commit: 'bg-status-success/15 text-status-success',
  push: 'bg-status-success/15 text-status-success',
  'mark-dod': 'bg-status-info/15 text-status-info',
  'pr-wait': 'bg-status-info/15 text-status-info',
  agent: 'bg-bg-tertiary text-text-secondary border border-border',
  other: 'bg-text-tertiary/15 text-text-secondary',
}

// Kinds that belong to a release pipeline. When a `release` meta-job is
// active, any of these jobs started inside its [started_at, finished_at]
// window is considered a child of that release in the History UI.
// Note: `fix-ci` is intentionally absent — it is not a scheduled release-chain
// step, so the UI shows it as a top-level row rather than nesting it under a
// release card. It IS included in PIPELINE_LIKE in the notifications route so
// that a terminal release success can supersede an older fix-ci failure.
export const PIPELINE_CHILD_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'mark-dod', 'fix-push', 'pr-wait'])

// An entry represents a single row in the history. For `run` jobs with a
// session_id we collapse every turn of the conversation into one entry so the
// list reads as "conversations" rather than dozens of identical chat rows.
// For `release` jobs, `children` is populated by groupReleaseChildren with
// the pipeline steps (test/review/fix/commit/push/…) that ran inside the
// release's time window.
export interface Entry {
  key: string
  kind: string
  bucket: KindBucket
  title: string
  subtitle: string | null
  startedAt: number
  lastActivityAt: number
  finishedAt: number | null
  status: 'running' | 'done'
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
  verdict?: JobInfo['verdict']
  failureLabel?: string | null
  releaseOutcome?: ReleaseOutcome | null
  logPruned: boolean
  workSummary: string | null
  modifiedFiles: string | null
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
  parentJobId: string | null
  parentLabel: string | null
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

function releaseOutcomeFor(rel: Entry): ReleaseOutcome {
  if (rel.status === 'running') {
    return { status: 'running', label: 'release running', releaseJobId: rel.navJobId }
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
  return e.kind === 'fix' || e.kind === 'fix-push'
}

function advisoryNonTerminalStep(e: Entry): boolean {
  return e.kind === 'mark-dod'
}

function virtualGroupAttentionState(cluster: Entry[]): { exitCode: number; failureLabel: string } | null {
  if (cluster.length === 0) return null
  const last = cluster[cluster.length - 1]
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

export function entryIsRunning(e: Entry): boolean {
  return e.status === 'running' || e.releaseOutcome?.status === 'running'
}

export function entryNeedsAttention(e: Entry): boolean {
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

function titleForJob(job: JobInfo, bucket: KindBucket): string {
  const prompt = job.user_prompt || job.prompt
  if (bucket === 'run') return prompt ? truncate(prompt, 140) : '(empty prompt)'
  if (bucket === 'release') return 'Release pipeline'
  if (bucket === 'review') return 'Code review'
  if (bucket === 'test') return 'Test run'
  if (bucket === 'fix') return 'Auto-fix'
  if (bucket === 'fix-ci') return 'Fix CI'
  if (bucket === 'fix-push') return 'Fix push failure'
  if (bucket === 'commit') return 'Commit'
  if (bucket === 'push') return 'Push'
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
  if (bucket === 'pr-wait') return 'PR wait (CI + merge)'
  if (bucket === 'agent') return job.kind.replace(/^agent:/, '') || 'agent'
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
    // 2. Pipeline-step jobs (review, fix, fix-ci, fix-push, commit, push,
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
      ? (isConversational ? `${j.session_id}:conversation` : `${j.session_id}:${j.kind}`)
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
        existing.costUsd += jobCost(j)
        existing.navJobId = j.id
        existing.workSummary = j.work_summary ?? existing.workSummary
        existing.modifiedFiles = j.modified_files ?? existing.modifiedFiles
        existing._jobIds!.push(j.id)
        continue
      }
    }

    const entry: Entry = {
      // Conversational sessions get a stable `sess:<id>` key so the same
      // entry is reused across turns. Pipeline-step jobs sharing a session
      // (review → fix via --resume) need distinct keys per kind so they
      // don't collide on the same entry.
      key: j.session_id
        ? (isConversational ? `sess:${j.session_id}` : `sess:${j.session_id}:${j.kind}`)
        : `job:${j.id}`,
      kind: j.kind,
      bucket,
      title: titleForJob(j, bucket),
      subtitle: subtitleForJob(j, bucket),
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
      verdict: j.verdict,
      failureLabel: null,
      releaseOutcome: null,
      logPruned: !!j.log_pruned,
      workSummary: j.work_summary ?? null,
      modifiedFiles: j.modified_files ?? null,
      parentJobId: j.parent_job_id ?? null,
      parentLabel: j.parent_job_id ? parentLabelFor(byId.get(j.parent_job_id)) : null,
      _jobIds: [j.id],
    }
    if (canSessionMerge) sessionGroup.set(sessionKey, entry)
    entries.push(entry)
  }

  entries.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return entries
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
// parent release entry using the release's [startedAt, finishedAt ?? ∞] window.
// Releases are project-scoped and protected by `pipeline_locks` so at most one
// release is active per project at a time — a child job's timestamp
// unambiguously identifies its parent.
//
// Exported for unit testing.
export function groupReleaseChildren(entries: Entry[]): Entry[] {
  const releases = entries.filter((e) => e.kind === 'release')

  // Latest-starting containing release wins (in the pathological case two
  // release windows overlap). Sorted asc so the last assignment wins.
  const sortedReleases = [...releases].sort((a, b) => a.startedAt - b.startedAt)

  const findContainingRelease = (child: Entry): Entry | null => {
    if (!PIPELINE_CHILD_KINDS.has(child.kind)) return null
    let best: Entry | null = null
    for (const r of sortedReleases) {
      const end = r.finishedAt ?? Number.POSITIVE_INFINITY
      if (r.startedAt <= child.startedAt && child.startedAt <= end) best = r
    }
    return best
  }

  const childrenByParent = new Map<string, Entry[]>()
  const topLevel: Entry[] = []
  for (const e of entries) {
    if (e.kind === 'release') continue
    const parent = findContainingRelease(e)
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
    const failureLabel = r.status === 'done' && r.exitCode !== null && r.exitCode !== 0
      ? kids.length === 0 ? 'release blocked' : 'release failed'
      : r.failureLabel
    releasesByKey.set(r.key, { ...r, children: kids, chainedChildren: buildChain(r, kids), failureLabel })
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

  const parents: Entry[] = Array.from(releasesByKey.values()).filter(
    r => !agentOwnedReleaseKeys.has(r.key)
  )
  const clustered: Entry[] = []

  if (pipelineOrphans.length > 0) {
    const sortedOrphans = [...pipelineOrphans].sort((a, b) => a.startedAt - b.startedAt)
    const clusters: Entry[][] = [[sortedOrphans[0]]]
    for (let i = 1; i < sortedOrphans.length; i++) {
      const prev = sortedOrphans[i - 1]
      const curr = sortedOrphans[i]
      const gap = curr.startedAt - (prev.finishedAt ?? prev.startedAt)
      if (gap <= CLUSTER_GAP) {
        clusters[clusters.length - 1].push(curr)
      } else {
        clusters.push([curr])
      }
    }
    for (const cluster of clusters) {
      if (cluster.length < 2) {
        clustered.push(...cluster)
      } else {
        const last = cluster[cluster.length - 1]
        const allDone = cluster.every(e => e.status === 'done')
        // Outcome is the chain's terminal state, but recovery steps are not
        // terminal. A cluster ending on fix/fix-push or a non-LGTM review
        // still needs follow-up work before it can read green.
        const attention = allDone ? virtualGroupAttentionState(cluster) : null
        const vgroup: Entry = {
          key: `vgroup:${cluster[0].startedAt}`,
          kind: 'release',
          bucket: 'release',
          title: 'Pipeline steps',
          subtitle: null,
          startedAt: cluster[0].startedAt,
          lastActivityAt: last.lastActivityAt,
          finishedAt: last.finishedAt,
          status: allDone ? 'done' : 'running',
          exitCode: allDone ? attention?.exitCode ?? 0 : null,
          durationMs: null,
          inputTokens: cluster.reduce((s, e) => s + e.inputTokens, 0),
          outputTokens: cluster.reduce((s, e) => s + e.outputTokens, 0),
          cacheReadTokens: cluster.reduce((s, e) => s + e.cacheReadTokens, 0),
          costUsd: cluster.reduce((s, e) => s + e.costUsd, 0),
          turns: 1,
          model: null,
          navJobId: last.navJobId,
          navSessionId: null,
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
  const sorted = [...children].sort((a, b) => a.startedAt - b.startedAt)
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

// Flatten the pipeline chain tree into a linear {entry, depth} list. Main
// pipeline steps (test/review/commit/push/mark-dod/pr-wait) all appear at
// `baseDepth`. fix/fix-push appear at baseDepth+1 so they read as an
// indented remediation rather than as a separate tier. After any node its
// chained children resume at `baseDepth` — a review that follows a fix is a
// sibling of the preceding test, not its grandchild.
export function flattenPipelineSteps(roots: Entry[], baseDepth: number): Array<{ entry: Entry; depth: number }> {
  const result: Array<{ entry: Entry; depth: number }> = []
  const walk = (nodes: Entry[], stepDepth: number) => {
    for (const node of nodes) {
      const isFix = node.kind === 'fix' || node.kind === 'fix-push'
      result.push({ entry: node, depth: isFix ? stepDepth + 1 : stepDepth })
      walk(node.chainedChildren ?? [], baseDepth)
    }
  }
  walk(roots, baseDepth)
  return result
}

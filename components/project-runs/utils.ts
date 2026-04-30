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
  agent: 'bg-purple-500/15 text-purple-400',
  other: 'bg-text-tertiary/15 text-text-secondary',
}

// Kinds that belong to a release pipeline. When a `release` meta-job is
// active, any of these jobs started inside its [started_at, finished_at]
// window is considered a child of that release in the History UI.
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
  logPruned: boolean
  children?: Entry[]
  parentJobId: string | null
  parentLabel: string | null
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
    // Release meta-jobs must never session-merge: their aggregate log may
    // contain a child's session_id, and merging would shrink the release's
    // apparent window (losing commit/push from grouping). Only real chat-style
    // jobs (run, review, fix, fix-ci, fix-push, agent:*) should session-group.
    const canSessionMerge = !!j.session_id && j.kind !== 'release'
    if (canSessionMerge) {
      const existing = sessionGroup.get(j.session_id!)
      if (existing) {
        existing.turns += 1
        existing.lastActivityAt = j.started_at
        existing.finishedAt = j.finished_at
        existing.status = j.status
        existing.exitCode = j.exit_code
        existing.durationMs = (existing.durationMs ?? 0) + (j.duration_ms ?? 0)
        existing.inputTokens += j.input_tokens ?? 0
        existing.outputTokens += j.output_tokens ?? 0
        existing.cacheReadTokens += j.cache_read_tokens ?? 0
        existing.costUsd += jobCost(j)
        existing.navJobId = j.id
        continue
      }
    }

    const entry: Entry = {
      key: j.session_id ? `sess:${j.session_id}` : `job:${j.id}`,
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
      logPruned: !!j.log_pruned,
      parentJobId: j.parent_job_id ?? null,
      parentLabel: j.parent_job_id ? parentLabelFor(byId.get(j.parent_job_id)) : null,
    }
    if (canSessionMerge) sessionGroup.set(j.session_id!, entry)
    entries.push(entry)
  }

  entries.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return entries
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

  const parents: Entry[] = releases.map((r) => {
    const kids = (childrenByParent.get(r.key) ?? []).sort((a, b) => a.startedAt - b.startedAt)
    return { ...r, children: kids }
  })

  // Cluster orphaned pipeline steps (no parent release) that are close in time
  // into virtual groups so they display as one collapsed row instead of many
  // individual entries. This handles pre-aggregator pipeline runs and manual
  // step-by-step invocations.
  const CLUSTER_GAP = 30 * 60 // 30 minutes between steps = same pipeline run
  const pipelineOrphans = topLevel.filter(e => PIPELINE_CHILD_KINDS.has(e.kind))
  const otherTopLevel = topLevel.filter(e => !PIPELINE_CHILD_KINDS.has(e.kind))
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
        const anyFailed = cluster.some(e => e.exitCode !== null && e.exitCode !== 0)
        clustered.push({
          key: `vgroup:${cluster[0].startedAt}`,
          kind: 'release',
          bucket: 'release',
          title: 'Pipeline steps',
          subtitle: null,
          startedAt: cluster[0].startedAt,
          lastActivityAt: last.lastActivityAt,
          finishedAt: last.finishedAt,
          status: allDone ? 'done' : 'running',
          exitCode: anyFailed ? 1 : allDone ? 0 : null,
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
          logPruned: false,
          children: cluster,
          parentJobId: null,
          parentLabel: null,
        })
      }
    }
  }

  const out = [...parents, ...clustered, ...otherTopLevel]
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return out
}

// Compact one-line summary built from a release's children, e.g.
// "test ✓ · review LGTM · commit ✓ · push ✓".
export function buildReleaseSummary(children: Entry[]): string {
  if (children.length === 0) return '(no steps)'
  const parts: string[] = []
  for (const c of children) {
    const name = c.kind === 'mark-dod' ? 'dod' : c.kind
    let mark = '…'
    if (c.status === 'running') mark = '…'
    else if (c.exitCode === 0) mark = c.kind === 'review' && c.verdict ? c.verdict : '✓'
    else mark = `✗${c.exitCode ?? ''}`
    parts.push(`${name} ${mark}`)
  }
  return parts.join(' · ')
}

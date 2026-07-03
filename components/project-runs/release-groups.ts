import { isCancelledExitCode } from '@/lib/shared/job-exit-codes'
import { reviewNeedsAttention } from '@/components/project-runs/entries'
import { latestFailureSummary } from '@/components/project-runs/run-summary'
import { sortPipelineEntriesByActivity } from '@/components/project-runs/release-progress'
import type { Entry, ReleaseOutcome } from '@/components/project-runs/types'

// Kinds that belong to a release pipeline. When a `release` meta-job is
// active, any of these jobs started inside its [started_at, finished_at]
// window is considered a child of that release in the History UI.
// Note: `fix-ci` is intentionally absent — it is not a scheduled release-chain
// step, so the UI shows it as a top-level row rather than nesting it under a
// release card. It IS included in PIPELINE_LIKE in the notifications route so
// that a terminal release success can supersede an older fix-ci failure.
export const PIPELINE_CHILD_KINDS = new Set(['test', 'review', 'fix', 'commit', 'push', 'mark-dod', 'pr-wait', 'soak'])

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
  if (rel.exitCode === 0) {
    return { status: 'done', label: 'release done', releaseJobId: rel.navJobId }
  }
  // Why the release stopped: the orchestrator's recorded stop reason (e.g.
  // "review startup failed: Jobs are paused globally …") or, absent that, the
  // latest failed child's summary. Carried on the outcome so the owning
  // agent/run row explains a failed release-after-run instead of just showing
  // "failed" with no cause. Only attached when known, so a reason-less outcome
  // stays minimal ({status,label,releaseJobId}).
  const reason = rel.releaseStopReason ?? latestFailureSummary(rel)
  const reasonField = reason ? { reason } : {}
  if (rel.status === 'aborted') {
    return { status: 'failed', label: 'release cancelled', releaseJobId: rel.navJobId, ...reasonField }
  }
  if ((rel.children?.length ?? 0) === 0) {
    return { status: 'blocked', label: 'release blocked', releaseJobId: rel.navJobId, ...reasonField }
  }
  return { status: 'failed', label: 'release failed', releaseJobId: rel.navJobId, ...reasonField }
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

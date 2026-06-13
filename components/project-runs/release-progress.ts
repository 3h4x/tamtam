import { entryNeedsAttention } from '@/components/project-runs/entries'
import type { Entry } from '@/components/project-runs/types'

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

export function sortPipelineEntriesByActivity(children: Entry[]): Entry[] {
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

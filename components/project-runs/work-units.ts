import { groupReleaseChildren } from '@/components/project-runs/release-groups'
import type { Entry } from '@/components/project-runs/types'

// A "work unit" is a meaningful top-level history item: an agent run, a
// release, or a manual chat/terminal run. `groupReleaseChildren` already nests
// pipeline steps under their release and nests releases under the agent/run
// that triggered them. What it leaves at the top level is a small set of
// internal plumbing jobs that don't belong to that nesting — chiefly the
// supervised `mark-dod-verify` jobs, which flood the feed (8 of 14 rows on a
// busy project) and bury the actual work.
//
// We deliberately do NOT fold these into `PIPELINE_CHILD_KINDS`: an advisory
// `mark-dod-verify` that exits non-zero must never flip its release to
// "failed" via the release-state derivation. Instead we classify them here as
// internal and hide them from the default (grouped) view. Their result is
// already summarized on the `dod` step title, and the release detail drawer
// surfaces them server-side in the pipeline timeline.
export const INTERNAL_KINDS = new Set(['mark-dod-verify'])

export function isInternalUnit(e: Entry): boolean {
  return INTERNAL_KINDS.has(e.kind)
}

export interface GroupedWorkUnits {
  /** Meaningful top-level units, newest-activity first. */
  roots: Entry[]
  /** Hidden internal plumbing, kept separate for callers that need flat jobs. */
  internal: Entry[]
}

export function groupWorkUnits(entries: Entry[]): GroupedWorkUnits {
  const grouped = groupReleaseChildren(entries)
  const roots: Entry[] = []
  const internal: Entry[] = []
  for (const e of grouped) {
    if (isInternalUnit(e)) internal.push(e)
    else roots.push(e)
  }
  return { roots, internal }
}

/** Merge roots + internal into one activity-sorted list (the "show all" view). */
export function mergeWorkUnits({ roots, internal }: GroupedWorkUnits): Entry[] {
  return [...roots, ...internal].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
}

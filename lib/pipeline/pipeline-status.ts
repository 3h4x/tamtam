import type { JobInfo } from '@/lib/client-api'

// Kinds that, when running, mean a release-style pipeline is in flight. The
// top-level Release/Ship button must be disabled while any of these is
// active — otherwise a user can double-click Release mid-commit and kick off
// a conflicting pipeline.
export const PIPELINE_KINDS = ['release', 'test', 'review', 'fix', 'commit', 'push'] as const

export function isPipelineBusy(jobs: JobInfo[]): boolean {
  return jobs.some(j => j.status === 'running' && (PIPELINE_KINDS as readonly string[]).includes(j.kind))
}

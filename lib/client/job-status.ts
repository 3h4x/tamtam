import type { JobInfo } from '@/lib/client-api'

// Client-side job-status helpers, operating on the `JobInfo` API shape.
// The server-side equivalent in `lib/jobs/status.ts` operates on raw
// `JobData` with additional review-verdict logic; do not share an
// implementation across the boundary.
export type JobStatus = JobInfo['status'] | 'completed' | 'failed'

type JobStatusLike = { status: JobStatus }

export function jobIsFinished(job: JobStatusLike): boolean {
  return job.status !== 'running'
}

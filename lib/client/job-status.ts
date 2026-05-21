import type { JobInfo } from '@/lib/client-api'

// Client-side job-status helpers. Only `jobIsFinished` has a caller today
// (NotificationBell uses it to gate `markJobSeen`); earlier siblings
// (`jobIsRunning`, `jobIsAborted`, `jobNeedsAttention`, `jobSucceeded`)
// were removed when grep confirmed they were unused. The server-side
// equivalent of needs-attention lives at `lib/jobs/status.ts` — it
// operates on the raw `JobData` shape and has additional review-verdict
// logic, so don't try to share an implementation across the boundary.
export type JobStatus = JobInfo['status'] | 'completed' | 'failed'

type JobStatusLike = { status: JobStatus }

export function jobIsFinished(job: JobStatusLike): boolean {
  return job.status !== 'running'
}

import type { JobData } from './types';

export function jobNeedsAttention(job: JobData): boolean {
  if (job.abortedAt != null) return true;
  if (job.finishedAt !== null && job.exitCode !== null && job.exitCode !== 0) return true;
  if (job.kind === 'review' && job.verdict !== undefined && job.verdict !== null && job.verdict !== 'LGTM') return true;
  if (job.kind === 'review' && job.finishedAt !== null && job.verdict == null) return true;
  return false;
}

import { listJobs, probeJobStatus } from '@/lib/jobs/job-storage';
import type { JobData } from '@/lib/jobs/types';

export async function findBlockingRunningJob(
  project: string,
  predicate?: (job: JobData) => boolean,
): Promise<JobData | null> {
  const running = listJobs().filter((job) =>
    job.project === project &&
    job.finishedAt === null &&
    (!predicate || predicate(job))
  );

  for (const job of running) {
    if ((await probeJobStatus(job)) === 'running') return job;
  }

  return null;
}

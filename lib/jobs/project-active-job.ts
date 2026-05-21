import { listJobs, probeJobStatus } from '@/lib/jobs/job-storage';
import { getAgentStartSlotJob } from '@/lib/agents/pending-agent-run';
import type { JobData } from '@/lib/jobs/types';

export async function findBlockingRunningJob(
  project: string,
  predicate?: (job: JobData) => boolean,
): Promise<JobData | null> {
  const startingAgent = getAgentStartSlotJob(project);
  if (startingAgent && (!predicate || predicate(startingAgent))) {
    return startingAgent;
  }

  const running = listJobs().filter((job) =>
    job.project === project &&
    job.finishedAt === null &&
    (!predicate || predicate(job))
  );

  // Probe in parallel and then pick the first chronologically-still-running
  // entry. Wall-time collapses to the slowest probe, and stale siblings
  // (e.g. post-restart `finishedAt === null` rows) get marked done in the
  // same pass instead of lingering until the 30s background sweep.
  if (running.length === 0) return null;
  const states = await Promise.all(running.map((job) => probeJobStatus(job)));
  for (let i = 0; i < running.length; i++) {
    if (states[i] === 'running') return running[i];
  }

  return null;
}

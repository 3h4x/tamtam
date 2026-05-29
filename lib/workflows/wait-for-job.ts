// Polls the jobs cache until a job reaches a terminal state, used inside
// workflow steps to await pipeline sub-steps whose spawn helpers
// (startProjectTest, startProjectReview, ...) return immediately. A phase
// step calls a spawn helper, waits here until the child finishes, then the
// release orchestrator decides the next step.
//
// Polling vs LISTEN/NOTIFY: the jobs table is read through an in-memory
// cache that the lifecycle layer mutates synchronously after markDone, so
// a polling read is cheap and consistent. Switching to LISTEN/NOTIFY is a
// future optimization if pipeline concurrency grows past what 5s polling
// can handle.

import type { JobData } from '@/lib/jobs/types';

export interface WaitForJobOptions {
  /** Poll cadence in ms. Default 5000. */
  pollIntervalMs?: number;
  /** Hard ceiling after which the helper resolves with the job's current
   *  state regardless of finishedAt. Default 60 min. Prevents a workflow
   *  step from hanging forever on a job that escapes both markDone and the
   *  probe sweep. */
  timeoutMs?: number;
  /** Optional AbortSignal — when aborted, the helper resolves immediately
   *  with the latest job state. Used so workflow cancellation propagates. */
  signal?: AbortSignal;
}

export interface WaitForJobResult {
  job: JobData | null;
  /** true if finishedAt was observed; false if we bailed on timeout/abort. */
  finished: boolean;
  /** Reason for resolution. Useful in step output for observability. */
  reason: 'finished' | 'timeout' | 'aborted' | 'not_found';
}

const DEFAULT_POLL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

export async function waitForJobCompletion(
  jobId: string,
  options: WaitForJobOptions = {},
): Promise<WaitForJobResult> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal;

  const { getJob } = await import('@/lib/jobs/job-storage');
  const startedAt = Date.now();

  // Eager first check — if the job is already finished (or never existed),
  // return without burning a poll interval. This also lets idempotent step
  // replays short-circuit on workflow restart.
  const initial = getJob(jobId);
  if (!initial) return { job: null, finished: false, reason: 'not_found' };
  if (initial.finishedAt != null) return { job: initial, finished: true, reason: 'finished' };

  while (true) {
    if (signal?.aborted) {
      return { job: getJob(jobId), finished: false, reason: 'aborted' };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { job: getJob(jobId), finished: false, reason: 'timeout' };
    }
    await sleep(pollIntervalMs, signal);
    const job = getJob(jobId);
    if (!job) return { job: null, finished: false, reason: 'not_found' };
    if (job.finishedAt != null) return { job, finished: true, reason: 'finished' };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

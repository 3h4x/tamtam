import type { JobData } from './types';

interface CancellationEntry {
  controller: AbortController;
  completion: Promise<void>;
  resolve: () => void;
}

declare global {
  var __tamtamJobCancellation: Map<string, CancellationEntry> | undefined;
}

const cancellationRegistry =
  globalThis.__tamtamJobCancellation ?? new Map<string, CancellationEntry>();

globalThis.__tamtamJobCancellation = cancellationRegistry;

export const SAFE_PID_FLOOR = 100;

export class JobCancelledError extends Error {
  constructor(message = 'job cancelled') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

export function isInlineServerKind(kind: string): boolean {
  return kind === 'push' || kind === 'commit';
}

export function registerJobCancellation(jobId: string): AbortSignal {
  const existing = cancellationRegistry.get(jobId);
  if (existing) return existing.controller.signal;

  const controller = new AbortController();
  let resolve = () => {};
  const completion = new Promise<void>((r) => {
    resolve = r;
  });
  cancellationRegistry.set(jobId, { controller, completion, resolve });
  return controller.signal;
}

export function finishJobCancellation(jobId: string): void {
  const entry = cancellationRegistry.get(jobId);
  if (!entry) return;
  entry.resolve();
  cancellationRegistry.delete(jobId);
}

export async function requestJobCancellation(jobId: string, timeoutMs = 30_000): Promise<boolean> {
  const entry = cancellationRegistry.get(jobId);
  if (!entry) return false;

  entry.controller.abort();
  const timedOut = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(true), timeoutMs);
    void entry.completion.then(() => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
  return !timedOut;
}

export function getJobCancellationSignal(jobId: string): AbortSignal | null {
  return cancellationRegistry.get(jobId)?.controller.signal ?? null;
}

export function throwIfJobCancelled(job: Pick<JobData, 'id' | 'abortedAt'>, signal?: AbortSignal | null): void {
  if (job.abortedAt != null || signal?.aborted) {
    throw new JobCancelledError();
  }
}

export function shouldSignalJobPid(job: Pick<JobData, 'pid' | 'kind'>): boolean {
  // PID equality is the authoritative safety check: any job whose pid IS the
  // server's own process.pid must NEVER be signaled. Multiple kinds use that
  // convention (push, commit, release meta, inline-agent before/around child
  // capture), and the kind list is easier to drift than this invariant. Keep
  // the kind check as belt-and-suspenders for older code paths that compare
  // against constants.
  if (job.pid === process.pid) return false;
  return job.pid > SAFE_PID_FLOOR && !isInlineServerKind(job.kind);
}

// Wall-clock aborts need a stricter safety check than the generic helper:
// inline push/commit jobs may have already switched to a detached child pid,
// so the timeout path must be able to signal them even though their kind is
// inline. The only hard stop is self-kill / suspicious low pids.
export function shouldSignalJobPidForWallClockTimeout(job: Pick<JobData, 'pid'>): boolean {
  return job.pid !== process.pid && job.pid > SAFE_PID_FLOOR;
}

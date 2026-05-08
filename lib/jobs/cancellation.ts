import type { JobData } from './types';

declare global {
  var __tamtamJobCancellation:
    | Map<string, { controller: AbortController; completion: Promise<void>; resolve: () => void }>
    | undefined;
}

const cancellationRegistry =
  globalThis.__tamtamJobCancellation ?? new Map<string, { controller: AbortController; completion: Promise<void>; resolve: () => void }>();

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
  return job.pid > SAFE_PID_FLOOR && !isInlineServerKind(job.kind);
}

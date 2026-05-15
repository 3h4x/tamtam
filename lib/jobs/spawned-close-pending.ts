// In-memory registry of jobs whose spawned subprocess is still pending its
// `proc.on('close', …)` handler in the current Next.js process. probeJobStatus
// consults this set before declaring a test/action job dead via
// `process.kill(pid, 0)` — that liveness check races against the close handler
// because both run asynchronously, and if the probe wins the race it overwrites
// the real exit code with -1.
//
// State is intentionally process-local (Set, not DB-backed). A server restart
// invalidates the set, which is correct: any pending close handlers died with
// the previous process, and probe is then free to mark stranded jobs as -1.
//
// Pinned on globalThis so HMR / module-graph duplication in Next.js doesn't
// fork the Set across realms.

declare global {
  var __tamtamSpawnedClosePending: Set<string> | undefined;
}

function getSet(): Set<string> {
  if (!globalThis.__tamtamSpawnedClosePending) {
    globalThis.__tamtamSpawnedClosePending = new Set<string>();
  }
  return globalThis.__tamtamSpawnedClosePending;
}

/** Mark a spawned job as having a pending close handler in this process. */
export function markCloseHandlerPending(jobId: string): void {
  getSet().add(jobId);
}

/** Called from the spawned proc's `close` event before markDone. */
export function clearCloseHandlerPending(jobId: string): void {
  getSet().delete(jobId);
}

/** Probe consults this to skip the ESRCH path while the close handler is still pending. */
export function hasCloseHandlerPending(jobId: string): boolean {
  return getSet().has(jobId);
}

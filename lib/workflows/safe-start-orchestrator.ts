// Shared helper for "re-dispatch the orchestrator tick" calls used by every
// phase workflow's tail. Wraps `start(releaseOrchestratorWorkflow, …)` in
// the same chunk-load retry as `dispatch-phase.ts` so a `pnpm rebuild`
// mid-flight doesn't orphan releases (Next.js chunk path was rewritten
// between two import attempts).
//
// Each per-phase wrapper used to inline its own `start()` + try/catch,
// which silently logged the chunk error and let the release orphan. This
// helper makes the retry behavior uniform.

const CHUNK_ERROR_PATTERNS = [
  /Failed to load chunk/i,
  /Cannot find module/i,
  /MODULE_NOT_FOUND/,
];

function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return CHUNK_ERROR_PATTERNS.some((p) => p.test(msg));
}

/** Start the orchestrator tick for `jobId` with one chunk-load retry. Errors
 *  are logged and swallowed — the release-reconcile probe sweep is the
 *  eventual safety net, but ideally we recover here so a fresh release
 *  doesn't have to wait 30-90s for the next sweep. */
export async function safeStartOrchestrator(
  jobId: string,
  projectName: string,
  releaseJobId: string,
  callerTag: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { start } = await import('workflow/api');
      const { releaseOrchestratorWorkflow } = await import('@/lib/workflows/release-orchestrator');
      await start(releaseOrchestratorWorkflow, [jobId, { projectName, parentJobId: releaseJobId }]);
      return;
    } catch (err) {
      if (isChunkLoadError(err) && attempt === 1) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${callerTag}] chunk-load error re-dispatching orchestrator (likely mid-rebuild): ${msg.slice(0, 200)} — retrying once`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      console.error(`[${callerTag}] failed to re-dispatch orchestrator:`, err);
      return;
    }
  }
}

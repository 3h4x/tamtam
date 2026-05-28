import { resumePrWait } from '@/lib/pipeline/start-pr-wait';

/**
 * Narrow boot-time adapter for resuming abandoned inline pr-wait jobs.
 *
 * Keeping instrumentation behind this small boundary avoids loading the full
 * pr-wait implementation unless boot recovery actually needs it, and gives
 * tests a stable seam that is not shared with launch/phase tests.
 */
export function resumeBootPrWait(jobId: string): { ok: true } | { ok: false; error: string } {
  return resumePrWait(jobId);
}

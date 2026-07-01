// Per-run runaway guard — the complement to the project-level spend budget.
//
// A single Claude session (Opus + a long fix loop) can burn tens of dollars in
// minutes, long before a daily/weekly budget check fires. This reaper caps the
// individual run on two axes:
//   - `run_token_cap`         — cumulative input+output tokens (live, via the
//                               log's per-turn `message.usage`).
//   - `run_wall_time_cap_minutes` — wall-clock age of the running job.
//
// Like the test-timeout reaper it reads job rows + on-disk logs rather than an
// in-process timer, so it survives a restart. It reuses that module's
// process-group kill so a detached run's whole tree dies. Eligible kinds are
// Claude-backed runs/agents; `test` and `mark-dod-verify` keep their dedicated
// hang-guard caps, and the `release` meta-job is governed by its own
// wall-clock deadline.
import type { JobData } from '@/lib/jobs/types';
import { isClaudeBackedJobKind } from '@/lib/jobs/kinds';

/** `timeout(1)`-style exit code reused for a wall-time kill. */
export const RUN_WALL_TIME_EXIT_CODE = 124;
/** Distinct code so run detail/history can tell a token kill from a hang. */
export const RUN_TOKEN_CAP_EXIT_CODE = 125;

/** Kinds whose liveness is owned elsewhere and must not be double-reaped. */
const EXCLUDED_KINDS = new Set(['test', 'mark-dod-verify', 'release']);

export function isRunCapEligibleKind(kind: string): boolean {
  return isClaudeBackedJobKind(kind) && !EXCLUDED_KINDS.has(kind);
}

export interface RunCapConfig {
  /** Cumulative token ceiling; 0 disables. */
  tokenCap: number;
  /** Wall-clock ceiling in minutes; 0 disables. */
  wallMinutes: number;
}

export interface RunCapViolation {
  reason: string;
  exitCode: number;
}

/**
 * Pure decision for a single running job. `tokenTotal` is the accumulated
 * input+output token count (0 when unknown); `startedAt` is in SECONDS to
 * match the DB/probe convention. Wall-time is checked before tokens so a job
 * blocked on a hung process (no new tokens) still gets reaped.
 */
export function evaluateRunCap(
  job: Pick<JobData, 'kind' | 'startedAt'>,
  nowMs: number,
  tokenTotal: number,
  cfg: RunCapConfig,
): RunCapViolation | null {
  if (!isRunCapEligibleKind(job.kind)) return null;
  if (job.startedAt <= 0) return null;
  const ageMs = nowMs - job.startedAt * 1000;
  if (cfg.wallMinutes > 0 && ageMs > cfg.wallMinutes * 60_000) {
    const ageMin = Math.round(ageMs / 60_000);
    return {
      reason: `wall-time cap exceeded (${ageMin}min > ${cfg.wallMinutes}min)`,
      exitCode: RUN_WALL_TIME_EXIT_CODE,
    };
  }
  if (cfg.tokenCap > 0 && tokenTotal > cfg.tokenCap) {
    return {
      reason: `token cap exceeded (${tokenTotal.toLocaleString()} > ${cfg.tokenCap.toLocaleString()} tokens)`,
      exitCode: RUN_TOKEN_CAP_EXIT_CODE,
    };
  }
  return null;
}

/**
 * Find running Claude runs/agents that blew a per-run cap, kill their process
 * groups, log a clear reason into the run log + console, and mark them done
 * with the matching exit code. Returns the jobs that were reaped. Safe to call
 * every probe sweep. No-op when both caps are disabled.
 */
export async function reapRunCapExceededJobs(nowMs: number = Date.now()): Promise<JobData[]> {
  const { getSettings } = await import('@/lib/shared/config');
  const settings = getSettings();
  const cfg: RunCapConfig = {
    tokenCap: settings.run_token_cap,
    wallMinutes: settings.run_wall_time_cap_minutes,
  };
  if (cfg.tokenCap <= 0 && cfg.wallMinutes <= 0) return [];

  const { listJobs, markDone } = await import('@/lib/jobs/job-storage');
  const { killJobProcessGroup } = await import('@/lib/jobs/test-timeout-reaper');
  const { readLog } = await import('@/lib/jobs/verdict');
  const { accumulateRunTokens } = await import('@/lib/jobs/run-token-usage');
  const { appendRedactedFileSync } = await import('@/lib/jobs/redacted-log-writer');

  const running = listJobs().filter(
    (j) => j.finishedAt === null && j.pid > 0 && isRunCapEligibleKind(j.kind),
  );
  const reaped: JobData[] = [];
  for (const job of running) {
    // Only read the log when a token cap is armed — wall-time needs no IO.
    const tokenTotal = cfg.tokenCap > 0 ? accumulateRunTokens(readLog(job, 2_000_000)) : 0;
    const violation = evaluateRunCap(job, nowMs, tokenTotal, cfg);
    if (!violation) continue;
    console.log(
      `[run-cap-reaper] ${job.kind} job ${job.id} (${job.project}) ${violation.reason}; killing group pid=${job.pid}`,
    );
    if (job.logPath) {
      try {
        appendRedactedFileSync(job.logPath, `\n# run killed — ${violation.reason}\n`);
      } catch {}
    }
    killJobProcessGroup(job.pid);
    try {
      await markDone(job, violation.exitCode);
      reaped.push(job);
    } catch (e) {
      console.error(`[run-cap-reaper] markDone failed for ${job.id}:`, e);
    }
  }
  return reaped;
}

import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import type { JobData } from '@/lib/jobs/types';
import { isAgentJobKind } from '@/lib/jobs/kinds';
import { getVerdict } from '@/lib/jobs/verdict';
import {
  getFixCiRetryConfig,
  pipelineExitCodeForStep,
  recentFixCiCount,
  stopProjectDevServerIfIdle,
} from '@/lib/jobs/lifecycle-helpers';

export async function runPostCompletionHooks(
  job: JobData,
  notificationEvent: import('@/lib/shared/notifications').NotificationEvent | null,
  forcedReleaseExitCode: number | null,
): Promise<void> {
  // When a release meta-job itself completes (via probe, abort, or any path
  // that calls markDone directly rather than finalizeReleaseJob), ensure the
  // pipeline lock is released. finalizeReleaseJob already calls releaseLock,
  // but probeJobStatus can call markDone→runCompletionHooks directly, leaving
  // the lock orphaned. releaseLock is idempotent — calling it twice is safe.
  if (job.kind === 'release') {
    try {
      const { releaseLock } = await import('@/lib/pipeline/pipeline-lock');
      await releaseLock(job.project, job.id);
    } catch {}
    await stopProjectDevServerIfIdle(job.project);
  }

  // Send notification if an event was triggered
  if (notificationEvent) {
    try {
      const { notify } = await import('@/lib/shared/notifications');
      const logUrl = job.logPath ? `${process.env.TAMTAM_BASE_URL || 'http://localhost:1337'}/project/${encodeURIComponent(job.project)}/history` : undefined;
      const verdict = job.kind === 'review' ? getVerdict(job) : null;
      await notify({
        event: notificationEvent,
        project: job.project,
        job_id: job.id,
        status: (forcedReleaseExitCode ?? pipelineExitCodeForStep(job)) === 0 ? 'success' : 'failed',
        verdict: verdict ?? undefined,
        log_url: logUrl,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error(`[notifications] failed to send notification for ${notificationEvent}:`, e);
    }
  }

  // Project circuit breaker: after K failed runs inside the window, pause the
  // project's scheduling so it stops burning tokens on doomed work. Self-
  // guarding (no-op unless this job failed, threshold armed, project not
  // already paused) and best-effort — never blocks the rest of the hooks.
  try {
    const { maybeTripCircuitBreaker } = await import('@/lib/pipeline/circuit-breaker');
    await maybeTripCircuitBreaker(job);
  } catch (e) {
    console.error(`[circuit-breaker] hook error for ${job.project}:`, e);
  }

  // fix-ci auto-retry: if the job crashed fast (pm2/claude boot failure) and
  // we haven't exhausted retries, kick off another attempt so the user sees
  // a spinner instead of a red exit -1.
  if (job.kind === 'fix-ci' && job.exitCode !== null && job.exitCode !== 0) {
    const { maxRetries, windowSeconds, fastCrashMs } = getFixCiRetryConfig();
    if (maxRetries <= 0) return; // retries disabled via settings
    const durationMs = (job.finishedAt ?? 0) * 1000 - (job.startedAt ?? 0) * 1000;
    const crashedFast = durationMs > 0 && durationMs < fastCrashMs;
    const attempts = recentFixCiCount(job.project, windowSeconds);
    if (crashedFast && attempts <= maxRetries) {
      console.log(`[fix-ci] retry ${attempts}/${maxRetries} for ${job.project} — previous crashed in ${durationMs}ms`);
      const delayMs = Math.min(500 * attempts, 3000);
      setTimeout(() => {
        retryFixCi(job.project).catch((e) => {
          console.log(`[fix-ci] retry error for ${job.project}:`, e);
        });
      }, delayMs);
    } else if (attempts > maxRetries) {
      console.log(`[fix-ci] retry cap reached for ${job.project} (${attempts}/${maxRetries}) — giving up`);
    }
  }

  // Agent run failures: notify on agent run failures
  if (isAgentJobKind(job.kind) && job.exitCode !== 0) {
    try {
      const { notify } = await import('@/lib/shared/notifications');
      const agentName = job.kind.replace('agent:', '');
      const logUrl = job.logPath ? `${process.env.TAMTAM_BASE_URL || 'http://localhost:1337'}/project/${encodeURIComponent(job.project)}/history` : undefined;
      await notify({
        event: 'agent_run_fail',
        project: job.project,
        agent: agentName,
        job_id: job.id,
        status: 'failed',
        log_url: logUrl,
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error(`[notifications] failed to send agent_run_fail notification:`, e);
    }
  }

  // Release-after-fix-ci: extracted to lib/workflows/triggers/release-after-fix-ci.ts.
  // The legacy hook stays gated on a kill switch so we can flip behavior to
  // the workflow-driven event router without redeploying.
  try {
    const { getSettings } = await import('@/lib/shared/config');
    if (getSettings().legacy_completion_hook_release_after_fix_ci_enabled) {
      const { dispatchReleaseAfterFixCi } = await import('@/lib/workflows/triggers/release-after-fix-ci');
      await dispatchReleaseAfterFixCi(job);
    }
  } catch (e) {
    console.log(`[release-after-fix-ci] error for ${job.project}:`, e);
  }

  // Release-after-run: extracted to lib/workflows/triggers/release-after-run.ts.
  // The legacy hook stays gated on a kill switch so we can flip behavior to
  // the workflow-driven event router (Phase 1 follow-up) without redeploying.
  try {
    const { getSettings } = await import('@/lib/shared/config');
    if (getSettings().legacy_completion_hook_release_after_run_enabled) {
      const { dispatchReleaseAfterRun } = await import('@/lib/workflows/triggers/release-after-run');
      await dispatchReleaseAfterRun(job);
    }
  } catch (e) {
    console.log(`[release-after-run] error for ${job.project}:`, e);
  }

  if (isAgentJobKind(job.kind)) {
    try {
      const { releaseDurableAgentRunSlotForJob } = await import('@/lib/agents/durable-agent-run-slot');
      await releaseDurableAgentRunSlotForJob(job);
    } catch (e) {
      console.error(`[agent-run-slot] release hook error for ${job.project}/${job.id}:`, e);
    }
  }

  // Drain any queued terminal run (user input) FIRST, for every job kind —
  // a release, fix, run, or agent finishing all unblock a waiting user prompt,
  // which outranks queued agents. drainNextTerminalRun no-ops when the project
  // is still blocked or nothing is queued.
  try {
    const { drainNextTerminalRun } = await import('@/lib/terminal/pending-terminal-run');
    await drainNextTerminalRun(job.project);
  } catch (e) {
    console.error(`[pending-terminal-run] drain hook error for ${job.project}:`, e);
  }

  // Drain the pending-agent-run queue AFTER release-after-run so a release
  // pipeline that's about to be triggered has a chance to acquire the project
  // lock first. Without this ordering the drain fires the next queued agent
  // before the release lock is held — both then run concurrently on the same
  // worktree. Once the lock is acquired (synchronously inside startRelease),
  // the agent run route routes the drained entry into the DB-backed
  // queued-agent-runs queue, which is replayed when the pipeline lock
  // releases.
  if (isAgentJobKind(job.kind)) {
    try {
      const { getSettings } = await import('@/lib/shared/config');
      if (getSettings().legacy_completion_hook_agent_drain_enabled !== false) {
        const { drainNextAgentRun } = await import('@/lib/agents/pending-agent-run');
        await drainNextAgentRun(job.project);
      }
    } catch (e) {
      console.error(`[pending-agent-run] drain hook error for ${job.project}:`, e);
    }
  }

  // Log retention: prune old log files for this project now that a new run completed.
  try {
    const { pruneProjectLogs } = await import('@/lib/jobs/retention');
    pruneProjectLogs(job.project);
  } catch (e) {
    console.error(`[retention] pruneProjectLogs failed for ${job.project}:`, e);
  }

  try {
    const { getSettings } = await import('@/lib/shared/config');
    if (getSettings().github_board_sync_enabled) {
      const { queueJobBoardSync } = await import('@/lib/github/project-board');
      await queueJobBoardSync(job, 'finished');
    }
  } catch (e) {
    console.error(`[github-board] failed to sync finished job ${job.id}:`, e);
  }

  // Dev server lifecycle: stop the project's dev server when this agent run
  // was the outermost scope of the work. If `dispatchReleaseAfterRun` (above)
  // triggered a release, that release job is now in the DB and
  // `hasActiveWorkForProject` returns true — we leave the server up and
  // `finalizeReleaseStep` will own the stop. Best-effort.
  if (isAgentJobKind(job.kind)) {
    try {
      const { hasActiveWorkForProject } = await import('@/lib/dev-server/active-work');
      if (!(await hasActiveWorkForProject(job.project))) {
        const rows = await db.select().from(schema.projects).where(eq(schema.projects.name, job.project));
        const row = rows[0];
        if (row?.devServerStartCommand) {
          const { stopDevServer } = await import('@/lib/dev-server/lifecycle');
          await stopDevServer(job.project, {
            stopCommand: row.devServerStopCommand ?? null,
            cwd: row.path,
          });
        }
      }
    } catch (e) {
      console.warn(`[dev-server] agent-end stop failed for ${job.project}:`, e);
    }
  }
}

async function retryFixCi(projectName: string): Promise<void> {
  // Re-invoke the fix-ci API route's logic by calling it HTTP-less. We post
  // to the same endpoint so it stays the single source of truth for the
  // "start a fix-ci" flow (prompt construction, log path, permission mode).
  const port = parseInt(process.env.PORT ?? '', 10) || 1337;
  try {
    await fetch(`http://127.0.0.1:${port}/api/projects/by-project/${encodeURIComponent(projectName)}/fix-ci`, {
      method: 'POST',
    });
  } catch (e) {
    console.log(`[fix-ci] retry fetch failed for ${projectName}:`, e);
  }
}

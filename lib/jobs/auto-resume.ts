// Auto-resume agent/run jobs that died mid-stream.
//
// When a `run` / `agent:*` job exits with a non-zero code AND the Claude
// CLI never emitted a final `{"type":"result"…}` event in its
// stream-json log, the job almost certainly didn't end on its own — the
// most common causes are PM2 restarting the parent server, a V8 fatal
// in a Node worker, or a wall-clock kill from a sibling rebuild. The
// session is still live on the provider side, so a `--resume <sessionId>`
// finishes the work without re-paying the system prompt + skills + docs
// cost.
//
// Triggered from `runCompletionHooksInner` (best-effort, fire-and-forget).
//
// Restart cap is stored in the failed job's `contextMeta.autoResumeChain`
// — incrementing each time we relaunch the same logical work. Cap is
// hardcoded low (2 attempts) so a genuinely broken agent doesn't loop.

import type { JobData } from '@/lib/jobs/job-storage';

export const MAX_AUTO_RESUME_ATTEMPTS = 2;

/** Maximum age (ms since finishedAt) for an auto-resume to make sense.
 *  Beyond this, the provider's session cache has likely been compacted
 *  or evicted and the resumed agent will re-summarize instead of
 *  continuing. Mirrors the MAX_AGE_MS in the /continue route. */
const MAX_AGE_MS = 30 * 60 * 1000;

/** Extract a session_id from a stream-json log when the job row didn't
 *  capture it. Reads only the tail of the file to keep this cheap. */
export function findSessionIdInLog(buf: string): string | null {
  // Scan from the end backwards — most recent session_id wins.
  const m = buf.match(/"session_id":"([0-9a-f-]{32,})"/g);
  if (!m || m.length === 0) return null;
  const last = m[m.length - 1];
  const id = last.match(/"session_id":"([^"]+)"/);
  return id ? id[1] : null;
}

/** True when the log contains a top-level `{"type":"result", …}` event,
 *  which is Claude's "I'm done streaming this turn" marker. */
export function hasFinalResult(buf: string): boolean {
  return /"type"\s*:\s*"result"/.test(buf);
}

function autoResumeCountOf(job: JobData): number {
  if (!job.contextMeta) return 0;
  try {
    const parsed = JSON.parse(job.contextMeta) as { autoResumeChain?: { count?: number } };
    return parsed?.autoResumeChain?.count ?? 0;
  } catch {
    return 0;
  }
}

export function isAutoResumeEligible(job: JobData, _tail: string): boolean {
  if (job.finishedAt === null) return false;
  if (job.exitCode === 0) return false;
  if (!(job.kind === 'run' || job.kind.startsWith('agent:'))) return false;
  if (Date.now() - job.finishedAt * 1000 > MAX_AGE_MS) return false;
  // Any non-zero exit on a run/agent is treated as resumable, including
  // Claude `{"type":"result","is_error":true}` errors. The user can still
  // intervene manually — but the default for "✗ ERROR / ERR / exit -1"
  // is to relaunch with --resume rather than burn the partial session.
  if (autoResumeCountOf(job) >= MAX_AUTO_RESUME_ATTEMPTS) return false;
  return true;
}

/** Reads the tail of a finished job's log and decides whether to auto-
 *  resume. If yes, calls the same in-process spawn the /continue route
 *  uses, then bumps the chain counter on the new job. */
export async function maybeAutoResume(job: JobData): Promise<{ resumed: true; newJobId: string } | { resumed: false; reason: string }> {
  // Cheap exits first.
  if (!(job.kind === 'run' || job.kind.startsWith('agent:'))) {
    return { resumed: false, reason: 'kind not resumable' };
  }
  if (job.exitCode === 0 || job.finishedAt === null) {
    return { resumed: false, reason: 'clean exit / still running' };
  }
  if (autoResumeCountOf(job) >= MAX_AUTO_RESUME_ATTEMPTS) {
    return { resumed: false, reason: 'auto-resume cap reached' };
  }

  // Read tail of log to look for session_id + result event.
  let tail = '';
  try {
    const { existsSync, openSync, fstatSync, readSync, closeSync } = await import('fs');
    if (!job.logPath || !existsSync(/*turbopackIgnore: true*/ job.logPath)) {
      return { resumed: false, reason: 'no log path' };
    }
    const fd = openSync(/*turbopackIgnore: true*/ job.logPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, 8192);
      const start = size - len;
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, start);
      tail = buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return { resumed: false, reason: 'could not read log' };
  }

  if (!isAutoResumeEligible(job, tail)) {
    return { resumed: false, reason: 'not eligible (clean result or stale)' };
  }

  const sessionId = job.sessionId || findSessionIdInLog(tail);
  if (!sessionId) {
    return { resumed: false, reason: 'no session id in row or log' };
  }

  // Spawn the resumed job via the same machinery as /api/jobs/[id]/continue.
  // Import lazily — the auto-resume module must not pull provider/CLI code
  // into modules that just want the helpers above (used by tests, etc.).
  try {
    const { resolveProjectPath } = await import('@/lib/shared/project-data');
    const { resolveCliBin, resolveCliDefaultModel, resolveCliEnv } = await import('@/lib/shared/cli-bin');
    const { getPermissionModeFlag, getSettings, withBasePrompt } = await import('@/lib/shared/config');
    const { checkCliStartGate } = await import('@/lib/usage/resolve-provider');
    const { findBlockingRunningJob } = await import('@/lib/jobs/project-active-job');
    const { createJob, updateJob } = await import('@/lib/jobs/job-storage');
    const { startJobInProcess } = await import('@/lib/jobs/spawn-claude-detached');
    const { getImproveConfig } = await import('@/lib/scheduling/scheduling');
    const { join } = await import('path');
    const { mkdirSync } = await import('fs');

    let projPath = resolveProjectPath(job.project);
    if (!projPath) {
      // Cold projects cache after a fresh server boot — common when this hook
      // fires from `runCompletionHooks` during the boot-time probe sweep. Warm
      // it explicitly and retry once before giving up.
      try {
        const { refreshProjectsCacheSync } = await import('@/lib/shared/enabled-projects');
        await refreshProjectsCacheSync();
        projPath = resolveProjectPath(job.project);
      } catch {}
    }
    if (!projPath) {
      console.warn(`[auto-resume] skipping ${job.id}: project '${job.project}' not in cache`);
      return { resumed: false, reason: 'project path missing' };
    }

    const blocking = await findBlockingRunningJob(job.project);
    if (blocking) {
      return { resumed: false, reason: `another job running for ${job.project} (${blocking.id})` };
    }

    const gate = await checkCliStartGate('auto-resume', { preferred: job.provider ?? null });
    if (!gate.ok) return { resumed: false, reason: `start gate: ${gate.detail}` };
    const provider = gate.provider;

    const settings = getSettings();
    const claudeBin = resolveCliBin(provider, settings);
    const cliEnv = resolveCliEnv(provider, settings);
    const model = job.model || resolveCliDefaultModel(provider, settings);

    const { logDir } = getImproveConfig();
    mkdirSync(logDir, { recursive: true });

    const newJob = createJob(job.project, job.kind, 0, '', undefined, undefined, undefined, undefined, undefined, undefined, job.id);
    newJob.provider = provider;
    newJob.sessionId = sessionId;
    newJob.logPath = join(logDir, `${newJob.id}.log`);
    const newAttempt = autoResumeCountOf(job) + 1;
    newJob.contextMeta = JSON.stringify({
      autoResumeChain: {
        count: newAttempt,
        sourceJobId: job.id,
        originalSessionId: sessionId,
      },
    });

    const prompt = withBasePrompt(
      `Continue your previous work. The previous turn was interrupted before completion. Finish any unfinished changes, then end with the same final summary contract you used before.`,
      { projectPath: projPath, provider },
    );

    const pid = await startJobInProcess(
      newJob.id,
      `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --model ${model} ${getPermissionModeFlag()} --resume ${sessionId}`,
      prompt,
      projPath,
      { env: cliEnv },
    );
    newJob.pid = pid;
    updateJob(newJob);

    console.log(`[auto-resume] resumed ${job.id} as ${newJob.id} (attempt ${newAttempt}/${MAX_AUTO_RESUME_ATTEMPTS}, session=${sessionId})`);
    return { resumed: true, newJobId: newJob.id };
  } catch (err) {
    console.warn(`[auto-resume] failed to relaunch ${job.id}:`, err);
    return { resumed: false, reason: `relaunch error: ${(err as Error).message}` };
  }
}

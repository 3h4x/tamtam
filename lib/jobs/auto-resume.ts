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
import { RUN_WALL_TIME_EXIT_CODE, RUN_TOKEN_CAP_EXIT_CODE } from '@/lib/jobs/run-cap-reaper';

export const MAX_AUTO_RESUME_ATTEMPTS = 2;

/** Exit codes that mean a reaper DELIBERATELY killed the run for exceeding a
 *  resource limit (cumulative token cap or wall-clock cap). These are NOT the
 *  mid-stream deaths auto-resume exists for: `--resume` reloads the SAME session
 *  the reaper just killed for being too big/slow, so the very first resumed turn
 *  re-sends that oversized context and re-trips the same cap. The resume is
 *  therefore doomed — and worse, each doomed attempt is a fresh countable
 *  failure, so a single runaway becomes 1 + MAX_AUTO_RESUME_ATTEMPTS failures,
 *  enough on its own to trip the project circuit breaker (see
 *  lib/pipeline/circuit-breaker.ts). Resource-limit kills must fail once, not
 *  loop. (124 covers both the run wall-time and test-timeout reapers.) */
const RESOURCE_LIMIT_KILL_CODES = new Set<number>([RUN_WALL_TIME_EXIT_CODE, RUN_TOKEN_CAP_EXIT_CODE]);

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

/** Build the body of a --resume prompt.
 *
 *  The CLI's `--resume <sessionId>` flag reloads the prior conversation
 *  from the provider's cache, so the new prompt only needs to nudge the
 *  model to finish. But provider caches are not guaranteed: sessions can
 *  be evicted, compacted, or partially lost. In those cases the model
 *  starts fresh with only this prompt as context.
 *
 *  Include enough to keep the model anchored if context is lost: the
 *  agent kind being resumed, the original task verbatim if recorded, and
 *  an escape hatch (`RESUME_LOST_CONTEXT`) so the model can fail loud
 *  instead of hallucinating work.
 */
export function buildResumePrompt(job: JobData): string {
  const originalTask = (job.userPrompt ?? '').trim();
  const lines = [
    '## Composition',
    `- mode: resumed`,
    `- provider: ${job.provider ?? 'unknown'}`,
    `- source job: ${job.id}`,
    `- session id: ${job.sessionId ?? '(reconstructed from log)'}`,
    `- note: skills, docs, retrieval, and memory are NOT re-injected — they remain in the CLI's --resume session cache`,
    '',
    '---',
    '',
    `You are resuming a previous run of \`${job.kind}\` on project \`${job.project}\`.`,
    `Finish any unfinished changes from the prior turn, then end with the same final summary contract you used before.`,
  ];
  if (originalTask) {
    lines.push('');
    lines.push('Original task (verbatim, in case the prior session is no longer fully loaded):');
    lines.push('');
    lines.push(originalTask);
  }
  lines.push('');
  lines.push(
    'If you cannot recall the prior turn — no recollection of the working tree state, the files touched, or what was in progress — do not invent work. Emit a single line `RESUME_LOST_CONTEXT` and stop; the operator will rerun this agent fresh.',
  );
  return lines.join('\n');
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
  // Resource-limit kills (token cap / wall-clock cap) are NOT resumable: the
  // resumed session reloads the same oversized/slow work and re-trips the cap,
  // turning one runaway into a breaker-tripping streak of failures. Fail once.
  if (job.exitCode !== null && RESOURCE_LIMIT_KILL_CODES.has(job.exitCode)) return false;
  // Any OTHER non-zero exit on a run/agent is treated as resumable, including
  // Claude `{"type":"result","is_error":true}` errors and mid-stream deaths
  // (PM2 restart, V8 fatal, exit -1). The user can still intervene manually —
  // but the default is to relaunch with --resume rather than burn the partial
  // session.
  if (autoResumeCountOf(job) >= MAX_AUTO_RESUME_ATTEMPTS) return false;
  return true;
}

/** Reads the tail of a finished job's log to recover the session_id and
 *  decide whether to auto-resume. If yes, calls the same in-process spawn the /continue route
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
    const { openSync, fstatSync, readSync, closeSync } = await import('fs');
    if (!job.logPath) {
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { resumed: false, reason: 'no log path' };
    }
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
    const { isCliProvider } = await import('@/lib/usage/cli-providers');
    const { findBlockingRunningJob } = await import('@/lib/jobs/project-active-job');
    const { createJob, updateJob } = await import('@/lib/jobs/job-storage');
    const { startJobInProcess } = await import('@/lib/jobs/spawn-claude-detached');
    const { getImproveConfig } = await import('@/lib/scheduling/scheduling');
    const { prepareBrokerRun } = await import('@/lib/browser-broker/prepare-run');
    const { db, schema } = await import('@/lib/db');
    const { eq } = await import('drizzle-orm');
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

    const sourceProvider = isCliProvider(job.provider) ? job.provider : null;
    if (!sourceProvider) {
      return { resumed: false, reason: 'source job has no recorded CLI provider' };
    }
    const gate = await checkCliStartGate('auto-resume', {
      preferred: sourceProvider,
      strictPreferred: true,
    });
    if (!gate.ok) return { resumed: false, reason: `start gate: ${gate.detail}` };
    const provider = gate.provider;
    if (sourceProvider && provider !== sourceProvider) {
      return { resumed: false, reason: `cannot resume ${sourceProvider} session on ${provider}` };
    }

    const settings = getSettings();
    const claudeBin = resolveCliBin(provider, settings);
    const cliEnv = resolveCliEnv(provider, settings);
    const model = job.model || resolveCliDefaultModel(provider, settings);

    const { logDir } = getImproveConfig();
    mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

    const newJob = createJob(job.project, job.kind, 0, '', undefined, undefined, undefined, undefined, undefined, undefined, job.id);
    newJob.provider = provider;
    newJob.sessionId = sessionId;
    newJob.logPath = join(/*turbopackIgnore: true*/ logDir, `${newJob.id}.log`);
    const newAttempt = autoResumeCountOf(job) + 1;
    newJob.contextMeta = JSON.stringify({
      autoResumeChain: {
        count: newAttempt,
        sourceJobId: job.id,
        originalSessionId: sessionId,
      },
    });

    const prompt = withBasePrompt(buildResumePrompt(job), { projectPath: projPath, provider });

    let broker: { env: Record<string, string>; cleanup: () => void } | null = null;
    try {
      const rows = await db.select().from(schema.projects).where(eq(schema.projects.name, job.project)).limit(1);
      const projectRow = rows[0] ?? null;
      broker = await prepareBrokerRun({
        jobId: newJob.id,
        projectOrigins: {
          qaUrl: projectRow?.qaUrl ?? null,
          devServerReadyUrl: projectRow?.devServerReadyUrl ?? null,
          website: projectRow?.website ?? null,
        },
        provider,
      });
    } catch (err) {
      console.warn(`[auto-resume] broker prep failed for ${job.id}; continuing without MCP injection:`, err);
    }

    const pid = await startJobInProcess(
      newJob.id,
      `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --model ${model} ${getPermissionModeFlag()} --resume ${sessionId}`,
      prompt,
      projPath,
      {
        env: broker ? { ...cliEnv, ...broker.env } : cliEnv,
        cleanup: broker?.cleanup,
      },
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

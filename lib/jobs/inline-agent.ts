// In-process replacement for startJob() when the caller already lives inside
// a Vercel Workflow step. Same call shape as `startJob(jobId, command,
// prompt, cwd, options)` for drop-in substitution; semantics differ in two
// ways:
//
//   1. The CLI is spawned via child_process.spawn directly (no PM2). The
//      step body owns the process tree.
//   2. The promise resolves AFTER the CLI exits and markDone() + completion
//      hooks have run. This converts the workflow step into the durable
//      owner of the long-running CLI run, instead of fire-and-forget into
//      PM2.
//
// PID convention: job.pid starts as process.pid while the workflow step is
// preparing the child, then switches to the real subprocess pid as soon as
// spawn succeeds. The initial server pid lets probeJobStatus trust step
// self-finalization during the short pre-spawn window; the real child pid
// lets liveness checks and resource sampling target the job process.

import { writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { splitCommand } from '@/lib/shared/split-command';
import { runSubprocess } from './spawn-cli';
import { measurePrompt, checkPromptSize } from './prompt-size';

function resolveLogDir(): string {
  try {
    return getImproveConfig().logDir;
  } catch {
    return join(/*turbopackIgnore: true*/ homedir(), 'logs');
  }
}

export async function startInProcessAgentJob(
  jobId: string,
  command: string,
  prompt: string,
  cwd: string,
  options?: { env?: Record<string, string> },
): Promise<number> {
  const LOG_DIR = resolveLogDir();
  const { mkdirSync } = await import('fs');
  mkdirSync(/*turbopackIgnore: true*/ LOG_DIR, { recursive: true });

  const promptPath = join(/*turbopackIgnore: true*/ LOG_DIR, `${jobId}.prompt`);
  const logPath = join(/*turbopackIgnore: true*/ LOG_DIR, `${jobId}.log`);

  // app/api/jobs/[jobId]/rerun reads this file to restore the prompt.
  writeFileSync(/*turbopackIgnore: true*/ promptPath, prompt);

  const promptBytes = measurePrompt(prompt);
  const { jobsCache, saveToDb, markDone } = await import('@/lib/jobs/job-storage');
  const { registerJobCancellation, finishJobCancellation } = await import('./cancellation');

  const job = jobsCache.get(jobId);
  if (job) {
    job.promptBytes = promptBytes;
    checkPromptSize(jobId, job.kind, promptBytes);
    // Idempotency: workflow replay re-enters the step body. If the previous
    // attempt already finalized the job, exit early so we don't re-spawn.
    if (job.finishedAt != null) return job.pid;
    // Mark "owned by this process" so probe trusts step self-finalization.
    job.pid = process.pid;
    saveToDb(job);
  }

  const cmdArgv = splitCommand(command);
  if (cmdArgv.length === 0) {
    throw new Error(`startInProcessAgentJob: empty command string for job ${jobId}`);
  }
  const [bin, ...args] = cmdArgv;

  const abortSignal = registerJobCancellation(jobId);
  let result;
  try {
    result = await runSubprocess({
      jobId,
      cmd: bin,
      cmdArgs: args,
      promptPath,
      logPath,
      env: options?.env,
      cwd,
      abortSignal,
      onSpawn: (pid) => {
        if (!job || pid <= 0) return;
        job.pid = pid;
        saveToDb(job);
      },
    });
  } finally {
    finishJobCancellation(jobId);
  }

  // Hand off to markDone — it parses the log for tokens/cost, applies
  // Claude is_error overrides, persists, and fires completion hooks
  // (release-after-run, pipeline chaining where applicable).
  if (job) {
    await markDone(job, result.exitCode);
  }

  return result.pid > 0 ? result.pid : process.pid;
}

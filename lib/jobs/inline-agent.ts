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

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { splitCommand } from '@/lib/shared/split-command';
import { wrapForSandbox } from '@/lib/shared/sandbox-wrap';
import { runSubprocess } from './spawn-cli';
import { assertPromptEstimateAllowed, measurePrompt, checkPromptSize } from './prompt-size';
import type { CliProvider } from '@/lib/usage/cli-providers';
import type { JobData } from '@/lib/jobs/types';

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
  options?: {
    env?: Record<string, string>;
    fallback?: {
      provider: CliProvider;
      command: string;
      env?: Record<string, string>;
    };
    cleanup?: () => void;
  },
): Promise<number> {
  let result: Awaited<ReturnType<typeof runSubprocess>> | null = null;
  let job: JobData | null = null;
  let markDone: ((job: JobData, exitCode: number) => Promise<void>) | null = null;
  let finishJobCancellation: ((jobId: string) => void) | null = null;
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      options?.cleanup?.();
    } catch (err) {
      console.warn(`[inline-agent] cleanup failed for ${jobId}:`, err);
    }
  };
  try {
    const LOG_DIR = resolveLogDir();
    mkdirSync(/*turbopackIgnore: true*/ LOG_DIR, { recursive: true });

    const promptPath = join(/*turbopackIgnore: true*/ LOG_DIR, `${jobId}.prompt`);
    const logPath = join(/*turbopackIgnore: true*/ LOG_DIR, `${jobId}.log`);

    // app/api/jobs/[jobId]/rerun reads this file to restore the prompt.
    writeFileSync(/*turbopackIgnore: true*/ promptPath, prompt);

    const promptBytes = measurePrompt(prompt);
    const { jobsCache, saveToDb, markDone: persistJobDone } = await import('@/lib/jobs/job-storage');
    const cancellation = await import('./cancellation');
    finishJobCancellation = cancellation.finishJobCancellation;
    markDone = persistJobDone;

    job = jobsCache.get(jobId) ?? null;
    if (job) {
      assertPromptEstimateAllowed(prompt, { modelTier: job.model });
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
    const [rawBin, ...rawArgs] = cmdArgv;
    const runDir = join(/*turbopackIgnore: true*/ tmpdir(), 'tamtam-runs', jobId);
    const wrap = wrapForSandbox({ bin: rawBin, args: rawArgs, cwd, runDir });
    const bin = wrap.bin;
    const args = wrap.args;
    const envWithWrap: Record<string, string> = { ...(options?.env ?? {}), ...wrap.env };

    const abortSignal = cancellation.registerJobCancellation(jobId);

    result = await runSubprocess({
      jobId,
      cmd: bin,
      cmdArgs: args,
      promptPath,
      logPath,
      env: envWithWrap,
      cwd,
      abortSignal,
      onSpawn: (pid) => {
        if (!job || pid <= 0) return;
        job.pid = pid;
        saveToDb(job);
      },
    });

    const fallback = options?.fallback;
    if (fallback && result.exitCode !== 0 && isTransientProviderFailure(result.outputTail ?? '')) {
      const fallbackArgv = splitCommand(fallback.command);
      if (fallbackArgv.length > 0) {
        const { appendRedactedFileSync } = await import('@/lib/jobs/redacted-log-writer');
        appendRedactedFileSync(
          /*turbopackIgnore: true*/ logPath,
          `\n[tamtam] transient provider failure detected; retrying once with ${fallback.provider}\n`,
        );
        if (job) {
          job.provider = fallback.provider;
          saveToDb(job);
        }
        const [rawFallbackBin, ...rawFallbackArgs] = fallbackArgv;
        const fbWrap = wrapForSandbox({ bin: rawFallbackBin, args: rawFallbackArgs, cwd, runDir });
        const fbEnv: Record<string, string> = { ...(fallback.env ?? {}), ...fbWrap.env };
        result = await runSubprocess({
          jobId,
          cmd: fbWrap.bin,
          cmdArgs: fbWrap.args,
          promptPath,
          logPath,
          env: fbEnv,
          cwd,
          abortSignal,
          onSpawn: (pid) => {
            if (!job || pid <= 0) return;
            job.pid = pid;
            saveToDb(job);
          },
        });
      }
    }
  } finally {
    finishJobCancellation?.(jobId);
    cleanup();
  }

  // Hand off to markDone — it parses the log for tokens/cost, applies
  // Claude is_error overrides, persists, and fires completion hooks
  // (release-after-run, pipeline chaining where applicable).
  if (job && markDone && result) {
    await markDone(job, result.exitCode);
  }

  if (!result) {
    throw new Error(`startInProcessAgentJob: missing subprocess result for job ${jobId}`);
  }
  return result.pid > 0 ? result.pid : process.pid;
}

function isTransientProviderFailure(output: string): boolean {
  const text = output.toLowerCase();
  return [
    'http 500',
    'http 502',
    'http 503',
    'http 504',
    'status 500',
    'status 502',
    'status 503',
    'status 504',
    '5xx',
    'econnrefused',
    'connection refused',
    'connection reset',
    'etimedout',
    'timeout',
    'timed out',
    'rate limit',
    'rate_limit',
    'rate-limited',
    'quota exceeded',
    'overloaded',
    'temporarily unavailable',
    'service unavailable',
    'aborted_streaming',
    'error_during_execution',
    // Provider CLI crashed mid-stream after emitting assistant output with no
    // stderr — the shim's own terminal classification for a transient backend
    // hiccup (it retries once internally before surfacing this line). A second
    // crash should hop to the fallback provider, not fail the run.
    'after assistant output with no stderr',
  ].some((needle) => text.includes(needle));
}

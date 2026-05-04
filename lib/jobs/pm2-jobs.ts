import { writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { exec } from '@/lib/shared/shell';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { measurePrompt, checkPromptSize } from './prompt-size';
import { jobsCache, saveToDb } from './storage';

function resolveLogDir(): string {
  try {
    return getImproveConfig().logDir;
  } catch {
    return join(homedir(), 'logs');
  }
}

// Locate scripts/job-runner.js relative to the running tamtam process. We
// can't trust `__dirname` here — Next.js's bundler rewrites it to "/ROOT" in
// the production build. The tamtam server is always started by
// `scripts/pm2-start.sh`, which sets cwd to the project root, so cwd is the
// correct anchor at runtime. `TAMTAM_ROOT` overrides for unusual setups.
function resolveRunnerPath(): string {
  const candidates = [
    process.env.TAMTAM_ROOT && join(process.env.TAMTAM_ROOT, 'scripts', 'job-runner.js'),
    join(process.cwd(), 'scripts', 'job-runner.js'),
    resolve(__dirname, '..', 'scripts', 'job-runner.js'), // dev / vitest
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `pm2-jobs: cannot locate scripts/job-runner.js — tried: ${candidates.join(', ')}. ` +
    `Set TAMTAM_ROOT to the project root if running outside the standard layout.`
  );
}

/**
 * Split a shell-like command string into argv.
 *
 * Today's call sites only pass space-separated flags + values plus optional
 * "..." quoting (no $VAR, no | <, no `cmd`), so a tiny tokenizer is enough
 * and avoids pulling in a shell-parsing dep. If a future caller needs full
 * POSIX semantics, switch to `shell-quote`.
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && i + 1 < line.length) { buf += line[++i]; continue; }
      if (ch === quote) { quote = null; continue; }
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
    } else if (ch === ' ' || ch === '\t') {
      if (buf) { out.push(buf); buf = ''; }
    } else if (ch === '\\' && i + 1 < line.length) {
      buf += line[++i];
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export async function startJob(
  jobId: string,
  command: string,
  prompt: string,
  cwd: string,
  options?: { env?: Record<string, string> },
): Promise<number> {
  const LOG_DIR = resolveLogDir();
  const { mkdirSync } = await import('fs');
  mkdirSync(LOG_DIR, { recursive: true });

  const promptPath = join(LOG_DIR, `${jobId}.prompt`);
  const logPath = join(LOG_DIR, `${jobId}.log`);

  // app/api/jobs/[jobId]/rerun/route.ts:46-48 reads this file to restore the
  // original prompt when re-running a job — keep writing it.
  writeFileSync(promptPath, prompt);

  const promptBytes = measurePrompt(prompt);
  const job = jobsCache.get(jobId);
  if (job) {
    job.promptBytes = promptBytes;
    checkPromptSize(jobId, job.kind, promptBytes);
    saveToDb(job);
  }

  const cmdArgv = splitCommand(command);
  if (cmdArgv.length === 0) {
    throw new Error(`startJob: empty command string for job ${jobId}`);
  }

  const result = await exec(
    'pm2',
    [
      'start',
      resolveRunnerPath(),
      '--name',
      jobId,
      '--interpreter',
      'node',
      '--no-autorestart',
      '--output',
      logPath,
      '--error',
      logPath,
      '--merge-logs',
      '--cwd',
      cwd,
      '--',
      jobId,
      logPath,
      promptPath,
      ...cmdArgv,
    ],
    { timeout: 15000, env: options?.env }
  );

  if (result.exitCode !== 0) {
    throw new Error(`pm2 start failed: ${result.stderr}`);
  }

  const pid = await getPm2Pid(jobId);
  return pid ?? 0;
}

export async function getJobStatus(
  jobId: string
): Promise<{ status: 'running' | 'done' | 'unknown'; exitCode: number | null }> {
  const info = await getPm2Info(jobId);
  // PM2 doesn't know about this job — could be a non-PM2 spawn (e.g. custom action).
  // Caller should fall back to process.kill(pid, 0) to verify liveness.
  if (!info) return { status: 'unknown', exitCode: null };

  const pm2Status = info.pm2_env?.status ?? '';
  if (pm2Status === 'online') return { status: 'running', exitCode: null };
  if (pm2Status === 'stopped' || pm2Status === 'errored') {
    return { status: 'done', exitCode: info.pm2_env?.exit_code ?? -1 };
  }
  return { status: 'done', exitCode: -1 };
}

export async function deleteJob(jobId: string): Promise<void> {
  await exec('pm2', ['delete', jobId], { timeout: 10000 });
}

async function getPm2Info(jobId: string): Promise<{ name: string; pid?: number; pm2_env?: { status?: string; exit_code?: number } } | null> {
  try {
    const result = await exec('pm2', ['jlist'], { timeout: 10000 });
    if (result.exitCode !== 0) return null;
    const processes: { name: string }[] = JSON.parse(result.stdout);
    return processes.find((p) => p.name === jobId) ?? null;
  } catch {
    return null;
  }
}

async function getPm2Pid(jobId: string): Promise<number | null> {
  const info = await getPm2Info(jobId);
  return info?.pid ?? null;
}

// Exposed so probe/backfill callers can refresh a stale pid without needing
// to parse pm2 jlist themselves.
export async function getJobPid(jobId: string): Promise<number | null> {
  return getPm2Pid(jobId);
}

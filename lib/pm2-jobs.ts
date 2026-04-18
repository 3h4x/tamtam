import { writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from './shell';
import { getImproveConfig } from './scheduling';

function resolveLogDir(): string {
  try {
    return getImproveConfig().logDir;
  } catch {
    return join(homedir(), 'logs');
  }
}

export async function startJob(
  jobId: string,
  command: string,
  prompt: string,
  cwd: string
): Promise<number> {
  const LOG_DIR = resolveLogDir();
  const { mkdirSync } = await import('fs');
  mkdirSync(LOG_DIR, { recursive: true });

  const promptPath = join(LOG_DIR, `${jobId}.prompt`);
  const scriptPath = join(LOG_DIR, `${jobId}.sh`);
  const logPath = join(LOG_DIR, `${jobId}.log`);

  writeFileSync(promptPath, prompt);

  const scriptContent = [
    '#!/bin/bash',
    `export PATH="${process.env.PATH || ''}"`,
    `export HOME="${homedir()}"`,
    // Echo the exact command + stderr redirect so a silent CLI crash leaves
    // a breadcrumb in the log instead of zero bytes.
    `echo "[tamtam] launching: ${command.replace(/"/g, '\\"')}" >&2`,
    `cat "${promptPath}" | ${command} 2>&1`,
    `__rc=$?`,
    `echo "[tamtam] claude exited with code $__rc" >&2`,
    `exit $__rc`,
  ].join('\n');
  writeFileSync(scriptPath, scriptContent);
  chmodSync(scriptPath, 0o755);

  const result = await exec(
    'pm2',
    [
      'start',
      scriptPath,
      '--name',
      jobId,
      '--no-autorestart',
      '--output',
      logPath,
      '--error',
      logPath,
      '--merge-logs',
      '--cwd',
      cwd,
    ],
    { timeout: 15000 }
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

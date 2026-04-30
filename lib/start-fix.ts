import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, openSync, closeSync } from 'fs';
import { getImproveConfig } from './scheduling';
import { resolveProjectPath } from './project-data';
import { getJob, createJob, readLog, probeJobStatus, updateJob, markDone } from './job-storage';
import { getPermissionModeFlag, getPipelineModel } from './config';
import { acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import { jobsPausedResult } from './job-control';

export type StartFixResult =
  | { ok: true; jobId: string; pid: number }
  | { ok: false; status: number; detail: string; blockingJobId?: string };

export async function startFixFromJob(sourceJobId: string): Promise<StartFixResult> {
  const sourceJob = getJob(sourceJobId);
  if (!sourceJob) return { ok: false, status: 404, detail: `job '${sourceJobId}' not found` };
  if ((await probeJobStatus(sourceJob)) === 'running') {
    return { ok: false, status: 400, detail: 'Job is still running' };
  }

  const projectName = sourceJob.project;
  const { claudeBin, logDir } = getImproveConfig();
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { ok: false, status: 404, detail: 'project not found' };
  const paused = jobsPausedResult('start a fix job');
  if (paused) return paused;

  const resumeSessionId = sourceJob.sessionId ?? null;
  let prompt: string;
  if (resumeSessionId) {
    prompt = 'Please fix ALL the issues identified in your review above. Apply the changes directly to the codebase. After fixing, run the relevant tests or linter locally to confirm the fixes work. Do not commit — just make the code changes.';
  } else {
    let logOutput = readLog(sourceJob);
    if (!logOutput.trim()) return { ok: false, status: 400, detail: 'No output to fix from' };
    if (logOutput.length > 12000) {
      logOutput = '...(truncated)...\n' + logOutput.slice(-12000);
    }
    prompt = `A previous ${sourceJob.kind} job for \`${projectName}\` produced the following output:

\`\`\`
${logOutput}
\`\`\`

Please fix ALL the issues identified above. Apply the changes directly to the codebase.
After fixing, run the relevant tests or linter locally to confirm the fixes work.
Do not commit — just make the code changes.
`;
  }

  mkdirSync(logDir, { recursive: true });

  const job = createJob(projectName, 'fix', 0, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;
  if (resumeSessionId) job.sessionId = resumeSessionId;

  const claudeArgs = [
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--model', getPipelineModel('fix'),
    ...getPermissionModeFlag().split(' '),
  ];
  if (resumeSessionId) claudeArgs.push('--resume', resumeSessionId);

  const logFd = openSync(logPath, 'w');
  const proc = spawn(claudeBin, claudeArgs, {
    cwd: projPath,
    stdio: ['pipe', logFd, logFd],
    env: {
      ...process.env,
      PATH: `${join(homedir(), 'Library', 'pnpm')}:${process.env.PATH ?? ''}`,
      HOME: homedir(),
    },
    detached: true,
  });

  job.pid = proc.pid ?? 0;
  proc.unref();
  updateJob(job);

  // Acquire pipeline lock — skip under parent release lock.
  if (!isLockOwnedByActiveRelease(projectName)) {
    try {
      await acquireLock(projectName, job.id);
    } catch (e) {
      console.log(`[start-fix] failed to acquire pipeline lock for ${projectName}:`, e);
    }
  }

  try {
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  } catch {}

  proc.on('exit', (code) => {
    try { closeSync(logFd); } catch {}
    markDone(job, code ?? -1).catch((e) => {
      console.log(`[start-fix] markDone failed for ${job.id}:`, e);
    });
  });

  return { ok: true, jobId: job.id, pid: job.pid };
}

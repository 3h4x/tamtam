import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'fs';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { getSettings } from '@/lib/shared/config';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getJob, createJob, readParsedLog, probeJobStatus, updateJob, markDone } from '@/lib/jobs/job-storage';
import { getPermissionModeFlag, getPipelineModel } from '@/lib/shared/config';
import { acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import { FIX_OUTPUT_CONTRACT, stripFinalVerdict } from './review-contract';

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
  const { logDir } = getImproveConfig();
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { ok: false, status: 404, detail: 'project not found' };
  const gate = await checkCliStartGate('start a fix job', { parentJobId: sourceJob.id });
  if (!gate.ok) return gate;
  const provider = gate.provider;
  const settings = getSettings();
  const claudeBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);

  const resumeSessionId = sourceJob.sessionId ?? null;

  // Pull the review's findings out of its log so we can feed them to fix
  // verbatim. Trusting --resume alone means the fix prompt is just a
  // boilerplate "fix the issues above", which (a) hides the actual
  // contract from anyone reading the fix log and (b) leans entirely on
  // Claude's session memory — which can drop earlier turns under context
  // pressure or after long delays. Embedding the findings makes the work
  // explicit and reproducible.
  const rawLog = readParsedLog(sourceJob);
  let findingsBlock = stripFinalVerdict(rawLog);
  // Cap to keep the resumed-session token budget sane — same 12 KB cap
  // used by the no-resume path below.
  if (findingsBlock.length > 12000) {
    findingsBlock = '...(truncated)...\n' + findingsBlock.slice(-12000);
  }

  let prompt: string;
  if (resumeSessionId) {
    if (findingsBlock) {
      prompt = `Apply fixes for ALL the findings from your review (reproduced below for clarity — work from this list, not from memory):

---
${findingsBlock}
---

${FIX_OUTPUT_CONTRACT}

Edit the files directly. Do not commit — just make the code changes.`;
    } else {
      prompt = `Please fix ALL the issues identified in your review above. Apply the changes directly to the codebase.

${FIX_OUTPUT_CONTRACT}

Do not commit — just make the code changes.`;
    }
  } else {
    if (!findingsBlock) return { ok: false, status: 400, detail: 'No output to fix from' };
    prompt = `A previous ${sourceJob.kind} job for \`${projectName}\` produced the following output:

\`\`\`
${findingsBlock}
\`\`\`

Please fix ALL the issues identified above. Apply the changes directly to the codebase.
${FIX_OUTPUT_CONTRACT}
Do not commit — just make the code changes.
`;
  }

  mkdirSync(logDir, { recursive: true });

  const job = createJob(projectName, 'fix', 0, '', undefined, undefined, undefined, undefined, undefined, undefined, sourceJob.id);
  job.provider = provider;
  const logPath = join(logDir, `${job.id}.log`);
  const promptPath = join(logDir, `${job.id}.prompt`);
  job.logPath = logPath;
  if (resumeSessionId) job.sessionId = resumeSessionId;
  job.promptBytes = Buffer.byteLength(prompt, 'utf8');
  try {
    writeFileSync(promptPath, prompt);
  } catch (e) {
    console.log(`[start-fix] failed to write prompt sidecar for ${job.id}:`, e);
  }

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
      ...cliEnv,
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

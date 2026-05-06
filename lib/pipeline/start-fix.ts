import { join } from 'path';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { getSettings, getPermissionModeFlag, getPipelineModel } from '@/lib/shared/config';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getJob, createJob, readParsedLog, probeJobStatus, updateJob } from '@/lib/jobs/job-storage';
import { startJob } from '@/lib/jobs/pm2-jobs';
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
  const cliBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);

  const resumeSessionId = sourceJob.sessionId ?? null;
  const rawLog = readParsedLog(sourceJob);
  let findingsBlock = stripFinalVerdict(rawLog);
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

  const job = createJob(projectName, 'fix', 0, '', undefined, undefined, undefined, undefined, undefined, undefined, sourceJob.id);
  job.provider = provider;
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;
  if (resumeSessionId) job.sessionId = resumeSessionId;
  job.promptBytes = Buffer.byteLength(prompt, 'utf8');

  try {
    const pid = await startJob(
      job.id,
      `${cliBin} --print --output-format stream-json --include-partial-messages --verbose --model ${getPipelineModel('fix')} ${getPermissionModeFlag()}${resumeSessionId ? ` --resume ${resumeSessionId}` : ''}`,
      prompt,
      projPath,
      { env: cliEnv }
    );
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 500, detail: `Failed to start fix: ${msg}` };
  }

  updateJob(job);

  if (!isLockOwnedByActiveRelease(projectName)) {
    try {
      await acquireLock(projectName, job.id);
    } catch (e) {
      console.log(`[start-fix] failed to acquire pipeline lock for ${projectName}:`, e);
    }
  }

  return { ok: true, jobId: job.id, pid: job.pid };
}

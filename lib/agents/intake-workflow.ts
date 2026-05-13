import { composeAgentSkills } from '@/lib/agents/compose-skills';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { withBasePrompt, getPermissionModeFlag, getSettings } from '@/lib/shared/config';
import {
  buildMemoryBlock,
  readAgentMemory,
  getAgentMemoryDir,
  getAgentMemoryPath,
  ensureAgentMemoryDir,
} from '@/lib/agents/agent-memory';
import { exec } from '@/lib/shared/shell';
import { normalizeModelInput } from '@/lib/agents/model-aliases';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { isCliProvider } from '@/lib/usage/cli-providers';
import { updateJob } from '@/lib/jobs/job-storage';
import { startJob } from '@/lib/jobs/pm2-jobs';
import { errMsg } from '@/lib/shared/types';

export interface AgentIntakeParams {
  jobId: string;
  agentId: string;
  agentName: string;
  project: string;
  projPath: string;
  skillIds: string[];
  docPaths: string[];
  model: string | null;
  taskPrompt: string;
  triggeredBy: string;
  provider: string;
  logPath: string;
  baseContextMeta: string;
}

interface ComposeResult {
  fullPrompt: string;
  cmd: string;
  cliEnv: Record<string, string>;
  contextMeta: string;
}

export async function runAgentIntakeWorkflow(params: AgentIntakeParams): Promise<void> {
  'use workflow';

  const composed = await composePromptStep(params);
  await startAgentStep(params.jobId, params.projPath, composed);
}

async function composePromptStep(params: AgentIntakeParams): Promise<ComposeResult> {
  'use step';

  const {
    agentId,
    agentName,
    project,
    projPath,
    skillIds,
    docPaths,
    model,
    taskPrompt,
    triggeredBy,
    provider,
    baseContextMeta,
  } = params;

  const composed = composeAgentSkills(projPath, skillIds, docPaths);

  const [headR, statusR] = await Promise.all([
    exec('git', ['-C', projPath, 'rev-parse', 'HEAD'], { timeout: 5000 }),
    exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 }),
  ]);

  const baseCtx = JSON.parse(baseContextMeta) as Record<string, unknown>;
  const contextMeta = JSON.stringify({
    ...baseCtx,
    skills: composed.metaSkills,
    docs: composed.metaDocs,
    agent: { id: agentId, name: agentName, triggeredBy },
    baseline: {
      head: headR.exitCode === 0 ? headR.stdout.trim() : null,
      status: statusR.exitCode === 0 ? statusR.stdout : null,
      dirty: statusR.exitCode === 0 ? statusR.stdout.trim().length > 0 : null,
    },
    workflow: true,
  });

  const reportContract = `## TamTam Run Report

At the end of your run, include a short final section exactly named "TamTam Run Report" with:
- Summary: one sentence describing what happened
- Files changed: comma-separated repo-relative paths, or "none"
- Actionable work: "yes" or "no"
- Schedule recommendation: optional; only suggest a less frequent schedule when this run found no actionable work`;

  const allParts = [...composed.docParts, ...composed.parts];
  const systemPrompt = [...allParts, reportContract].filter(Boolean).join('\n\n---\n\n');
  const corePrompt =
    systemPrompt && taskPrompt
      ? `${systemPrompt}\n\n---\n\n${taskPrompt}`
      : systemPrompt || taskPrompt;

  const memDir = getAgentMemoryDir();
  ensureAgentMemoryDir(memDir, project);
  const memoryPath = getAgentMemoryPath(memDir, project, agentName);
  const currentMemory = readAgentMemory(memDir, project, agentName);
  const memoryBlock = buildMemoryBlock(memoryPath, currentMemory);

  const settings = getSettings();
  const requestedModel = model ? normalizeModelInput(model, 'normal') : null;
  const safeProvider = isCliProvider(provider) ? provider : 'claude';
  const claudeBin = resolveCliBin(safeProvider, settings);
  const cliEnv = resolveCliEnv(safeProvider, settings);
  const modelFlag = requestedModel ? `--model ${requestedModel}` : '';
  const cmd = `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose ${getPermissionModeFlag()} ${modelFlag}`;

  const fullPrompt = withBasePrompt(`${corePrompt}\n\n---\n\n${memoryBlock}`, {
    projectPath: projPath,
    provider: safeProvider,
  });

  return { fullPrompt, cmd, cliEnv, contextMeta };
}

async function startAgentStep(
  jobId: string,
  projPath: string,
  composed: ComposeResult,
): Promise<void> {
  'use step';

  const { fullPrompt, cmd, cliEnv, contextMeta } = composed;

  const { getJob, markDone } = await import('@/lib/jobs/job-storage');
  const job = getJob(jobId);
  if (!job) throw new Error(`[intake-workflow] job ${jobId} not found`);

  job.contextMeta = contextMeta;
  updateJob(job);

  try {
    const pid = await startJob(jobId, cmd, fullPrompt, projPath, { env: cliEnv });
    job.pid = pid;
    updateJob(job);
  } catch (e: unknown) {
    const { appendRedactedFileSync } = await import('@/lib/jobs/redacted-log-writer');
    const logPath = job.logPath ?? '';
    if (logPath) appendRedactedFileSync(/*turbopackIgnore: true*/ logPath, `\n# workflow: failed to start agent: ${errMsg(e)}\n`);
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    await markDone(job, -1);
    throw e;
  }
}

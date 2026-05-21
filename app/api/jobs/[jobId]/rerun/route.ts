import { NextRequest, NextResponse } from 'next/server';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getJob, createJob, updateJob } from '@/lib/jobs/job-storage';
import { startJobInProcess as startJob } from '@/lib/jobs/spawn-claude-detached';
import { getPermissionModeFlag, getSettings } from '@/lib/shared/config';
import { errMsg } from '@/lib/shared/types';
import { resolveCliBin, resolveCliDefaultModel, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { isCliProvider } from '@/lib/usage/cli-providers';
import { findBlockingRunningJob } from '@/lib/jobs/project-active-job';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  const sourceJob = getJob(jobId);
  if (!sourceJob) {
    return NextResponse.json({ detail: `job '${jobId}' not found` }, { status: 404 });
  }

  const projectName = sourceJob.project;
  const jobKind = sourceJob.kind;
  const { logDir } = getImproveConfig();
  const settings = getSettings();

  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: `project '${projectName}' not found` }, { status: 404 });
  }

  const blockingJob = await findBlockingRunningJob(projectName);
  if (blockingJob) {
    return NextResponse.json({
      detail: `Job '${blockingJob.kind}' is already running for ${projectName} (job ${blockingJob.id})`,
      blocking_job_id: blockingJob.id,
    }, { status: 409 });
  }

  // For review and fix-ci, delegate to those endpoints
  if (jobKind === 'review') {
    const url = new URL(`/api/projects/by-project/${projectName}/review`, request.url);
    const headers = new Headers(request.headers);
    if (typeof sourceJob.provider === 'string' && isCliProvider(sourceJob.provider)) {
      headers.set('x-tamtam-provider-preferred', sourceJob.provider);
    }
    return fetch(url, { method: 'POST', headers });
  }
  if (jobKind === 'fix-ci') {
    const url = new URL(`/api/projects/by-project/${projectName}/fix-ci`, request.url);
    const headers = new Headers(request.headers);
    if (typeof sourceJob.provider === 'string' && isCliProvider(sourceJob.provider)) {
      headers.set('x-tamtam-provider-preferred', sourceJob.provider);
    }
    return fetch(url, { method: 'POST', headers });
  }

  const gate = await checkCliStartGate('rerun a job', { preferred: sourceJob.provider ?? null });
  if (!gate.ok) return NextResponse.json({ detail: gate.detail }, { status: gate.status });
  const provider = gate.provider;
  const claudeBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);
  const defaultModel = resolveCliDefaultModel(provider, settings);

  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });

  // Read original prompt if available
  const promptPath = join(/*turbopackIgnore: true*/ logDir, `${sourceJob.id}.prompt`);
  const prompt = existsSync(/*turbopackIgnore: true*/ promptPath)
    ? readFileSync(/*turbopackIgnore: true*/ promptPath, 'utf-8')
    : `Rerun of ${sourceJob.kind} for ${projectName}`;

  const job = createJob(projectName, jobKind, 0, '');
  job.provider = provider;
  const logPath = join(/*turbopackIgnore: true*/ logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    const pid = await startJob(
      job.id,
      `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --model ${defaultModel} ${getPermissionModeFlag()}`,
      prompt,
      projPath,
      { env: cliEnv }
    );
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    return NextResponse.json({ detail: `Failed to start rerun: ${errMsg(e)}` }, { status: 500 });
  }

  updateJob(job);

  return NextResponse.json({ status: 'started', job_id: job.id, pid: job.pid });
}

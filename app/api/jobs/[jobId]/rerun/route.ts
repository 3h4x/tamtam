import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getImproveConfig } from '@/lib/scheduling';
import { resolveProjectPath } from '@/lib/project-data';
import { getJob, createJob, updateJob } from '@/lib/job-storage';
import { startJob } from '@/lib/pm2-jobs';
import { getPermissionModeFlag, getSettings } from '@/lib/config';
import { errMsg } from '@/lib/types';

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
  const { claudeBin, logDir } = getImproveConfig();
  const { default_model } = getSettings();

  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: `project '${projectName}' not found` }, { status: 404 });
  }

  // For review and fix-ci, delegate to those endpoints
  if (jobKind === 'review') {
    const url = new URL(`/api/projects/by-project/${projectName}/review`, request.url);
    return fetch(url, { method: 'POST', headers: request.headers });
  }
  if (jobKind === 'fix-ci') {
    const url = new URL(`/api/projects/by-project/${projectName}/fix-ci`, request.url);
    return fetch(url, { method: 'POST', headers: request.headers });
  }

  const { mkdirSync } = await import('fs');
  mkdirSync(logDir, { recursive: true });

  // Read original prompt if available
  const promptPath = join(logDir, `${sourceJob.id}.prompt`);
  const prompt = existsSync(promptPath)
    ? readFileSync(promptPath, 'utf-8')
    : `Rerun of ${sourceJob.kind} for ${projectName}`;

  const job = createJob(projectName, jobKind, 0, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    const pid = await startJob(
      job.id,
      `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --model ${default_model} ${getPermissionModeFlag()}`,
      prompt,
      projPath
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

import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { checkAuth } from '@/lib/auth';
import { getImproveConfig } from '@/lib/scheduling';
import { resolveProjectPath } from '@/lib/project-data';
import { createJob, listJobs, probeJobStatus, updateJob, type JobData } from '@/lib/job-storage';
import { startJob } from '@/lib/pm2-jobs';
import { exec } from '@/lib/shell';
import { CODE_REVIEWER_SKILL } from '@/lib/skills';
import { errMsg } from '@/lib/types';
import { withBasePrompt, getPermissionModeFlag } from '@/lib/config';

function loadReviewPrompt(): string {
  let content = '';
  if (existsSync(CODE_REVIEWER_SKILL)) {
    content = readFileSync(CODE_REVIEWER_SKILL, 'utf-8');
    if (content.startsWith('---')) {
      const end = content.indexOf('---', 3);
      if (end > 0) content = content.slice(end + 3).trimStart();
    }
  }
  return content +
    '\n\n---\n\n' +
    'Project: {project}\n' +
    'Path: {path}\n\n' +
    'There are uncommitted changes in this repository. Use git and any other tools ' +
    'you need to inspect the changes yourself (git status, git diff, read files, ' +
    'etc.), then review them.\n\n' +
    'End with a verdict: LGTM / NEEDS ATTENTION / DO NOT SHIP\n\n' +
    'If LGTM, just confirm the changes look good.';
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;
  const { projectName } = await params;

  const jobs = listJobs();
  const running = jobs.filter(
    (j) => j.project === projectName && j.kind === 'review' && j.finishedAt === null
  );
  for (const j of running) {
    if ((await probeJobStatus(j)) === 'running') {
      return NextResponse.json(
        { detail: `Review already in progress for ${projectName} (PID ${j.pid})` },
        { status: 409 }
      );
    }
  }

  const { projects, claudeBin, logDir } = getImproveConfig();
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: `project '${projectName}' not found` }, { status: 404 });
  }

  const statusR = await exec('git', ['-C', projPath, 'status', '--porcelain', '--ignore-submodules'], { timeout: 5000 });
  if (!statusR.stdout.trim()) {
    return NextResponse.json({ detail: 'No uncommitted changes to review' }, { status: 400 });
  }

  const prompt = withBasePrompt(
    loadReviewPrompt()
      .replace('{project}', projectName)
      .replace('{path}', projPath)
  );

  const job = createJob(projectName, 'review', 0, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    const pid = await startJob(
      job.id,
      `${claudeBin} --print --output-format stream-json --verbose --include-partial-messages ${getPermissionModeFlag()}`,
      prompt,
      projPath
    );
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    return NextResponse.json({ detail: `Failed to start review: ${errMsg(e)}` }, { status: 500 });
  }

  updateJob(job);

  return NextResponse.json({
    status: 'started',
    job_id: job.id,
    pid: job.pid,
    log_path: logPath,
  });
}

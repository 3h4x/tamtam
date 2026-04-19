import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getImproveConfig } from './scheduling';
import { resolveProjectPath } from './project-data';
import { createJob, listJobs, probeJobStatus, updateJob } from './job-storage';
import { startJob } from './pm2-jobs';
import { exec } from './shell';
import { CODE_REVIEWER_SKILL } from './skills';
import { withBasePrompt, getPermissionModeFlag, getSettings } from './config';

export type StartReviewResult =
  | { ok: true; jobId: string; pid: number; logPath: string }
  | { ok: false; status: number; detail: string };

function loadReviewPrompt(): string {
  let content = '';
  if (existsSync(CODE_REVIEWER_SKILL)) {
    content = readFileSync(CODE_REVIEWER_SKILL, 'utf-8');
    if (content.startsWith('---')) {
      const end = content.indexOf('---', 3);
      if (end > 0) content = content.slice(end + 3).trimStart();
    }
  }
  const { review_verdict_rules } = getSettings();
  return content +
    '\n\n---\n\n' +
    'Project: {project}\n' +
    'Path: {path}\n\n' +
    'There are uncommitted changes in this repository. Use git and any other tools ' +
    'you need to inspect the changes yourself (git status, git diff, read files, ' +
    'etc.), then review them.\n\n' +
    'End with a verdict: LGTM / NEEDS ATTENTION / DO NOT SHIP\n\n' +
    review_verdict_rules;
}

/** Start a code review for the given project. Returns the new job id or a structured error. */
export async function startProjectReview(projectName: string): Promise<StartReviewResult> {
  const jobs = listJobs();
  const running = jobs.filter(
    (j) => j.project === projectName && j.kind === 'review' && j.finishedAt === null
  );
  for (const j of running) {
    if ((await probeJobStatus(j)) === 'running') {
      return { ok: false, status: 409, detail: `Review already in progress for ${projectName} (PID ${j.pid})` };
    }
  }

  const { claudeBin, logDir } = getImproveConfig();
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return { ok: false, status: 404, detail: `project '${projectName}' not found` };
  }

  const statusR = await exec('git', ['-C', projPath, 'status', '--porcelain', '--ignore-submodules'], { timeout: 5000 });
  if (!statusR.stdout.trim()) {
    return { ok: false, status: 400, detail: 'No uncommitted changes to review' };
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
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 500, detail: `Failed to start review: ${msg}` };
  }

  updateJob(job);
  return { ok: true, jobId: job.id, pid: job.pid, logPath };
}

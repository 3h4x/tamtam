import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getImproveConfig, getProjectTestConfig } from './scheduling';
import { resolveProjectPath } from './project-data';
import { createJob, listJobs, probeJobStatus, updateJob } from './job-storage';
import { startJob } from './pm2-jobs';
import { exec } from './shell';
import { CODE_REVIEWER_SKILL } from './skills';
import { withBasePrompt, getPermissionModeFlag, getSettings, getPipelineModel } from './config';
import { getLock, acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import { jobsPausedResult } from './job-control';

export type StartReviewResult =
  | { ok: true; jobId: string; pid: number; logPath: string }
  | { ok: false; status: number; detail: string; blockingJobId?: string };

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
    'You MUST end your response with a line in this exact format, on its own line, ' +
    'as the final non-empty line of your output:\n\n' +
    '    Verdict: LGTM\n\n' +
    'or:\n\n' +
    '    Verdict: NEEDS ATTENTION\n\n' +
    '    Verdict: DO NOT SHIP\n\n' +
    'No other text may follow the verdict line. If you omit it, the release ' +
    'pipeline will treat the review as NEEDS ATTENTION and run a fix loop.\n\n' +
    review_verdict_rules;
}

/** Start a code review for the given project. Returns the new job id or a structured error. */
export async function startProjectReview(projectName: string): Promise<StartReviewResult> {
  // Per-project off-switch — used when the agent prompt already performs review.
  try {
    if (getProjectTestConfig(projectName)?.reviewDisabled) {
      return { ok: false, status: 400, detail: `Review is disabled for ${projectName}` };
    }
  } catch { /* ignore — test env without DB */ }

  const { claudeBin, logDir } = getImproveConfig();
  const reviewModel = getPipelineModel('review');
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return { ok: false, status: 404, detail: `project '${projectName}' not found` };
  }
  const paused = jobsPausedResult('start a review');
  if (paused) return paused;

  // Check for existing pipeline lock — but allow running under a parent
  // release job's lock (this step was kicked off by the release pipeline).
  const underRelease = isLockOwnedByActiveRelease(projectName);
  if (!underRelease) {
    const lock = getLock(projectName);
    if (lock) {
      return { ok: false, status: 409, detail: `Pipeline is running for ${projectName}`, blockingJobId: lock.lockedByJobId };
    }
  }

  const jobs = listJobs();
  const running = jobs.filter(
    (j) => j.project === projectName && j.kind === 'review' && j.finishedAt === null
  );
  for (const j of running) {
    if ((await probeJobStatus(j)) === 'running') {
      return { ok: false, status: 409, detail: `Review already in progress for ${projectName} (PID ${j.pid})` };
    }
  }

  const statusR = await exec('git', ['-C', projPath, 'status', '--porcelain', '--ignore-submodules'], { timeout: 5000 });
  if (!statusR.stdout.trim()) {
    return { ok: false, status: 400, detail: 'No uncommitted changes to review' };
  }

  const prompt = withBasePrompt(
    loadReviewPrompt()
      .replace('{project}', projectName)
      .replace('{path}', projPath),
    { projectPath: projPath }
  );

  const job = createJob(projectName, 'review', 0, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    const pid = await startJob(
      job.id,
      `${claudeBin} --print --output-format stream-json --verbose --include-partial-messages --model ${reviewModel} ${getPermissionModeFlag()}`,
      prompt,
      projPath
    );
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 500, detail: `Failed to start review: ${msg}` };
  }

  updateJob(job);

  // Acquire pipeline lock — skip under parent release lock.
  if (!underRelease) {
    try {
      await acquireLock(projectName, job.id);
    } catch (e) {
      console.log(`[start-review] failed to acquire pipeline lock for ${projectName}:`, e);
    }
  }

  return { ok: true, jobId: job.id, pid: job.pid, logPath };
}

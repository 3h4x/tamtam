import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getImproveConfig, getProjectTestConfig } from '@/lib/scheduling/scheduling';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { createJob, listJobs, probeJobStatus, readParsedLog, updateJob } from '@/lib/jobs/job-storage';
import { startJob } from '@/lib/jobs/pm2-jobs';
import { exec } from '@/lib/shared/shell';
import { CODE_REVIEWER_SKILL } from '@/lib/skills/skills';
import { withBasePrompt, getPermissionModeFlag, getSettings, getPipelineModel } from '@/lib/shared/config';
import { getLock, acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import { runGates } from '@/lib/shared/job-control';
import { extractFindingIds, REVIEW_OUTPUT_CONTRACT, stripFinalVerdict } from './review-contract';
import type { JobData } from '@/lib/jobs/types';

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
    '{release_context}\n\n' +
    REVIEW_OUTPUT_CONTRACT + '\n\n' +
    'OUTPUT FORMAT — strict. Your final non-empty line must be exactly one of:\n\n' +
    '    Verdict: LGTM\n' +
    '    Verdict: NEEDS ATTENTION\n' +
    '    Verdict: DO NOT SHIP\n\n' +
    'Rules:\n' +
    '- The verdict line MUST be the very last non-empty line of your response.\n' +
    '- No markdown decoration (no `**`, no `#`, no backticks, no bullet, no quote).\n' +
    '- No trailing punctuation, no rationale on the same line, no extra words.\n' +
    '- Put rationale BEFORE the verdict line, not after.\n\n' +
    'Example ending:\n\n' +
    '    The diff updates two helpers and adds matching tests. Tests pass.\n' +
    '\n    Verdict: LGTM\n\n' +
    'If you omit the verdict line, the release pipeline treats the review as ' +
    'NEEDS ATTENTION and runs a fix loop — wasted spend. Always emit one.\n\n' +
    review_verdict_rules;
}

function releaseContextForReview(projectName: string): string {
  const jobs = listJobs();
  const release = jobs
    .filter((j) => j.project === projectName && j.kind === 'release' && j.finishedAt === null)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
  if (!release) {
    return 'PREVIOUS RELEASE REVIEW/FIX CONTEXT:\nNo active release context. Review the current uncommitted changes from first principles.';
  }

  const prior = jobs
    .filter((j) =>
      j.project === projectName &&
      j.releaseId === release.id &&
      (j.kind === 'review' || j.kind === 'fix') &&
      j.finishedAt !== null
    )
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));

  if (prior.length === 0) {
    return `PREVIOUS RELEASE REVIEW/FIX CONTEXT:\nRelease ${release.id} has no previous review/fix iterations.`;
  }

  const blocks: string[] = [];
  for (const job of prior.slice(-6)) {
    blocks.push(describePriorReviewStep(job));
  }
  return `PREVIOUS RELEASE REVIEW/FIX CONTEXT:
Use this as review memory. First verify whether earlier findings were actually fixed, then search sibling paths before adding new findings.

${blocks.join('\n\n')}`;
}

function describePriorReviewStep(job: JobData): string {
  let log = '';
  try {
    log = stripFinalVerdict(readParsedLog(job)).trim();
  } catch {
    log = '';
  }
  const ids = log ? extractFindingIds(log) : [];
  const excerpt = log.length > 1800 ? `...(truncated)...\n${log.slice(-1800)}` : log;
  return `- ${job.kind} ${job.id} (${job.exitCode === 0 ? 'exit 0' : `exit ${job.exitCode ?? '?'}`}${ids.length ? `, findings ${ids.join(', ')}` : ''})
${excerpt || '(no log excerpt)'}`;
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
  const paused = runGates('start a review');
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
      .replace('{path}', projPath)
      .replace('{release_context}', releaseContextForReview(projectName)),
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

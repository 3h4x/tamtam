import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getImproveConfig } from './scheduling';
import { resolveProjectPath } from './project-data';
import { createJob, listJobs, probeJobStatus, updateJob } from './job-storage';
import { startJob } from './pm2-jobs';
import { exec } from './shell';
import { CODE_REVIEWER_SKILL } from './skills';
import { withBasePrompt, getPermissionModeFlag, getSettings } from './config';
import { wrapUntrusted, withUntrustedPreamble } from './untrusted';
import { jobsPausedResult } from './job-control';

export type StartPrReviewResult =
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
    'Review pull request #{prNumber}: "{prTitle}"\n' +
    'Branch: {headRef} → {baseRef}\n\n' +
    'The diff is below. Review the changes thoroughly.\n\n' +
    '{diff}\n\n' +
    'End with a verdict: LGTM / NEEDS ATTENTION / DO NOT SHIP\n\n' +
    review_verdict_rules;
}

export async function startPrReview(
  projectName: string,
  prNumber: number,
  prTitle: string,
  headRef: string,
  baseRef: string,
): Promise<StartPrReviewResult> {
  const { claudeBin, logDir } = getImproveConfig();
  const { default_model } = getSettings();
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return { ok: false, status: 404, detail: `project '${projectName}' not found` };
  }
  const paused = jobsPausedResult('start a PR review');
  if (paused) return paused;

  const jobs = listJobs();
  const running = jobs.filter(
    (j) => j.project === projectName && j.kind === 'review' && j.finishedAt === null
  );
  for (const j of running) {
    if ((await probeJobStatus(j)) === 'running') {
      return { ok: false, status: 409, detail: `Review already in progress for ${projectName} (PID ${j.pid})` };
    }
  }

  const diffR = await exec('gh', ['pr', 'diff', String(prNumber)], { cwd: projPath, timeout: 30000 });
  if (!diffR.stdout.trim()) {
    return { ok: false, status: 400, detail: `No diff found for PR #${prNumber}` };
  }

  // Wrap external GitHub content so injected instructions can't hijack Claude.
  const substitutions: Record<string, string> = {
    '{project}': projectName,
    '{path}': projPath,
    '{prNumber}': String(prNumber),
    '{prTitle}': wrapUntrusted(prTitle, 'github_pr_title'),
    '{headRef}': wrapUntrusted(headRef, 'github_pr_ref'),
    '{baseRef}': wrapUntrusted(baseRef, 'github_pr_ref'),
    '{diff}': wrapUntrusted(diffR.stdout, 'github_pr_diff'),
  };
  let rendered = loadReviewPrompt();
  for (const [key, value] of Object.entries(substitutions)) {
    rendered = rendered.split(key).join(value);
  }
  const prompt = withUntrustedPreamble(withBasePrompt(rendered, { projectPath: projPath }));

  const job = createJob(projectName, 'review', 0, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    // Review only needs to read code — restrict to safe read-only tools.
    const pid = await startJob(
      job.id,
      `${claudeBin} --print --output-format stream-json --verbose --include-partial-messages --model ${default_model} ${getPermissionModeFlag()} --allowed-tools Read,Grep,Glob`,
      prompt,
      projPath
    );
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 500, detail: `Failed to start PR review: ${msg}` };
  }

  updateJob(job);
  return { ok: true, jobId: job.id, pid: job.pid, logPath };
}

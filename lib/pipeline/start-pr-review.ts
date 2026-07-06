import { readFileSync } from 'fs';
import { join } from 'path';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { resolveCliBin, resolveCliDefaultModel, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { currentParent } from '@/lib/jobs/parent-context';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { createJob, listJobs, probeJobStatus, updateJob } from '@/lib/jobs/job-storage';
import { startJobInProcess } from '@/lib/jobs/spawn-claude-detached';
import { exec } from '@/lib/shared/shell';
import { CODE_REVIEWER_SKILL } from '@/lib/skills/skills';
import { withBasePrompt, getPermissionModeFlag, getSettings } from '@/lib/shared/config';
import { wrapUntrusted, withUntrustedPreamble } from '@/lib/shared/untrusted';
import { detectReviewFrameworks, filterReviewFrameworkSections, formatReviewFrameworksBlock } from './review-frameworks';
import { resolveGhRepo } from '@/lib/github/repo';
import { fetchPrReviewIssueContext } from '@/lib/pipeline/pr-review-issue-context';
import { VERIFIED_CRITERIA_CONTRACT } from '@/lib/pipeline/review-contract';

export type StartPrReviewResult =
  | { ok: true; jobId: string; pid: number; logPath: string }
  | { ok: false; status: number; detail: string };

function loadReviewPrompt(projPath: string, hasCriteria: boolean): string {
  let content = '';
  try {
    content = readFileSync(/*turbopackIgnore: true*/ CODE_REVIEWER_SKILL, 'utf-8');
    if (content.startsWith('---')) {
      const end = content.indexOf('---', 3);
      if (end > 0) content = content.slice(end + 3).trimStart();
    }
  } catch {
    content = '';
  }
  const frameworks = detectReviewFrameworks(projPath);
  content = filterReviewFrameworkSections(content, frameworks);
  const { review_verdict_rules } = getSettings();
  const frameworkBlock = formatReviewFrameworksBlock(frameworks);
  return content +
    '\n\n---\n\n' +
    'Project: {project}\n' +
    'Path: {path}\n\n' +
    'Review pull request #{prNumber}: "{prTitle}"\n' +
    'Branch: {headRef} → {baseRef}\n\n' +
    'The diff is below. Review the changes thoroughly.\n\n' +
    '{diff}\n\n' +
    // Injected only when the PR closes an issue with unchecked acceptance
    // criteria — the review must judge the diff against the issue's DoD, not the
    // diff in isolation. Empty otherwise.
    (hasCriteria ? '{acceptanceCriteria}\n\n' : '') +
    'TAMTAM INTERNAL CONFIG CONTEXT:\n' +
    '- Ignore `.tamtam/` changes during review. They are TamTam scheduler/config metadata, not product code for this project.\n' +
    '- Do not raise findings about `.tamtam/agents/*.md`, `.tamtam/config.yml`, or other `.tamtam/` files unless the review task is explicitly about TamTam configuration.\n\n' +
    frameworkBlock + '\n\n' +
    'End with a verdict: LGTM / NEEDS ATTENTION / DO NOT SHIP\n\n' +
    review_verdict_rules +
    (hasCriteria ? '\n\n' + VERIFIED_CRITERIA_CONTRACT : '');
}

export async function startPrReview(
  projectName: string,
  prNumber: number,
  prTitle: string,
  headRef: string,
  baseRef: string,
): Promise<StartPrReviewResult> {
  const { logDir } = getImproveConfig();
  const settings = getSettings();
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return { ok: false, status: 404, detail: `project '${projectName}' not found` };
  }
  const gate = await checkCliStartGate('start a PR review', { parentJobId: currentParent() });
  if (!gate.ok) return gate;
  const provider = gate.provider;
  const claudeBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);
  const defaultModel = resolveCliDefaultModel(provider, settings);

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

  // Pull the linked issue's acceptance criteria (DoD) so the review judges the
  // PR against the issue's intent, not just the diff. Best-effort: any failure
  // (no repo, no linked issue, no criteria) leaves the review diff-only.
  let acceptanceCriteria = '';
  let issueNumber: number | null = null;
  const repo = await resolveGhRepo(projectName, projPath);
  if (repo) {
    const issueCtx = await fetchPrReviewIssueContext(projPath, repo, prNumber);
    if (issueCtx) {
      issueNumber = issueCtx.issueNumber;
      const criteriaList = issueCtx.criteria.map((c) => `- [ ] ${c}`).join('\n');
      acceptanceCriteria =
        `LINKED ISSUE ACCEPTANCE CRITERIA (issue #${issueCtx.issueNumber}) — the PR must satisfy these; ` +
        `verify each against the diff and the surrounding code, and reflect it in the required ## Verified criteria section:\n` +
        wrapUntrusted(criteriaList, 'github_issue_acceptance_criteria');
    }
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
    '{acceptanceCriteria}': acceptanceCriteria,
  };
  let rendered = loadReviewPrompt(projPath, acceptanceCriteria.length > 0);
  for (const [key, value] of Object.entries(substitutions)) {
    rendered = rendered.split(key).join(value);
  }
  const prompt = withUntrustedPreamble(withBasePrompt(rendered, { projectPath: projPath, provider }));

  const job = createJob(projectName, 'review', 0, '');
  job.provider = provider;
  job.contextMeta = JSON.stringify({
    sourceType: 'pr_review',
    prNumber,
    headRef,
    baseRef,
    ...(issueNumber ? { issueNumber } : {}),
  });
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    // Review only needs to read code — restrict to safe read-only tools.
    const pid = await startJobInProcess(
      job.id,
      `${claudeBin} --print --output-format stream-json --verbose --include-partial-messages --model ${defaultModel} ${getPermissionModeFlag()} --allowed-tools Read,Grep,Glob`,
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
    return { ok: false, status: 500, detail: `Failed to start PR review: ${msg}` };
  }

  updateJob(job);
  return { ok: true, jobId: job.id, pid: job.pid, logPath };
}

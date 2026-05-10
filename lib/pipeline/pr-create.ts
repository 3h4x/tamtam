import { exec } from '@/lib/shared/shell';
import { getJob } from '@/lib/jobs/job-storage';
import type { JobData } from '@/lib/jobs/types';
import { detectMainBranch } from './start-commit';

type ExecLikeResult = Partial<{ stdout: string; stderr: string; exitCode: number }> | null | undefined;

function normalizeExecResult(result: ExecLikeResult) {
  return {
    stdout: typeof result?.stdout === 'string' ? result.stdout : '',
    stderr: typeof result?.stderr === 'string' ? result.stderr : '',
    exitCode: typeof result?.exitCode === 'number' ? result.exitCode : 1,
  };
}

function stubIssuePrBody(issue: { number: number; repo: string }): string {
  return `Closes #${issue.number}\n\nImplemented via TamTam from issue [#${issue.number}](https://github.com/${issue.repo}/issues/${issue.number}).`;
}

// Walk the parent_job_id chain upward from `originJobId` and return the first
// ancestor whose work_summary describes the implementation work this PR is
// landing — typically an `agent:issue-cruncher` run or a terminal `run` linked
// to this issue. Walking the chain is the only correct lookup: matching by
// gh_issue_number alone can return a different agent run with the same number
// from a previous attempt or a different release.
function findOriginRunByParentChain(originJobId: string | null | undefined): JobData | null {
  if (!originJobId) return null;
  const seen = new Set<string>();
  let cursor: string | null = originJobId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const job: JobData | null = getJob(cursor) ?? null;
    if (!job) return null;
    // Eligible origin kinds: the ones that actually carry an implementation
    // work_summary worth surfacing in the PR body. Pipeline meta-jobs
    // (release/test/review/commit/push/fix*/pr*/mark-dod) are skipped — they
    // don't author the work, they orchestrate it.
    if (job.kind === 'agent:issue-cruncher' || (job.kind === 'run' && job.ghIssueNumber != null)) {
      if (job.workSummary && job.workSummary.trim()) return job;
    }
    cursor = job.parentJobId ?? null;
  }
  return null;
}

export function buildIssuePrBody(issue: { number: number; repo: string }, runJob: JobData | null): string {
  const summary = runJob?.workSummary?.trim() ?? '';
  if (!summary) return stubIssuePrBody(issue);
  return [
    `Closes #${issue.number}`,
    summary,
    `---\nImplemented via TamTam from issue [#${issue.number}](https://github.com/${issue.repo}/issues/${issue.number}).`,
  ].join('\n\n');
}

export async function createGenericPR(
  projPath: string,
  log: (s: string) => void,
  signal?: AbortSignal,
): Promise<{ prUrl: string; prRepo: string } | false | null> {
  const branchR = normalizeExecResult(await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000, signal }));
  const currentBranch = branchR.stdout.trim();
  const mainBranch = await detectMainBranch(projPath, signal);

  if (!currentBranch || currentBranch === mainBranch) {
    log(`\n# on default branch — skipping PR creation\n`);
    return false;
  }

  const existingR = normalizeExecResult(await exec('gh', ['pr', 'view', '--json', 'url'], { cwd: projPath, timeout: 10000, signal }));
  if (existingR.exitCode === 0 && existingR.stdout.trim()) {
    try {
      const existing = JSON.parse(existingR.stdout.trim()) as { url?: string };
      if (existing.url) {
        log(`\n# PR already exists: ${existing.url}\n`);
        const repoR = normalizeExecResult(await exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: projPath, timeout: 10000, signal }));
        return { prUrl: existing.url, prRepo: repoR.stdout.trim() };
      }
    } catch {}
  }

  log(`\n# creating PR for branch ${currentBranch}\n`);
  const prR = normalizeExecResult(await exec('gh', ['pr', 'create', '--fill', '--base', mainBranch], { cwd: projPath, timeout: 30000, signal }));
  if (prR.stdout) log(prR.stdout);
  if (prR.stderr) log(prR.stderr);
  if (prR.exitCode !== 0) {
    log(`\n# PR creation failed\n`);
    return null;
  }

  const prUrl = prR.stdout.trim().split('\n').find(l => l.startsWith('https://')) ?? prR.stdout.trim();
  if (!prUrl) return null;

  const repoR = normalizeExecResult(await exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: projPath, timeout: 10000, signal }));
  log(`\n# PR created: ${prUrl}\n`);
  return { prUrl, prRepo: repoR.stdout.trim() };
}

export async function createIssuePR(
  projPath: string,
  log: (s: string) => void,
  issue: { number: number; repo: string; title: string },
  signal?: AbortSignal,
  // `originJobId` is the job that triggered PR creation — typically the push
  // job. We walk its parent_job_id chain upward to find the originating
  // implementation run (agent:issue-cruncher / kind='run' issue) whose
  // work_summary populates the PR body. Walking the chain is the only
  // correct lookup; matching by gh_issue_number alone can pull a workSummary
  // from a different agent run with the same number.
  originJobId?: string | null,
): Promise<string | null> {
  const branchR = normalizeExecResult(await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000, signal }));
  const currentBranch = branchR.stdout.trim();
  const mainBranch = await detectMainBranch(projPath, signal);

  let effectiveBranch = currentBranch;

  if (!currentBranch || currentBranch === mainBranch) {
    const { issueBranchName } = await import('./start-commit');
    const featureBranch = issueBranchName(issue);
    effectiveBranch = featureBranch;

    log(`\n# creating branch ${featureBranch} for issue #${issue.number}\n`);

    const createR = normalizeExecResult(await exec('git', ['-C', projPath, 'branch', featureBranch], { timeout: 5000, signal }));
    if (createR.stdout) log(createR.stdout);
    if (createR.stderr) log(createR.stderr);

    const pushR = normalizeExecResult(await exec(
      'git',
      ['-C', projPath, 'push', '-u', 'origin', featureBranch],
      { timeout: 30000, signal, abortProcessTree: true },
    ));
    if (pushR.stdout) log(pushR.stdout);
    if (pushR.stderr) log(pushR.stderr);
    if (pushR.exitCode !== 0) {
      log(`\n# branch push failed — skipping PR creation\n`);
      return null;
    }
  }

  const existingR = normalizeExecResult(await exec(
    'gh', ['pr', 'list', '--head', effectiveBranch, '--state', 'open', '--json', 'url', '--limit', '1'],
    { cwd: projPath, timeout: 10000, signal },
  ));
  if (existingR.exitCode === 0 && existingR.stdout.trim()) {
    try {
      const arr = JSON.parse(existingR.stdout) as Array<{ url?: string }>;
      if (Array.isArray(arr) && arr[0]?.url) {
        log(`\n# PR already exists: ${arr[0].url}\n`);
        return arr[0].url;
      }
    } catch { /* fall through to create */ }
  }

  const prTitle = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\(.+?\))?:\s/i.test(issue.title)
    ? issue.title
    : `fix: ${issue.title}`;
  const runJob = findOriginRunByParentChain(originJobId);
  const prBody = buildIssuePrBody(issue, runJob);
  log(`\n# creating PR for issue #${issue.number}: "${prTitle}"\n`);

  const prArgs = [
    'pr', 'create',
    '--title', prTitle,
    '--body', prBody,
    '--base', mainBranch,
  ];
  const prR = normalizeExecResult(await exec('gh', prArgs, { cwd: projPath, timeout: 30000, signal }));
  if (prR.stdout) log(prR.stdout);
  if (prR.stderr) log(prR.stderr);

  if (prR.exitCode !== 0) {
    log(`\n# PR creation failed\n`);
    return null;
  }

  const prUrl = prR.stdout.trim().split('\n').find(l => l.startsWith('https://')) ?? prR.stdout.trim();
  log(`\n# PR created: ${prUrl}\n`);
  return prUrl || null;
}

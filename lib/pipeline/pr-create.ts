import { exec } from '@/lib/shared/shell';
import { detectMainBranch } from './start-commit';

export async function createGenericPR(
  projPath: string,
  log: (s: string) => void,
): Promise<{ prUrl: string; prRepo: string } | false | null> {
  const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  const currentBranch = branchR.stdout.trim();
  const mainBranch = await detectMainBranch(projPath);

  if (!currentBranch || currentBranch === mainBranch) {
    log(`\n# PR Workflow: on default branch — skipping PR creation\n`);
    return false;
  }

  const existingR = await exec('gh', ['pr', 'view', '--json', 'url'], { cwd: projPath, timeout: 10000 });
  if (existingR.exitCode === 0 && existingR.stdout.trim()) {
    try {
      const existing = JSON.parse(existingR.stdout.trim()) as { url?: string };
      if (existing.url) {
        log(`\n# PR already exists: ${existing.url}\n`);
        const repoR = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: projPath, timeout: 10000 });
        return { prUrl: existing.url, prRepo: repoR.stdout.trim() };
      }
    } catch {}
  }

  log(`\n# PR Workflow — creating PR for branch ${currentBranch}\n`);
  const prR = await exec('gh', ['pr', 'create', '--fill', '--base', mainBranch], { cwd: projPath, timeout: 30000 });
  if (prR.stdout) log(prR.stdout);
  if (prR.stderr) log(prR.stderr);
  if (prR.exitCode !== 0) {
    log(`\n# PR creation failed\n`);
    return null;
  }

  const prUrl = prR.stdout.trim().split('\n').find(l => l.startsWith('https://')) ?? prR.stdout.trim();
  if (!prUrl) return null;

  const repoR = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: projPath, timeout: 10000 });
  log(`\n# PR created: ${prUrl}\n`);
  return { prUrl, prRepo: repoR.stdout.trim() };
}

export async function createIssuePR(
  projPath: string,
  log: (s: string) => void,
  issue: { number: number; repo: string; title: string },
): Promise<string | null> {
  const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  const currentBranch = branchR.stdout.trim();
  const mainBranch = await detectMainBranch(projPath);

  if (!currentBranch || currentBranch === mainBranch) {
    const { issueBranchName } = await import('./start-commit');
    const featureBranch = issueBranchName(issue);

    log(`\n# creating branch ${featureBranch} for issue #${issue.number}\n`);

    const createR = await exec('git', ['-C', projPath, 'branch', featureBranch], { timeout: 5000 });
    if (createR.stdout) log(createR.stdout);
    if (createR.stderr) log(createR.stderr);

    const pushR = await exec('git', ['-C', projPath, 'push', '-u', 'origin', featureBranch], { timeout: 30000 });
    if (pushR.stdout) log(pushR.stdout);
    if (pushR.stderr) log(pushR.stderr);
    if (pushR.exitCode !== 0) {
      log(`\n# branch push failed — skipping PR creation\n`);
      return null;
    }
  }

  const existingR = await exec(
    'gh', ['pr', 'list', '--head', currentBranch || '', '--state', 'open', '--json', 'url', '--limit', '1'],
    { cwd: projPath, timeout: 10000 },
  );
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
  const prBody = `Closes #${issue.number}\n\nImplemented via TamTam from issue [#${issue.number}](https://github.com/${issue.repo}/issues/${issue.number}).`;
  log(`\n# creating PR for issue #${issue.number}: "${prTitle}"\n`);

  const prArgs = [
    'pr', 'create',
    '--title', prTitle,
    '--body', prBody,
    '--base', mainBranch,
  ];
  const prR = await exec('gh', prArgs, { cwd: projPath, timeout: 30000 });
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

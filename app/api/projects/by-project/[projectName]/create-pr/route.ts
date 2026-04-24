import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/project-data';
import { exec } from '@/lib/shell';
import { detectMainBranch } from '@/lib/start-commit';
import { pushCurrentBranch } from '@/lib/start-push';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: 'Project not found' }, { status: 404 });
  }

  // Refuse to create a PR from the default branch — gh would reject it, but
  // fail fast with a clean error rather than pushing first.
  const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  const currentBranch = branchR.stdout.trim();
  if (!currentBranch) {
    return NextResponse.json({ detail: 'Not on a branch (detached HEAD)' }, { status: 400 });
  }
  const defaultBranch = await detectMainBranch(projPath);
  if (currentBranch === defaultBranch) {
    return NextResponse.json({ detail: `On default branch (${defaultBranch}) — switch to a feature branch first` }, { status: 400 });
  }

  // Push current branch via the shared release-pipeline helper so upstream
  // fallback and error formatting behave consistently with the rest of the app.
  const pushR = await pushCurrentBranch(projPath);
  if (!pushR.ok) {
    return NextResponse.json({ detail: pushR.detail }, { status: 500 });
  }

  // Derive a Conventional-Commits-shaped title. `gh pr create --fill` on a
  // multi-commit branch uses the branch name as the title, producing garbage
  // like "fix/issue 9 track per keyword rank history so you ca". Strategy:
  //   1. Determine the CC type by scanning commits on the branch — pick the
  //      highest-priority type across all branch commits (feat > fix > perf >
  //      refactor > style > docs > test > build > ci > chore).
  //   2. Determine the summary from, in order:
  //      a. The linked GitHub issue title (branch matches fix/issue-<N>-...)
  //         — stripped of any leading CC-type prefix so we don't double-prefix.
  //      b. The most recent commit subject's summary (after its own prefix).
  //   3. Compose `<type>: <summary> (closes #<N>)` (or without the closer
  //      when there's no linked issue).
  //   4. Fall back to gh's `--fill` only if we can't even determine a summary.
  const CC_PRIORITY = ['feat', 'fix', 'perf', 'refactor', 'style', 'docs', 'test', 'build', 'ci', 'chore'];
  const CC_PREFIX_RE = /^(feat|fix|perf|refactor|style|docs|test|build|ci|chore)(?:\([^)]*\))?!?:\s*/i;

  const branchLogR = await exec(
    'git', ['-C', projPath, 'log', `${defaultBranch}..HEAD`, '--pretty=%s'],
    { timeout: 5000 },
  );
  const branchSubjects = branchLogR.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  const branchTypes = branchSubjects
    .map(s => {
      const m = s.match(CC_PREFIX_RE);
      return m ? m[1].toLowerCase() : null;
    })
    .filter((t): t is string => !!t);
  const ccType = CC_PRIORITY.find(t => branchTypes.includes(t)) ?? 'chore';

  const stripCc = (s: string) => s.replace(CC_PREFIX_RE, '').trim();
  const lowerFirst = (s: string) => (s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s);

  const issueMatch = currentBranch.match(/^fix\/issue-(\d+)(?:-|$)/);
  let summary: string | null = null;
  let prBodyExtra = '';
  if (issueMatch) {
    const issueNum = issueMatch[1];
    const issueR = await exec('gh', ['issue', 'view', issueNum, '--json', 'title'], { cwd: projPath, timeout: 10000 });
    if (issueR.exitCode === 0) {
      try {
        const { title } = JSON.parse(issueR.stdout) as { title?: string };
        if (title && title.trim()) {
          summary = lowerFirst(stripCc(title.trim()));
          // GitHub auto-closes linked issues only from the PR body (or commit
          // messages) — NOT from the title. Keep the closer out of the title.
          prBodyExtra = `Closes #${issueNum}\n\n`;
        }
      } catch {}
    }
  }
  if (!summary && branchSubjects.length > 0) {
    summary = lowerFirst(stripCc(branchSubjects[0]));
  }

  const prTitle: string | null = summary ? `${ccType}: ${summary}` : null;

  const createArgs = ['pr', 'create', '--base', defaultBranch];
  if (prTitle) {
    // Body: commit log summary (same as --fill's body) plus the issue closer.
    const bodyLogR = await exec(
      'git', ['-C', projPath, 'log', `${defaultBranch}..HEAD`, '--pretty=- %s'],
      { timeout: 5000 },
    );
    const commitBullets = bodyLogR.stdout.trim() || '(no commits)';
    createArgs.push('--title', prTitle, '--body', `${prBodyExtra}${commitBullets}`);
  } else {
    createArgs.push('--fill');
  }

  const prR = await exec('gh', createArgs, { cwd: projPath, timeout: 60000 });
  if (prR.exitCode !== 0) {
    return NextResponse.json({ detail: prR.stderr || prR.stdout || 'gh pr create failed' }, { status: 500 });
  }

  // Extract PR URL robustly. gh may emit preamble lines containing other pull
  // URLs (e.g. a referenced PR in the commit body) before the real one, so pick
  // the last match rather than the first.
  const urlMatches = prR.stdout.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g);
  const url = urlMatches && urlMatches.length > 0 ? urlMatches[urlMatches.length - 1] : null;
  return NextResponse.json({ url });
}

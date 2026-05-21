import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { detectMainBranch } from '@/lib/pipeline/start-commit';
import { pushCurrentBranch } from '@/lib/pipeline/start-push';

const CC_PRIORITY = ['feat', 'fix', 'perf', 'refactor', 'style', 'docs', 'test', 'build', 'ci', 'chore'];
const CC_PREFIX_RE = /^(feat|fix|perf|refactor|style|docs|test|build|ci|chore)(?:\([^)]*\))?!?:\s*/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: 'Project not found' }, { status: 404 });
  }

  // Optional `{ force: true }` body — the user opted in to skipping the
  // pre-push hook (e.g. when a flaky/broken local test would otherwise block
  // them from filing a PR). Translates to `git push --no-verify`.
  let forcePush = false;
  try {
    const text = await request.text();
    if (text) {
      const body = JSON.parse(text) as { force?: boolean };
      forcePush = !!body.force;
    }
  } catch { /* no body or invalid JSON — default to verifying */ }

  // Refuse to create a PR from the default branch — gh would reject it, but
  // fail fast with a clean error rather than pushing first.
  const [branchR, defaultBranch] = await Promise.all([
    exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 }),
    detectMainBranch(projPath),
  ]);
  const currentBranch = branchR.stdout.trim();
  if (!currentBranch) {
    return NextResponse.json({ detail: 'Not on a branch (detached HEAD)' }, { status: 400 });
  }
  if (currentBranch === defaultBranch) {
    return NextResponse.json({ detail: `On default branch (${defaultBranch}) — switch to a feature branch first` }, { status: 400 });
  }

  // Push current branch via the shared release-pipeline helper so upstream
  // fallback and error formatting behave consistently with the rest of the app.
  const pushR = await pushCurrentBranch(projPath, undefined, { noVerify: forcePush });
  if (!pushR.ok) {
    // When the pre-push hook blocked the push, surface a structured payload so
    // the client can offer the user a "Force-create (skip pre-push hook)"
    // retry. Other failures (auth, network, non-fast-forward) remain plain
    // 500s — those need real intervention.
    if (pushR.hookFailure) {
      return NextResponse.json(
        { detail: pushR.detail, hookFailure: pushR.hookFailure, retryable: true },
        { status: 409 },
      );
    }
    return NextResponse.json({ detail: pushR.detail }, { status: 500 });
  }

  // Derive a Conventional-Commits-shaped title. `gh pr create --fill` on a
  // multi-commit branch uses the branch name as the title, producing garbage
  // like "fix/issue 48 add mood based recommendations something". Strategy:
  //   1. Determine the CC type by scanning commits on the branch — pick the
  //      highest-priority type across all branch commits (feat > fix > perf >
  //      refactor > style > docs > test > build > ci > chore).
  //   2. Determine the summary from, in order:
  //      a. The linked GitHub issue title (branch matches fix/issue-<N>-...)
  //         stripped of any leading CC-type prefix so we don't double-prefix.
  //      b. The most recent commit subject's summary.
  //   3. Compose `<type>: <summary>`.
  //   4. Body: `Closes #<N>\n\n<commit bullets>` when we have issue context,
  //      else just the commit bullets (equivalent to what --fill would use).
  //   5. Fall back to gh's `--fill` only if we can't even determine a summary.
  // GitHub auto-closes linked issues from the PR *body*, not the title —
  // keep the Closes line in the body only.
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
    // Reuse branchSubjects (already fetched above) to build the PR body
    // bullets — they're the same `${defaultBranch}..HEAD` commit set git
    // would have returned a second time with `--pretty=- %s`. One git
    // spawn instead of two.
    const commitBullets = branchSubjects.length > 0
      ? branchSubjects.map(s => `- ${s}`).join('\n')
      : '(no commits)';
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

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { getSettings } from '@/lib/shared/config';
import { db, schema } from '@/lib/db';
import { homedir } from 'os';
import { isUserTrusted } from '@/lib/shared/untrusted';

const CACHE_TTL_S = 300; // 5 minutes

function filterTrustedIssues(issues: unknown[], projectPath: string): unknown[] {
  return issues.filter((issue) => {
    if (!issue || typeof issue !== 'object') return false;
    const author = (issue as { author?: { login?: unknown } }).author;
    if (!author || typeof author.login !== 'string') return false;
    return isUserTrusted(author.login, projectPath);
  });
}

function slimLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((l: unknown) => (l && typeof l === 'object' ? String((l as Record<string, unknown>).name ?? '') : String(l)));
}

function slimAuthor(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const login = (raw as Record<string, unknown>).login;
  return typeof login === 'string' ? login : null;
}

function slimIssue(issue: unknown): unknown {
  if (!issue || typeof issue !== 'object') return issue;
  const o = issue as Record<string, unknown>;
  return { number: o.number, title: o.title, labels: slimLabels(o.labels), author: slimAuthor(o.author), url: o.url };
}

function slimPR(pr: unknown): unknown {
  if (!pr || typeof pr !== 'object') return pr;
  const o = pr as Record<string, unknown>;
  return { number: o.number, title: o.title, labels: slimLabels(o.labels), author: slimAuthor(o.author), url: o.url, branch: o.headRefName, isDraft: o.isDraft };
}

async function getGhRepo(projectName: string, projPath: string): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', projPath, 'remote', 'get-url', 'origin'], { timeout: 5000 });
    if (r.exitCode === 0) {
      let url = r.stdout.trim();
      if (url.startsWith('git@github.com:')) url = url.slice('git@github.com:'.length);
      else if (url.startsWith('https://github.com/')) url = url.slice('https://github.com/'.length);
      url = url.replace(/\.git$/, '');
      if (url && url.includes('/')) return url;
    }
  } catch {}
  const { github_owner: dbGithubOwner } = getSettings();
  const owner = process.env.GITHUB_OWNER || dbGithubOwner || projectName;
  return `${owner}/${projectName}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const forceRefresh = request.nextUrl.searchParams.get('refresh') === '1';
  const trustedOnly = request.nextUrl.searchParams.get('trusted_only') === '1';
  const slim = request.nextUrl.searchParams.get('full') !== '1';
  // `?summary=1` returns just counts and open-PR branch metadata for parent
  // pollers (Project header) that don't render the lists themselves.
  const summary = request.nextUrl.searchParams.get('summary') === '1';

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  // Check cache
  if (!forceRefresh) {
    const cached = (await db
      .select()
      .from(schema.ghIssuesCache)
      .where(eq(schema.ghIssuesCache.project, projectName))
      .limit(1))[0] ?? null;

    if (cached && Date.now() / 1000 - cached.fetchedAt < CACHE_TTL_S) {
      const cachedIssues = JSON.parse(cached.issues);
      const cachedPRs = JSON.parse(cached.prs);
      const filteredIssues = trustedOnly ? filterTrustedIssues(cachedIssues, projPath) : cachedIssues;
      if (summary) {
        return NextResponse.json({
          repo: cached.repo,
          prCount: cachedPRs.length,
          issueCount: filteredIssues.length,
          openPrBranches: cachedPRs.map((pr: unknown) => {
            const p = pr as Record<string, unknown>;
            return { branch: p.headRefName ?? '', number: p.number ?? 0 };
          }),
          error: null,
          cached: true,
          cachedAt: cached.fetchedAt,
        });
      }
      return NextResponse.json({
        repo: cached.repo,
        prs: slim ? cachedPRs.map(slimPR) : cachedPRs,
        issues: slim ? filteredIssues.map(slimIssue) : filteredIssues,
        error: null,
        cached: true,
        cachedAt: cached.fetchedAt,
      });
    }
  }

  const expanded = projPath.startsWith('~') ? projPath.replace('~', homedir()) : projPath;
  const repo = await getGhRepo(projectName, expanded);
  if (!repo) return NextResponse.json({ detail: 'could not determine GitHub repo' }, { status: 422 });

  const prFields = 'number,title,state,author,url,createdAt,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,labels,body,statusCheckRollup';
  const issueFields = 'number,title,state,author,url,createdAt,updatedAt,assignees,labels,body';

  const [prsResult, issuesResult] = await Promise.all([
    exec('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', prFields, '--limit', '50'], { timeout: 15000 }),
    exec('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--json', issueFields, '--limit', '50'], { timeout: 15000 }),
  ]);

  let prs: unknown[] = [];
  let issues: unknown[] = [];

  if (prsResult.exitCode === 0 && prsResult.stdout.trim()) {
    try { prs = JSON.parse(prsResult.stdout); } catch {}
  }

  if (issuesResult.exitCode === 0 && issuesResult.stdout.trim()) {
    try { issues = JSON.parse(issuesResult.stdout); } catch {}
  }

  const ghError = prsResult.exitCode !== 0
    ? prsResult.stderr.trim() || 'gh pr list failed'
    : issuesResult.exitCode !== 0
    ? issuesResult.stderr.trim() || 'gh issue list failed'
    : null;

  const fetchedAt = Date.now() / 1000;

  // Write to cache (only on success)
  if (!ghError) {
    await db.insert(schema.ghIssuesCache)
      .values({ project: projectName, repo, prs: JSON.stringify(prs), issues: JSON.stringify(issues), fetchedAt })
      .onConflictDoUpdate({
        target: schema.ghIssuesCache.project,
        set: { repo, prs: JSON.stringify(prs), issues: JSON.stringify(issues), fetchedAt },
      })
      .execute();
  }

  const filteredIssues = trustedOnly ? filterTrustedIssues(issues, projPath) : issues;
  if (summary) {
    return NextResponse.json({
      repo,
      prCount: prs.length,
      issueCount: filteredIssues.length,
      openPrBranches: prs.map((pr: unknown) => {
        const p = pr as Record<string, unknown>;
        return { branch: p.headRefName ?? '', number: p.number ?? 0 };
      }),
      error: ghError,
      cached: false,
      cachedAt: fetchedAt,
    });
  }
  return NextResponse.json({
    repo,
    prs: slim ? prs.map(slimPR) : prs,
    issues: slim ? filteredIssues.map(slimIssue) : filteredIssues,
    error: ghError,
    cached: false,
    cachedAt: fetchedAt,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json().catch(() => ({}));
  const { prNumber, mergeMethod = 'merge', action = 'merge' } = body as {
    prNumber?: number;
    mergeMethod?: string;
    action?: 'merge' | 'approve';
  };

  if (!prNumber) return NextResponse.json({ detail: 'prNumber required' }, { status: 400 });
  if (!['merge', 'approve'].includes(action)) {
    return NextResponse.json({ detail: 'action must be merge or approve' }, { status: 400 });
  }
  if (action === 'merge' && !['merge', 'squash', 'rebase'].includes(mergeMethod)) {
    return NextResponse.json({ detail: 'mergeMethod must be merge, squash, or rebase' }, { status: 400 });
  }

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const expanded = projPath.startsWith('~') ? projPath.replace('~', homedir()) : projPath;
  const repo = await getGhRepo(projectName, expanded);
  if (!repo) return NextResponse.json({ detail: 'could not determine GitHub repo' }, { status: 422 });

  if (action === 'approve') {
    const result = await exec(
      'gh',
      ['pr', 'review', String(prNumber), '--repo', repo, '--approve'],
      { timeout: 30000 }
    );
    if (result.exitCode !== 0) {
      const errMsg = result.stderr.trim() || 'approve failed';
      return NextResponse.json({ detail: errMsg }, { status: 422 });
    }
    await db.delete(schema.ghIssuesCache)
      .where(eq(schema.ghIssuesCache.project, projectName))
      .execute();
    return NextResponse.json({ status: 'approved', pr: prNumber, repo });
  }

  // merge — try direct merge first. If the repo requires auto-merge
  // enablement AND branch protection hasn't been satisfied yet, gh returns
  // a "Pull request Auto merge is not allowed for this repository" error,
  // which is an actionable signal: approve first, then retry.
  const tryMerge = async (autoFlag: boolean) => {
    const args = ['pr', 'merge', String(prNumber), '--repo', repo, `--${mergeMethod}`];
    if (autoFlag) args.push('--auto');
    return exec('gh', args, { timeout: 30000 });
  };

  let result = await tryMerge(false);
  // Only fall back to --auto when checks are still pending — not when auto-merge
  // is disabled on the repo (that error also contains "auto merge" but means something different).
  if (
    result.exitCode !== 0 &&
    /required status checks|mergeable|pending/i.test(result.stderr) &&
    !/not allowed/i.test(result.stderr)
  ) {
    result = await tryMerge(true);
  }

  if (result.exitCode !== 0) {
    const errMsg = result.stderr.trim() || 'merge failed';
    return NextResponse.json({ detail: errMsg }, { status: 422 });
  }

  // Invalidate cache so next GET fetches fresh data
  await db.delete(schema.ghIssuesCache)
    .where(eq(schema.ghIssuesCache.project, projectName))
    .execute();

  // Post-merge cleanup: return the working tree to the default branch and
  // pull so the next task starts clean. Stash any uncommitted work first so
  // checkout doesn't fail on dirty trees, then restore it afterwards.
  // This is transactional: if checkout fails we return an error so the caller
  // knows the tree is still on the feature branch.
  let switchedBranch: string | null = null;
  let switchError: string | null = null;
  try {
    const symR = await exec('git', ['-C', expanded, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { timeout: 5000 });
    let mainBranch = 'main';
    if (symR.exitCode === 0) {
      const m = symR.stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
      if (m) mainBranch = m[1];
    }
    const curR = await exec('git', ['-C', expanded, 'branch', '--show-current'], { timeout: 5000 });
    if (curR.stdout.trim() === mainBranch) {
      await exec('git', ['-C', expanded, 'pull', '--ff-only', 'origin', mainBranch], { timeout: 30000 });
      switchedBranch = mainBranch;
    } else {
      const statusR = await exec('git', ['-C', expanded, 'status', '--porcelain'], { timeout: 5000 });
      const dirty = statusR.stdout.trim().length > 0;
      let stashed = false;
      if (dirty) {
        const stashR = await exec('git', ['-C', expanded, 'stash', 'push', '-u', '-m', `tamtam: pre-merge-switch ${Date.now()}`], { timeout: 10000 });
        stashed = stashR.exitCode === 0 && !/No local changes/i.test(stashR.stdout);
      }
      const coR = await exec('git', ['-C', expanded, 'checkout', mainBranch], { timeout: 10000 });
      if (coR.exitCode !== 0) {
        if (stashed) await exec('git', ['-C', expanded, 'stash', 'pop'], { timeout: 10000 });
        switchError = `Failed to switch to ${mainBranch} after merge: ${coR.stderr.trim() || coR.stdout.trim() || 'checkout failed'}`;
      } else {
        await exec('git', ['-C', expanded, 'pull', '--ff-only', 'origin', mainBranch], { timeout: 30000 });
        if (stashed) await exec('git', ['-C', expanded, 'stash', 'pop'], { timeout: 10000 });
        switchedBranch = mainBranch;
      }
    }
  } catch (e) {
    switchError = `Post-merge checkout error: ${e instanceof Error ? e.message : String(e)}`;
  }

  clearProjectDataCache();

  if (switchError) {
    return NextResponse.json({ status: 'merged_dirty', pr: prNumber, repo, switchedTo: null, switchError }, { status: 207 });
  }

  return NextResponse.json({ status: 'merged', pr: prNumber, repo, switchedTo: switchedBranch });
}

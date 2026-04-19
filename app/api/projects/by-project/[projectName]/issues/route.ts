import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { resolveProjectPath } from '@/lib/project-data';
import { exec } from '@/lib/shell';
import { db, schema } from '@/lib/db';
import { homedir } from 'os';

const CACHE_TTL_S = 300; // 5 minutes

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
  const owner = process.env.GITHUB_OWNER || projectName;
  return `${owner}/${projectName}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const forceRefresh = request.nextUrl.searchParams.get('refresh') === '1';

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  // Check cache
  if (!forceRefresh) {
    const cached = db
      .select()
      .from(schema.ghIssuesCache)
      .where(eq(schema.ghIssuesCache.project, projectName))
      .get();

    if (cached && Date.now() / 1000 - cached.fetchedAt < CACHE_TTL_S) {
      return NextResponse.json({
        repo: cached.repo,
        prs: JSON.parse(cached.prs),
        issues: JSON.parse(cached.issues),
        error: null,
        cached: true,
        cachedAt: cached.fetchedAt,
      });
    }
  }

  const expanded = projPath.startsWith('~') ? projPath.replace('~', homedir()) : projPath;
  const repo = await getGhRepo(projectName, expanded);
  if (!repo) return NextResponse.json({ detail: 'could not determine GitHub repo' }, { status: 422 });

  const prFields = 'number,title,state,author,url,createdAt,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,labels,body';
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
    db.insert(schema.ghIssuesCache)
      .values({ project: projectName, repo, prs: JSON.stringify(prs), issues: JSON.stringify(issues), fetchedAt })
      .onConflictDoUpdate({
        target: schema.ghIssuesCache.project,
        set: { repo, prs: JSON.stringify(prs), issues: JSON.stringify(issues), fetchedAt },
      })
      .run();
  }

  return NextResponse.json({ repo, prs, issues, error: ghError, cached: false, cachedAt: fetchedAt });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json().catch(() => ({}));
  const { prNumber, mergeMethod = 'merge' } = body as { prNumber?: number; mergeMethod?: string };

  if (!prNumber) return NextResponse.json({ detail: 'prNumber required' }, { status: 400 });
  if (!['merge', 'squash', 'rebase'].includes(mergeMethod)) {
    return NextResponse.json({ detail: 'mergeMethod must be merge, squash, or rebase' }, { status: 400 });
  }

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const expanded = projPath.startsWith('~') ? projPath.replace('~', homedir()) : projPath;
  const repo = await getGhRepo(projectName, expanded);
  if (!repo) return NextResponse.json({ detail: 'could not determine GitHub repo' }, { status: 422 });

  const result = await exec(
    'gh',
    ['pr', 'merge', String(prNumber), '--repo', repo, `--${mergeMethod}`, '--auto'],
    { timeout: 30000 }
  );

  if (result.exitCode !== 0) {
    const errMsg = result.stderr.trim() || 'merge failed';
    return NextResponse.json({ detail: errMsg }, { status: 422 });
  }

  // Invalidate cache so next GET fetches fresh data
  db.delete(schema.ghIssuesCache)
    .where(eq(schema.ghIssuesCache.project, projectName))
    .run();

  return NextResponse.json({ status: 'merged', pr: prNumber, repo });
}
